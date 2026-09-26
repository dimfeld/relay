import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { handleAdminRead, loadProject, loadProjects } from "../src/lib/server/api/admin";
import { loadConfig } from "../src/lib/server/config";
import { openDatabase } from "../src/lib/server/db";
import { loadProjectDefinitions } from "../src/lib/server/projects/config";
import { resolveProject, syncProjectCatalog } from "../src/lib/server/projects/catalog";

let directory: string;
let database: Database;
let projectDirectory: string;
let projectConfigPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "relay-project-catalog-"));
  projectDirectory = join(directory, "OmniApp");
  mkdirSync(projectDirectory);
  projectConfigPath = join(directory, "projects.json");
  database = openDatabase(":memory:");
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function writeProjectConfig(projectDirectoryValue = projectDirectory): void {
  writeFileSync(
    projectConfigPath,
    JSON.stringify({
      projects: [
        {
          id: "omniapp",
          name: "OmniApp",
          aliases: ["Omni", "Omni App"],
          directory: projectDirectoryValue,
          defaultBranch: "main",
          allowedAgents: ["codex", "claude"],
          instructions: "Keep project changes focused.",
          policy: { allowDeploy: true },
        },
      ],
    })
  );
}

function registerConfiguredProjects(): void {
  const definitions = loadProjectDefinitions(projectConfigPath)!;
  syncProjectCatalog(database, definitions, "codex");
}

describe("project catalog", () => {
  test("resolves names, IDs, and aliases without regard to case", () => {
    writeProjectConfig();
    registerConfiguredProjects();

    expect(resolveProject(database, "Omni")).toMatchObject({ id: "omniapp", name: "OmniApp" });
    expect(resolveProject(database, "oMnI aPp")).toMatchObject({ id: "omniapp" });
    expect(resolveProject(database, "OMNIAPP")).toMatchObject({ id: "omniapp" });
  });

  test("rejects unknown project names and path-like input", () => {
    writeProjectConfig();
    registerConfiguredProjects();

    expect(resolveProject(database, "Other project")).toBeNull();
    expect(resolveProject(database, projectDirectory)).toBeNull();
    expect(resolveProject(database, "../OmniApp")).toBeNull();
    expect(resolveProject(database, "C:\\work\\OmniApp")).toBeNull();
  });

  test("fails clearly when a configured project directory is invalid", () => {
    writeProjectConfig(join(directory, "missing-project"));

    expect(() => loadProjectDefinitions(projectConfigPath)).toThrow(/does not exist/);
    const filePath = join(directory, "not-a-directory");
    writeFileSync(filePath, "file");
    writeProjectConfig(filePath);
    expect(() => loadProjectDefinitions(projectConfigPath)).toThrow(/is not a directory/);

    writeProjectConfig("relative/project");
    expect(() => loadProjectDefinitions(projectConfigPath)).toThrow(/absolute path/);
  });

  test("returns policy and execution settings from the pre-execution resolver", () => {
    writeProjectConfig();
    registerConfiguredProjects();

    expect(resolveProject(database, "Omni")).toEqual({
      id: "omniapp",
      name: "OmniApp",
      aliases: ["Omni", "Omni App"],
      directory: projectDirectory,
      defaultBranch: "main",
      allowedAgents: ["codex", "claude"],
      instructions: "Keep project changes focused.",
      policy: { allowPush: true, allowMerge: false, allowDeploy: true },
      enabled: true,
    });
  });

  test("serves typed catalog entries from the authenticated admin API", async () => {
    writeProjectConfig();
    registerConfiguredProjects();
    const config = loadConfig({
      PUBLIC_PORT: "4310",
      INTERNAL_PORT: "4311",
      DATABASE_PATH: ":memory:",
      PEBBLE_WEBHOOK_SECRETS: "secret",
      INTERNAL_SERVICE_CREDENTIALS: JSON.stringify({
        admin: { token: "admin-token", capabilities: ["admin:read"] },
      }),
      DEFAULT_EXECUTOR: "codex",
      CODEX_EXECUTABLE: "codex",
      CLAUDE_EXECUTABLE: "claude",
    });
    const context = { config, db: database };
    const request = new Request("http://relay.local/api/projects", {
      headers: { authorization: "Bearer admin-token" },
    });
    const response = handleAdminRead(context, request, loadProjects);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [resolveProject(database, "Omni")] });

    const detailRequest = new Request("http://relay.local/api/projects/omniapp", {
      headers: { authorization: "Bearer admin-token" },
    });
    expect(handleAdminRead(context, detailRequest, loadProject("omniapp")).status).toBe(200);
  });
});
