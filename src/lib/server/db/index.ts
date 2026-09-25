import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { migrations } from "./migrations";

export { migrations } from "./migrations";

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const applied = db
      .query<{ version: number }, [number]>(
        "SELECT version FROM schema_migrations WHERE version = ?"
      )
      .get(migration.version);
    if (applied) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
    })();
  }
}

export function openDatabase(path: string): Database {
  if (path && path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });

  const db = new Database(path || ":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  if (path && path !== ":memory:") db.query("PRAGMA journal_mode = WAL").get();

  try {
    runMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
