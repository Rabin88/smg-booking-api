import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Opens a database and applies the schema.
 *
 * Pass ':memory:' for a throwaway database — that is what the tests use,
 * so each test starts from a clean slate with no files to tidy up.
 */
export function createDb(
  path: string = join(here, "..", "booking.db")
): Database.Database {
  const db = new Database(path);

  // WAL lets readers carry on while a write transaction is open.
  // Availability checks are far more frequent than holds, so readers
  // should never queue behind a writer.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  return db;
}
