/**
 * #6957: the Home end of the Remote Link management relay, through the real hub-link listener.
 *
 * The link key admits only allowlisted GET reads under /v1/link-management; every other method,
 * path or refresh query is a 404 before a handler runs, and the prefix does not exist on the
 * public listener at all. The Codex settings document is what a Child applies when it syncs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore } from "../../src/link/store";
import { parseHomeCodexSettingsDocument } from "../../src/link/codex-settings";
import { LINK_MANAGEMENT_READ_PATHS } from "../../src/link/management-routes";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ENV_KEY = "link-mgmt-env-admission";
const OTHER_KEY = "link-mgmt-other-admission";
const LINKED_KEY = "link-mgmt-linked-admission";
const LINKED_ID = "linked-key";
const PROVIDER_SECRET = "fixture-provider-credential-not-relayed";

const previous = {
  home: process.env.OPENCODEX_HOME,
  codexHome: process.env.CODEX_HOME,
  apiToken: process.env.OPENCODEX_API_AUTH_TOKEN,
};
let testHome = "";
let codexHome: IsolatedCodexHome | null = null;
let server: { stop(closeActiveConnections?: boolean): Promise<void>; url: URL } | null = null;

function key(id: string, value: string) {
  return { id, name: id, key: value, createdAt: "2026-09-25T00:00:00.000Z" };
}

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    runtimeRole: "hub",
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, apiKey: PROVIDER_SECRET, models: ["test-model"] },
    },
    apiKeys: [key("other-key", OTHER_KEY), key(LINKED_ID, LINKED_KEY)],
    clientIntegrations: { codex: false },
    fastMode: true,
    multiAgentMode: "v1",
    injectionModel: "mock/test-model",
    injectionEffort: "high",
    syncCodexSubagentDefaults: true,
    webSearchSidecar: { enabled: false },
  } as OcxConfig;
}

async function linkBase(): Promise<string> {
  const linkPort = JSON.parse(await Bun.file(linkStorePath()).text()).listenerPort as number;
  return `http://127.0.0.1:${linkPort}`;
}

function get(base: string, path: string, credential?: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(init.headers as Record<string, string> | undefined) },
  });
}

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-link-mgmt-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = ENV_KEY;
  codexHome = installIsolatedCodexHome("ocx-link-mgmt-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "mock/test-model" }] }));
  writeFileSync(join(codexHome.path, "config.toml"), "");
  const { saveConfig } = await import("../../src/config");
  writeLinkStore(linkStorePath(), {
    version: 1,
    listenerPort: null,
    links: [{
      id: "lnk_0123456789abcdef",
      alias: "mgmt-test",
      direction: "client-initiated",
      hostKeyFingerprint: "SHA256:abcdefghijklmnop",
      tunnelPort: 2222,
      apiKeyId: LINKED_ID,
      createdAt: "2026-09-25T00:00:00.000Z",
    }],
  });
  saveConfig(config());
  const { startServer } = await import("../../src/server");
  server = startServer(0);
});

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  codexHome?.restore();
  codexHome = null;
  if (previous.home === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previous.home;
  if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous.codexHome;
  if (previous.apiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previous.apiToken;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

describe("Remote Link management relay on the Home", () => {
  test("admits allowlisted reads only with the link key", async () => {
    const base = await linkBase();
    for (const credential of [undefined, ENV_KEY, OTHER_KEY]) {
      const refused = await get(base, "/v1/link-management/api/effort-caps", credential);
      expect({ credential, status: refused.status }).toEqual({ credential, status: 401 });
    }
    const caps = await get(base, "/v1/link-management/api/effort-caps", LINKED_KEY);
    expect(caps.status).toBe(200);
    expect(caps.headers.get("cache-control")).toBe("no-store");
    expect(Array.isArray((await caps.json() as { efforts?: unknown }).efforts)).toBe(true);
  });

  test("relays a masked projection and never a provider credential", async () => {
    const providers = await get(await linkBase(), "/v1/link-management/api/providers", LINKED_KEY, {
      headers: { cookie: "session=browser", "x-opencodex-gui-origin": "http://127.0.0.1:1" },
    });
    expect(providers.status).toBe(200);
    const text = await providers.text();
    expect(text).not.toContain(PROVIDER_SECRET);
    expect(text).not.toContain(LINKED_KEY);
    const rows = JSON.parse(text) as Array<{ name: string; hasApiKey: boolean }>;
    expect(rows.find(row => row.name === "mock")?.hasApiKey).toBe(true);
    const keys = await get(await linkBase(), "/v1/link-management/api/providers/keys?name=mock", LINKED_KEY);
    expect(keys.status).toBe(200);
    expect(await keys.text()).not.toContain(PROVIDER_SECRET);
  });

  test("refuses writes, unlisted reads and refresh queries before a handler runs", async () => {
    const base = await linkBase();
    const refused: Array<[string, string]> = [
      ["PUT", "/v1/link-management/api/settings"],
      ["POST", "/v1/link-management/api/providers"],
      ["DELETE", "/v1/link-management/api/providers"],
      ["GET", "/v1/link-management/api/logs"],
      ["GET", "/v1/link-management/api/config"],
      ["GET", "/v1/link-management/api/provider-quotas?refresh=1"],
      ["GET", "/v1/link-management/api/codex-auth/accounts?refresh=1"],
      // Reads that make the Home do upstream work or persist discovery are not reads here.
      ["GET", "/v1/link-management/api/oauth/accounts?provider=anthropic&quota=1"],
      ["GET", "/v1/link-management/api/providers/keys?name=mock&quota=1"],
      ["GET", "/v1/link-management/api/models"],
      ["GET", "/v1/link-management/api/subagent-models"],
      ["GET", "/v1/link-management/api/subagent-model-fallback"],
      ["GET", "/v1/link-management/api/diagnostics/project-config"],
      ["GET", "/v1/link-management/codex-settings?x=1"],
      ["GET", "/v1/link-management"],
    ];
    for (const [method, path] of refused) {
      const response = await get(base, path, LINKED_KEY, { method, ...(method === "GET" ? {} : { body: "{}" }) });
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
    }
  });

  test("the prefix exists only on the link listener", async () => {
    const response = await get(server!.url.origin, "/v1/link-management/api/effort-caps", LINKED_KEY);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("efforts");
  });

  test("every allowlisted read names a real Home management route", async () => {
    const base = await linkBase();
    for (const path of LINK_MANAGEMENT_READ_PATHS) {
      // The key-pool read names its provider, as `ocx account` sends it.
      const query = path === "/api/providers/keys" ? "?name=mock" : "";
      const response = await get(base, `/v1/link-management${path}${query}`, LINKED_KEY);
      await response.body?.cancel();
      expect({ path, routed: response.status !== 404 && response.status !== 401 }).toEqual({ path, routed: true });
    }
  });

  test("publishes the Home's OpenCodex-owned Codex settings", async () => {
    const response = await get(await linkBase(), "/v1/link-management/codex-settings", LINKED_KEY);
    expect(response.status).toBe(200);
    const document = parseHomeCodexSettingsDocument(await response.json());
    expect(document?.settings).toEqual({
      fastMode: true,
      multiAgentMode: "v1",
      webSearchSidecarEnabled: false,
      subagentDefaults: { model: "mock/test-model", reasoningEffort: "high" },
    });
    expect(document?.home.name.length).toBeGreaterThan(0);
  });
});
