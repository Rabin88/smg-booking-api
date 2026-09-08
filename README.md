# SMG booking API — code sample

A focused implementation of the booking lifecycle and contention handling
for the stage 2 technical task. This accompanies the design document; it is
not a complete system.

## Running it

```bash
npm install
npm test          # 18 tests
npm start         # seeds booking.db, then API on http://localhost:3000
```

`npm start` reseeds `booking.db` on every run (via a `prestart` script that
calls `npm run seed`), wiping any existing holds/bookings first. Run
`npm run seed` on its own if you want to reset the data without restarting
the server.

Requires Node 18 or later. SQLite needs no separate install — the database
is a file created on first run.

## What is here

| File | Purpose |
| --- | --- |
| `src/schema.sql` | The data model |
| `src/holds.js` | The booking lifecycle. This is the part worth reading. |
| `src/server.js` | REST routes |
| `src/seed.js` | Sample data |
| `test/holds.test.js` | Lifecycle and contention tests |
| `test/api.test.js` | HTTP-level tests |

## What is not here

Deliberately out of scope, all discussed in the design document:

- Trader-facing search across the estate
- Authentication and role checks (`allowOversell` is a flag, not a permission)
- Campaign management beyond the `campaign_id` column
- Multi-store hold requests in a single call
- The notification job for lapsed holds

## Endpoints

```
GET    /availability?store=S412&format=aisle_barrier&cycle=C5
POST   /holds
DELETE /holds/:id
POST   /campaigns/:id/confirm[?allowOversell=true]
```

`requests.http` has runnable examples for each. Open it in VS Code with the
REST Client extension, or in any JetBrains IDE.

## The three decisions worth reading the code for

### 1. Availability is derived, never stored

There is no `available` column. Every read computes:

```
capacity − confirmed bookings − live holds
```

A stored counter would be faster but could drift out of sync with reality,
and a drifted counter is silently wrong. Deriving it means it cannot be
stale. If reads became slow I would cache on top of the derivation, never
replace it — a cache can be rebuilt, a drifted value cannot be detected.

### 2. Expiry is evaluated at read time

There is no `expired` status. A lapsed hold's row still says `active`
indefinitely; the availability query checks `expires_at > datetime('now')`.

The alternative is a sweeper job that marks expired holds. I rejected that
as the source of truth: if it failed, availability would be silently wrong
for every trader with no signal that anything had broken.

The cost is that nothing happens at the moment of expiry, so there is no
event to trigger a "your hold has lapsed" notification. That needs a
separate job — but one whose failure delays emails rather than corrupting
availability.

A second cost: `status = 'active'` is necessary but not sufficient. Every
query touching live holds must also check the timestamp. Two places do
today; I would move the condition into a view so a third caller cannot
forget it.

`test/holds.test.js` demonstrates this — the hold's status is asserted to
still be `active` after the space has been freed.

### 3. Correctness lives in the database, not the application

An availability check followed by an insert is unsafe:

```
A reads → 1 free
B reads → 1 free
A writes → succeeds
B writes → also succeeds     ← both hold the last unit
```

This cannot be fixed in application code. The API may run on several
instances and they cannot see each other's state. The only thing they share
is the database, so the database has to arbitrate.

`createHold` runs inside `BEGIN IMMEDIATE`, which takes the write lock
before the first read, so the count and the insert cannot be separated by
another writer.

## On SQLite

I designed for Postgres. There, this would be `SELECT ... FOR UPDATE` on the
capacity row: a lock on one store-format slot, leaving every other store
free. At 3,000 stores and 30 traders, contention on any single slot is low,
so traders only wait when they genuinely want the same shelf.

I implemented against SQLite so the sample runs with no setup. SQLite
serialises all writers rather than locking per row, which is the same
correctness guarantee applied more coarsely. Fine at this scale, wrong at
the real one. The application logic is identical; only the isolation
mechanism differs.

**What the contention test proves:** the business rule holds — the second
request for the last unit is rejected and availability never goes negative.

**What it does not prove:** the concurrency guarantee under true
parallelism. `better-sqlite3` is synchronous, so the two requests in that
test run in sequence within one process. A real concurrency test needs
Postgres and multiple client processes. I would want that before trusting
this in production.

## What I would build next

**Partial confirmation at scale.** `confirmCampaign` already returns both a
confirmed count and a rejected list, but it loops over holds one at a time.
At 400 stores that is 400 transactions. I would batch them while keeping
partial success, since one unavailable store must not fail a whole campaign.

**Release-and-reassign as one operation.** Today a manager releases a hold
and the space is briefly free for anyone. If the point of the override is to
give the unit to a specific trader, another trader's availability poll can
take it in between. Those two steps need to happen inside one transaction.

**Reconciliation.** Nothing here compares confirmed bookings against what the
field team actually installed. Tests prove the code is correct and
monitoring proves the system is healthy, but neither catches the case the
brief warns about: the database and the physical shelf disagreeing, and
someone being invoiced for media that never ran.
