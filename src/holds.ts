import type { Database } from 'better-sqlite3';
import type {
  AvailabilityResult,
  ConfirmCampaignParams,
  ConfirmCampaignResult,
  ConfirmOutcome,
  CreateHoldParams,
  CreateHoldResult,
  HoldRow,
  ReleaseHoldParams,
  ReleaseHoldResult,
  SlotKey,
} from './types.js';

/**
 * Booking lifecycle and contention.
 *
 * This is the part of the system I chose to go deep on. Everything here
 * exists to answer one question correctly under concurrency: can this
 * trader have this space?
 */

/**
 * How many units of a slot are already spoken for.
 *
 * Two things count against capacity:
 *   - confirmed bookings, permanently
 *   - holds that are still active AND have not passed their expiry
 *
 * That second condition is the whole read-time expiry decision. A hold
 * whose expires_at has passed stops counting the instant the clock moves,
 * with no job having run and no row having changed.
 */
function taken(db: Database, storeId: string, formatId: string, cycleId: string): number {
  const row = db.prepare(`
    SELECT
      COALESCE((SELECT SUM(quantity) FROM bookings
                WHERE store_id = ? AND format_id = ? AND cycle_id = ?), 0)
    + COALESCE((SELECT SUM(quantity) FROM holds
                WHERE store_id = ? AND format_id = ? AND cycle_id = ?
                  AND status = 'active'
                  AND expires_at > datetime('now')), 0)
      AS total
  `).get(storeId, formatId, cycleId, storeId, formatId, cycleId) as { total: number };

  return row.total;
}

/**
 * Availability is derived, never stored.
 *
 * There is no `available` column anywhere. Keeping one would be faster to
 * read but could drift out of sync with reality, and a drifted counter is
 * silently wrong in exactly the way the brief warns about.
 *
 * The breakdown is returned as well as the total, because a trader seeing
 * "0 available" needs to know whether that is confirmed bookings (gone) or
 * holds (might expire). That changes what they do next.
 */
export function getAvailability(
  db: Database,
  { storeId, formatId, cycleId }: SlotKey,
): AvailabilityResult | null {
  const cap = db.prepare(`
    SELECT unit_count FROM store_format_capacity
    WHERE store_id = ? AND format_id = ?
  `).get(storeId, formatId) as { unit_count: number } | undefined;

  if (!cap) return null;

  const confirmed = (db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS n FROM bookings
    WHERE store_id = ? AND format_id = ? AND cycle_id = ?
  `).get(storeId, formatId, cycleId) as { n: number }).n;

  const held = (db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS n FROM holds
    WHERE store_id = ? AND format_id = ? AND cycle_id = ?
      AND status = 'active' AND expires_at > datetime('now')
  `).get(storeId, formatId, cycleId) as { n: number }).n;

  return {
    storeId,
    formatId,
    cycleId,
    capacity: cap.unit_count,
    confirmed,
    held,
    available: cap.unit_count - confirmed - held,
  };
}

/**
 * Places a hold.
 *
 * This is where two traders can collide. Without protection:
 *
 *   A reads availability -> 1 free
 *   B reads availability -> 1 free
 *   A writes a hold      -> succeeds
 *   B writes a hold      -> also succeeds     <- both hold the last unit
 *
 * The fix cannot live in application code. The API may be running on
 * several instances, and they cannot see each other's state. The only
 * thing they share is the database, so the database has to arbitrate.
 *
 * `.immediate()` takes the write lock before the first read rather than
 * upgrading partway through, so the count and the insert cannot be
 * separated by another writer.
 *
 * In Postgres this would be SELECT ... FOR UPDATE on the capacity row,
 * which locks one store-format slot and leaves every other store free.
 * SQLite serialises all writers, which is the same guarantee applied more
 * coarsely — fine at this scale, wrong at three thousand stores.
 */
export function createHold(db: Database, {
  campaignId, storeId, formatId, cycleId, quantity, traderId, holdDays = 7,
}: CreateHoldParams): CreateHoldResult {
  const tx = db.transaction((): CreateHoldResult => {
    const cap = db.prepare(`
      SELECT unit_count FROM store_format_capacity
      WHERE store_id = ? AND format_id = ?
    `).get(storeId, formatId) as { unit_count: number } | undefined;

    if (!cap) {
      return { ok: false, reason: 'unknown_store_or_format' };
    }

    const available = cap.unit_count - taken(db, storeId, formatId, cycleId);

    if (available < quantity) {
      return { ok: false, reason: 'insufficient_availability', available };
    }

    const result = db.prepare(`
      INSERT INTO holds
        (campaign_id, store_id, format_id, cycle_id, quantity,
         status, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, 'active', datetime('now', ?), ?)
    `).run(
      campaignId, storeId, formatId, cycleId, quantity,
      `+${holdDays} days`, traderId,
    );

    const row = db.prepare('SELECT expires_at FROM holds WHERE id = ?')
      .get(result.lastInsertRowid) as { expires_at: string };

    return { ok: true, holdId: result.lastInsertRowid, expiresAt: row.expires_at };
  });

  return tx.immediate();
}

/**
 * Releases a hold early.
 *
 * Two situations: a trader giving space back because the advertiser passed,
 * or a manager overriding to free space for a bigger deal. Both are the
 * same operation, distinguished by who did it and the reason recorded.
 *
 * The row is not deleted. Someone will ask in three weeks why a campaign
 * lost a particular store, and a deleted row cannot answer that.
 *
 * Only active holds can be released. Confirmed bookings stand, per the brief.
 */
export function releaseHold(db: Database, { holdId, releasedBy, reason }: ReleaseHoldParams): ReleaseHoldResult {
  const result = db.prepare(`
    UPDATE holds
    SET status = 'released', released_by = ?, released_reason = ?
    WHERE id = ? AND status = 'active'
  `).run(releasedBy, reason ?? null, holdId);

  return result.changes === 1
    ? { ok: true }
    : { ok: false, reason: 'not_an_active_hold' };
}

/**
 * Confirms every active hold on a campaign.
 *
 * Two decisions worth noting.
 *
 * First, each hold is confirmed in its own transaction. A 400-store campaign
 * where one store has become unavailable should not fail entirely — the brief
 * says bookings are confirmed for some stores and rejected for others, so
 * partial success is a normal outcome rather than an error.
 *
 * Second, every hold is re-validated. Days may have passed since it was
 * placed. It may have expired, or a manager may have released it. The confirm
 * step cannot assume a hold is still good just because it existed once.
 *
 * `allowOversell` exists because the brief says commercial teams sometimes
 * want to accept the risk of overselling. Making that impossible would just
 * push the workaround into spreadsheets and phone calls. Instead it is
 * allowed, flagged, and reportable.
 */
export function confirmCampaign(
  db: Database,
  { campaignId, confirmedBy, allowOversell = false }: ConfirmCampaignParams,
): ConfirmCampaignResult {
  const holds = db.prepare(`
    SELECT * FROM holds WHERE campaign_id = ? AND status = 'active'
  `).all(campaignId) as HoldRow[];

  const confirmed: Array<Extract<ConfirmOutcome, { ok: true }>> = [];
  const rejected: Array<Extract<ConfirmOutcome, { ok: false }>> = [];

  for (const hold of holds) {
    const outcome = db.transaction((): ConfirmOutcome => {
      // Still live? status = 'active' alone is not enough — the row stays
      // 'active' after expiry, so the clock has to be checked too.
      const live = db.prepare(`
        SELECT 1 FROM holds
        WHERE id = ? AND status = 'active' AND expires_at > datetime('now')
      `).get(hold.id);

      if (!live) {
        return { ok: false, storeId: hold.store_id, reason: 'hold_expired' };
      }

      const cap = db.prepare(`
        SELECT unit_count FROM store_format_capacity
        WHERE store_id = ? AND format_id = ?
      `).get(hold.store_id, hold.format_id) as { unit_count: number };

      // This hold is itself counted in taken(), so subtract it before asking
      // whether the space is really there.
      const otherClaims =
        taken(db, hold.store_id, hold.format_id, hold.cycle_id) - hold.quantity;

      const room = cap.unit_count - otherClaims;
      const oversold = room < hold.quantity;

      if (oversold && !allowOversell) {
        return {
          ok: false,
          storeId: hold.store_id,
          reason: 'insufficient_availability',
          available: Math.max(room, 0),
        };
      }

      db.prepare(`
        INSERT INTO bookings
          (campaign_id, store_id, format_id, cycle_id, quantity,
           confirmed_by, oversold, source_hold_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        hold.campaign_id, hold.store_id, hold.format_id, hold.cycle_id,
        hold.quantity, confirmedBy, oversold ? 1 : 0, hold.id,
      );

      db.prepare(`UPDATE holds SET status = 'confirmed' WHERE id = ?`)
        .run(hold.id);

      return { ok: true, storeId: hold.store_id, oversold };
    }).immediate();

    if (outcome.ok) confirmed.push(outcome);
    else rejected.push(outcome);
  }

  return {
    confirmed: confirmed.length,
    oversold: confirmed.filter((c) => c.oversold).length,
    rejected,
  };
}
