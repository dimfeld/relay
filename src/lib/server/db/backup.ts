import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { log } from "../logging";
import { openDatabase } from "./index";

/** Create a consistent SQLite snapshot at destinationPath. The destination must not exist. */
export function backupDatabase(db: Database, destinationPath: string): string {
  const target = resolve(destinationPath);
  mkdirSync(dirname(target), { recursive: true });
  const quotedTarget = target.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${quotedTarget}'`);
  return target;
}

function defaultBackupPath(databasePath: string, now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return join(
    dirname(resolve(databasePath)),
    "backups",
    `${basename(databasePath)}-${timestamp}.sqlite`
  );
}

if (import.meta.main) {
  const databasePath = process.env.DATABASE_PATH;
  if (!databasePath) throw new Error("DATABASE_PATH must be set to back up the Relay database.");

  const destinationPath = process.argv[2] ?? defaultBackupPath(databasePath);
  const db = openDatabase(databasePath);
  try {
    const backupPath = backupDatabase(db, destinationPath);
    log("info", "database backup created", { path: backupPath });
  } finally {
    db.close();
  }
}
