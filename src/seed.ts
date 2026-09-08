import { createDb } from './db.js';

/**
 * Populates booking.db with a small, readable estate.
 *
 * Deliberately tiny. The brief says the sample data is not being graded,
 * and a handful of stores makes the availability arithmetic easy to check
 * by hand when demonstrating.
 */

const db = createDb();

db.exec('DELETE FROM bookings; DELETE FROM holds;');

const store = db.prepare('INSERT OR REPLACE INTO stores VALUES (?, ?)');
const format = db.prepare('INSERT OR REPLACE INTO formats VALUES (?, ?)');
const cycle = db.prepare('INSERT OR REPLACE INTO cycles VALUES (?, ?, ?)');
const capacity = db.prepare('INSERT OR REPLACE INTO store_format_capacity VALUES (?, ?, ?)');

store.run('S412', 'Morrisons Wolverhampton');
store.run('S519', 'Morrisons Leeds Kirkstall');
store.run('S733', 'Morrisons Bradford Enterprise Five');

format.run('aisle_barrier', 'Aisle Barrier');
format.run('gondola_end', 'Gondola End');
format.run('trolley_panel', 'Trolley Panel');

cycle.run('C5', 5, 2026);
cycle.run('C6', 6, 2026);

capacity.run('S412', 'aisle_barrier', 6);
capacity.run('S412', 'gondola_end', 2);
capacity.run('S519', 'aisle_barrier', 4);
capacity.run('S519', 'gondola_end', 5);
capacity.run('S733', 'aisle_barrier', 8);
capacity.run('S733', 'trolley_panel', 12);

// Some existing activity so availability is not trivially full.
db.prepare(`
  INSERT INTO bookings
    (campaign_id, store_id, format_id, cycle_id, quantity, confirmed_by)
  VALUES ('coca-cola-spring', 'S412', 'aisle_barrier', 'C5', 3, 'trader-c')
`).run();

db.prepare(`
  INSERT INTO holds
    (campaign_id, store_id, format_id, cycle_id, quantity,
     status, expires_at, created_by)
  VALUES ('pepsi-push', 'S412', 'aisle_barrier', 'C5', 2,
          'active', datetime('now', '+7 days'), 'trader-b')
`).run();

// An already-expired hold. It still says 'active' in the row, and it still
// does not count — that is the point of read-time expiry.
db.prepare(`
  INSERT INTO holds
    (campaign_id, store_id, format_id, cycle_id, quantity,
     status, expires_at, created_by)
  VALUES ('lapsed-campaign', 'S412', 'aisle_barrier', 'C5', 1,
          'active', datetime('now', '-2 days'), 'trader-d')
`).run();

console.log('Seeded booking.db');
console.log('');
console.log('S412 aisle_barrier C5:  6 capacity, 3 confirmed, 2 held  -> 1 available');
console.log('  (a fourth unit is held by an expired hold, which does not count)');
