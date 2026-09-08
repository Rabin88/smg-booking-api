import { describe, test, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { createDb } from '../src/db.js';
import {
  getAvailability, createHold, releaseHold, confirmCampaign,
} from '../src/holds.js';

let db: Database;

const slot = { storeId: 'S412', formatId: 'aisle_barrier', cycleId: 'C5' };

beforeEach(() => {
  db = createDb(':memory:');
  db.prepare("INSERT INTO stores VALUES ('S412','Morrisons Wolverhampton')").run();
  db.prepare("INSERT INTO formats VALUES ('aisle_barrier','Aisle Barrier')").run();
  db.prepare("INSERT INTO cycles VALUES ('C5',5,2026)").run();
});

function setCapacity(units: number) {
  db.prepare(
    "INSERT INTO store_format_capacity VALUES ('S412','aisle_barrier',?)",
  ).run(units);
}

function hold(campaignId: string, traderId: string, quantity = 1) {
  return createHold(db, { ...slot, campaignId, traderId, quantity });
}

describe('availability is derived', () => {
  test('an empty slot reports full capacity', () => {
    setCapacity(6);
    expect(getAvailability(db, slot)?.available).toBe(6);
  });

  test('holds and confirmed bookings both reduce availability', () => {
    setCapacity(6);
    hold('kelloggs', 'trader-a', 2);
    confirmCampaign(db, { campaignId: 'kelloggs', confirmedBy: 'trader-a' });
    hold('nestle', 'trader-b', 1);

    const a = getAvailability(db, slot);
    expect(a?.confirmed).toBe(2);
    expect(a?.held).toBe(1);
    expect(a?.available).toBe(3);
  });

  test('an unknown store or format returns null rather than guessing', () => {
    expect(getAvailability(db, slot)).toBeNull();
  });
});

describe('contention', () => {
  // The test that matters. Two traders want the last unit; exactly one
  // gets it. This is the executable version of the whole design argument.
  test('two traders wanting the last unit — only one wins', () => {
    setCapacity(1);

    const a = hold('kelloggs', 'trader-a');
    const b = hold('nestle', 'trader-b');

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok);
    expect(loser && !loser.ok ? loser.reason : undefined).toBe('insufficient_availability');
    expect(getAvailability(db, slot)?.available).toBe(0);
  });

  test('a partly-filled slot rejects a request that is too large', () => {
    setCapacity(6);
    hold('kelloggs', 'trader-a', 5);

    const big = hold('nestle', 'trader-b', 3);
    expect(big.ok).toBe(false);
    expect(!big.ok && big.reason === 'insufficient_availability' ? big.available : undefined).toBe(1);

    // But a request that fits still succeeds.
    expect(hold('pepsi', 'trader-c', 1).ok).toBe(true);
  });
});

describe('expiry is derived from the clock', () => {
  test('an expired hold stops blocking space with no job running', () => {
    setCapacity(1);
    hold('kelloggs', 'trader-a');
    expect(getAvailability(db, slot)?.available).toBe(0);

    // Backdate the expiry. Nothing else runs: no sweeper, no scheduled job,
    // and the row still says 'active'.
    db.prepare("UPDATE holds SET expires_at = datetime('now','-1 day')").run();

    const row = db.prepare('SELECT status FROM holds').get() as { status: string };
    expect(row.status).toBe('active');
    expect(getAvailability(db, slot)?.available).toBe(1);

    expect(hold('nestle', 'trader-b').ok).toBe(true);
  });

  test('an expired hold cannot be confirmed', () => {
    setCapacity(1);
    hold('kelloggs', 'trader-a');
    db.prepare("UPDATE holds SET expires_at = datetime('now','-1 day')").run();

    const result = confirmCampaign(db, {
      campaignId: 'kelloggs', confirmedBy: 'trader-a',
    });

    expect(result.confirmed).toBe(0);
    expect(result.rejected[0]?.reason).toBe('hold_expired');
  });
});

describe('releasing a hold', () => {
  test('frees the space and records who did it and why', () => {
    setCapacity(1);
    const h = hold('kelloggs', 'trader-a');

    const released = releaseHold(db, {
      holdId: h.ok ? Number(h.holdId) : -1,
      releasedBy: 'manager-1',
      reason: 'Nestle deal takes priority',
    });

    expect(released.ok).toBe(true);
    expect(getAvailability(db, slot)?.available).toBe(1);

    // The row is kept, not deleted — someone will ask later why this
    // campaign lost the store.
    const row = db.prepare('SELECT * FROM holds WHERE id = ?').get(h.ok ? h.holdId : -1) as {
      status: string; released_by: string; released_reason: string;
    };
    expect(row.status).toBe('released');
    expect(row.released_by).toBe('manager-1');
    expect(row.released_reason).toBe('Nestle deal takes priority');
  });

  test('a confirmed booking cannot be released', () => {
    setCapacity(1);
    const h = hold('kelloggs', 'trader-a');
    confirmCampaign(db, { campaignId: 'kelloggs', confirmedBy: 'trader-a' });

    const result = releaseHold(db, { holdId: h.ok ? Number(h.holdId) : -1, releasedBy: 'manager-1' });
    expect(result.ok).toBe(false);
    expect(!result.ok ? result.reason : undefined).toBe('not_an_active_hold');
  });
});

describe('confirmation', () => {
  test('partial success — some stores confirm, others are rejected with reasons', () => {
    db.prepare("INSERT INTO stores VALUES ('S519','Morrisons Leeds')").run();
    db.prepare(
      "INSERT INTO store_format_capacity VALUES ('S519','aisle_barrier',4)",
    ).run();
    setCapacity(1);

    createHold(db, { ...slot, campaignId: 'kelloggs', traderId: 'trader-a', quantity: 1 });
    createHold(db, {
      storeId: 'S519', formatId: 'aisle_barrier', cycleId: 'C5',
      campaignId: 'kelloggs', traderId: 'trader-a', quantity: 2,
    });

    // One of the two holds lapses while the advertiser is deciding.
    db.prepare(
      "UPDATE holds SET expires_at = datetime('now','-1 day') WHERE store_id = 'S412'",
    ).run();

    const result = confirmCampaign(db, {
      campaignId: 'kelloggs', confirmedBy: 'trader-a',
    });

    expect(result.confirmed).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.storeId).toBe('S412');
    expect(result.rejected[0]?.reason).toBe('hold_expired');
  });
});

describe('deliberate overselling', () => {
  test('blocked by default, allowed and flagged when explicitly permitted', () => {
    setCapacity(1);

    // Two holds were placed; the first one takes the only unit.
    hold('kelloggs', 'trader-a');
    confirmCampaign(db, { campaignId: 'kelloggs', confirmedBy: 'trader-a' });

    // A second hold placed before the space ran out.
    db.prepare(`
      INSERT INTO holds (campaign_id, store_id, format_id, cycle_id,
                         quantity, status, expires_at, created_by)
      VALUES ('nestle','S412','aisle_barrier','C5',1,'active',
              datetime('now','+7 days'),'trader-b')
    `).run();

    const blocked = confirmCampaign(db, {
      campaignId: 'nestle', confirmedBy: 'trader-b',
    });
    expect(blocked.confirmed).toBe(0);
    expect(blocked.rejected[0]?.reason).toBe('insufficient_availability');

    // A manager accepts the risk. It succeeds, and it is flagged so someone
    // can chase it before the field team turns up.
    const forced = confirmCampaign(db, {
      campaignId: 'nestle', confirmedBy: 'manager-1', allowOversell: true,
    });
    expect(forced.confirmed).toBe(1);
    expect(forced.oversold).toBe(1);

    const booking = db.prepare(
      "SELECT oversold FROM bookings WHERE campaign_id = 'nestle'",
    ).get() as { oversold: number };
    expect(booking.oversold).toBe(1);
  });
});
