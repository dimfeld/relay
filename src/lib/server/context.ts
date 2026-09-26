import type { Database } from "bun:sqlite";
import { loadConfig, type AppConfig } from "./config";
import { openDatabase } from "./db";

export interface ServerContext {
  config: AppConfig;
  db: Database;
}

let context: ServerContext | undefined;

/** Load the configuration and open the database on first use by an internal route. */
export function getServerContext(): ServerContext {
  if (!context) {
    const config = loadConfig();
    context = { config, db: openDatabase(config.DATABASE_PATH) };
  }
  return context;
}
