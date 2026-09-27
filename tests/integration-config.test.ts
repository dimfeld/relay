import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/lib/server/db";
import { getEventRoute, getIntegration } from "../src/lib/server/db/repositories/integrations";
import {
  loadIntegrationDefinitions,
  syncIntegrationCatalog,
} from "../src/lib/server/integrations/config";
import { resolveRoute } from "../src/lib/server/routing/resolve";

let directory: string;
let db: Database;
let configPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "relay-integrations-"));
  configPath = join(directory, "integrations.json");
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function writeConfig(value: unknown) {
  writeFileSync(configPath, JSON.stringify(value));
}

const mail = { id: "mail", name: "Mail", kind: "mail", baseUrl: "https://mail.test/relay" };
const omniapp = { id: "omniapp", name: "OmniApp", kind: "omniapp", baseUrl: "https://omni.test" };

describe("integration configuration file", () => {
  test("returns null when no file is configured", () => {
    expect(loadIntegrationDefinitions(undefined)).toBeNull();
  });

  test("syncs integrations and routes, and disables the ones removed from the file", () => {
    writeConfig({
      integrations: [mail, omniapp],
      routes: [
        { id: "todos", actionType: "task.create", integrationId: "mail" },
        { id: "packages", eventType: "package.detected", integrationId: "omniapp" },
      ],
    });
    syncIntegrationCatalog(db, loadIntegrationDefinitions(configPath)!);

    expect(resolveRoute(db, { actionType: "task.create" })?.integration).toMatchObject({
      id: "mail",
      kind: "mail",
      baseUrl: "https://mail.test/relay",
    });
    expect(resolveRoute(db, { eventType: "package.detected" })?.route.id).toBe("packages");

    writeConfig({
      integrations: [{ ...mail, baseUrl: "https://mail.test/v2" }],
      routes: [{ id: "todos", actionType: "task.create", integrationId: "mail" }],
    });
    syncIntegrationCatalog(db, loadIntegrationDefinitions(configPath)!);

    expect(getIntegration(db, "mail")?.baseUrl).toBe("https://mail.test/v2");
    expect(getIntegration(db, "omniapp")?.enabled).toBe(false);
    expect(getEventRoute(db, "packages")?.enabled).toBe(false);
    expect(resolveRoute(db, { eventType: "package.detected" })).toBeNull();
  });

  test("rejects a route that names an unknown integration or matches nothing", () => {
    writeConfig({
      integrations: [mail],
      routes: [
        { id: "todos", actionType: "task.create", integrationId: "missing" },
        { id: "empty", integrationId: "mail" },
      ],
    });
    expect(() => loadIntegrationDefinitions(configPath)).toThrow(
      /routes\.1: a route must set eventType, actionType, or both/
    );

    writeConfig({
      integrations: [mail],
      routes: [{ id: "todos", actionType: "task.create", integrationId: "missing" }],
    });
    expect(() => loadIntegrationDefinitions(configPath)).toThrow(
      'routes: route "todos" names unknown integration "missing"'
    );
  });

  test("rejects an unknown integration kind and duplicate IDs", () => {
    writeConfig({ integrations: [{ ...mail, kind: "fax" }], routes: [] });
    expect(() => loadIntegrationDefinitions(configPath)).toThrow(/integrations\.0\.kind/);

    writeConfig({ integrations: [mail, { ...omniapp, id: "mail" }], routes: [] });
    expect(() => loadIntegrationDefinitions(configPath)).toThrow(
      'integrations: ID "mail" is used more than once'
    );
  });
});
