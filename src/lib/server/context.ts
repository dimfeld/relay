import type { Database } from "bun:sqlite";
import { loadConfig, type AppConfig } from "./config";
import { openDatabase } from "./db";
import { startRetentionPruner } from "./db/retention";
import { loadIntegrationDefinitions, syncIntegrationCatalog } from "./integrations/config";
import { loadProjectDefinitions } from "./projects/config";
import { syncProjectCatalog } from "./projects/catalog";
import { createRoutingService, type RoutingService } from "./routing/service";

/** The configuration and database that request handlers need. */
export interface RequestContext {
  config: AppConfig;
  db: Database;
}

export interface ServerContext extends RequestContext {
  routing: RoutingService;
}

let context: ServerContext | undefined;

/** Sync the configured project and integration files to the database. */
export function syncConfiguredCatalogs(db: Database, config: AppConfig): void {
  const projects = loadProjectDefinitions(config.PROJECTS_CONFIG_PATH);
  if (projects) syncProjectCatalog(db, projects, config.DEFAULT_EXECUTOR);
  const integrations = loadIntegrationDefinitions(config.INTEGRATIONS_CONFIG_PATH);
  if (integrations) syncIntegrationCatalog(db, integrations);
}

/** Load the configuration and open the database on first use by an internal route. */
export function getServerContext(): ServerContext {
  if (!context) {
    const config = loadConfig();
    const db = openDatabase(config.DATABASE_PATH);
    try {
      syncConfiguredCatalogs(db, config);
      context = {
        config,
        db,
        routing: createRoutingService({ db, maxAttempts: config.DELIVERY_MAX_ATTEMPTS }),
      };
      startRetentionPruner(db, {
        retentionDays: config.EVENT_RETENTION_DAYS,
        intervalMs: config.RETENTION_CHECK_INTERVAL_MS,
      });
    } catch (error) {
      db.close();
      throw error;
    }
  }
  return context;
}
