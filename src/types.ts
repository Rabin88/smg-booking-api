export interface SlotKey {
  storeId: string;
  formatId: string;
  cycleId: string;
}

export interface AvailabilityResult extends SlotKey {
  capacity: number;
  confirmed: number;
  held: number;
  available: number;
}

export interface CreateHoldParams extends SlotKey {
  campaignId: string;
  quantity: number;
  traderId: string;
  holdDays?: number;
}

export type CreateHoldResult =
  | { ok: true; holdId: number | bigint; expiresAt: string }
  | { ok: false; reason: 'unknown_store_or_format' }
  | { ok: false; reason: 'insufficient_availability'; available: number };

export interface ReleaseHoldParams {
  holdId: number;
  releasedBy: string;
  reason?: string | null;
}

export type ReleaseHoldResult =
  | { ok: true }
  | { ok: false; reason: 'not_an_active_hold' };

export interface ConfirmCampaignParams {
  campaignId: string;
  confirmedBy: string;
  allowOversell?: boolean;
}

export type ConfirmOutcome =
  | { ok: true; storeId: string; oversold: boolean }
  | { ok: false; storeId: string; reason: 'hold_expired' }
  | { ok: false; storeId: string; reason: 'insufficient_availability'; available: number };

export interface ConfirmCampaignResult {
  confirmed: number;
  oversold: number;
  rejected: Array<Extract<ConfirmOutcome, { ok: false }>>;
}

export type HoldStatus = 'active' | 'confirmed' | 'released';

export interface HoldRow {
  id: number;
  campaign_id: string;
  store_id: string;
  format_id: string;
  cycle_id: string;
  quantity: number;
  status: HoldStatus;
  expires_at: string;
  created_by: string;
  created_at: string;
  released_by: string | null;
  released_reason: string | null;
}
