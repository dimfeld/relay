import type { Database } from "bun:sqlite";
import { loadConfig, type AppConfig } from "./config";
import { openDatabase } from "./db";
import { loadProjectDefinitions } from "./projects/config";
import { syncProjectCatalog } from "./projects/catalog";

export interface ServerContext {
  config: AppConfig;
  db: Database;
}

let context: ServerContext | undefined;

/** Load the configuration and open the database on first use by an internal route. */
export function getServerContext(): ServerContext {
  if (!context) {
    const config = loadConfig();
    const db = openDatabase(config.DATABASE_PATH);
    try {
      const definitions = loadProjectDefinitions(config.PROJECTS_CONFIG_PATH);
      if (definitions) syncProjectCatalog(db, definitions, config.DEFAULT_EXECUTOR);
      context = { config, db };
    } catch (error) {
      db.close();
      throw error;
    }
  }
  return context;
}
