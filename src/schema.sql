-- Reference data. Fixed for the period being modelled, per the brief.

CREATE TABLE IF NOT EXISTS stores (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS formats (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cycles (
  id       TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  year     INTEGER NOT NULL
);

-- How many units of a format a store physically has.
-- Modelled as a count rather than one row per unit: the brief gives no
-- way to tell one aisle barrier from another, so identity buys nothing.
CREATE TABLE IF NOT EXISTS store_format_capacity (
  store_id   TEXT NOT NULL REFERENCES stores(id),
  format_id  TEXT NOT NULL REFERENCES formats(id),
  unit_count INTEGER NOT NULL CHECK (unit_count >= 0),
  PRIMARY KEY (store_id, format_id)
);

-- Provisional reservations.
--
-- Note there is no 'expired' status. A hold's row stays 'active'
-- indefinitely; expiry is derived at read time by comparing expires_at
-- to the clock. Nothing has to run for an expired hold to stop counting.
CREATE TABLE IF NOT EXISTS holds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     TEXT    NOT NULL,
  store_id        TEXT    NOT NULL REFERENCES stores(id),
  format_id       TEXT    NOT NULL REFERENCES formats(id),
  cycle_id        TEXT    NOT NULL REFERENCES cycles(id),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  status          TEXT    NOT NULL CHECK (status IN ('active','confirmed','released')),
  expires_at      TEXT    NOT NULL,
  created_by      TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  released_by     TEXT,
  released_reason TEXT
);

-- Committed bookings. Separate table from holds because the two behave
-- differently in almost every way: holds expire, bookings do not; holds
-- can be released, bookings stand; only bookings feed field install and
-- finance. A downstream consumer can read this table with no filtering
-- and be certain it is seeing real commitments.
CREATE TABLE IF NOT EXISTS bookings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id    TEXT    NOT NULL,
  store_id       TEXT    NOT NULL REFERENCES stores(id),
  format_id      TEXT    NOT NULL REFERENCES formats(id),
  cycle_id       TEXT    NOT NULL REFERENCES cycles(id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  confirmed_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  confirmed_by   TEXT    NOT NULL,
  oversold       INTEGER NOT NULL DEFAULT 0,
  source_hold_id INTEGER REFERENCES holds(id)
);

CREATE INDEX IF NOT EXISTS idx_holds_slot
  ON holds (store_id, format_id, cycle_id, status);

CREATE INDEX IF NOT EXISTS idx_holds_campaign
  ON holds (campaign_id, status);

CREATE INDEX IF NOT EXISTS idx_bookings_slot
  ON bookings (store_id, format_id, cycle_id);
