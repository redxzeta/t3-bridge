import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "./auth.js";
import { createBridge } from "./server.js";
import { openState, writeRecord } from "./state.js";
import { Upstreams, DISCOVERY_BUDGET_MS, CATALOG_FRESH_MS, type UpstreamStatus } from "./upstream.js";
import { mockUpstream } from "./mock-upstream.test-helper.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const home = await mockUpstream("home"), lab = await mockUpstream("lab");
  const root = mkdtempSync(join(tmpdir(), "t3-bridge-resilience-"));
  const db = openState(root);
  const config = { publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com",
    upstreams: [{ name: "home", url: home.url }, { name: "lab", url: lab.url }] };
  for (const name of ["home", "lab"]) writeRecord(db, name, "tokens", { access_token: `${name}-access` });
  const upstreams = new Upstreams(config, db);
  t.after(async () => { await upstreams.close(); db.close(); await home.close(); await lab.close(); rmSync(root, { recursive: true }); });
  return { home, lab, root, db, config, upstreams };
}

function assertSanitized(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /127\.0\.0\.1|https?:|home-access|lab-access|Bearer|private-payload/);
}

test("cold state is unknown; freshness expires without rewriting observation timestamps", async (t) => {
  const f = await fixture(t);
  const cold = f.upstreams.status();
  assert.ok(cold.every((item) => item.status === "unknown" && item.observedAt === null && item.lastSuccessAt === null && item.catalog.count === null));
  await f.upstreams.catalogs();
  const fresh = f.upstreams.status();
  assert.ok(fresh.every((item) => item.status === "fresh" && item.catalog.count === 1 && !item.catalog.cached));
  assert.ok(fresh.every((item) => item.lastSuccessAt === item.observedAt && !Number.isNaN(Date.parse(item.observedAt!))));
  await f.upstreams.catalogs();
  assert.equal(f.home.fixture.lists, 1);
  assert.ok(f.upstreams.status().every((item) => item.catalog.cached));
  const future = Date.now() + CATALOG_FRESH_MS + 1;
  t.mock.method(Date, "now", () => future);
  const stale = f.upstreams.status();
  assert.ok(stale.every((item) => item.status === "stale" && item.catalog.freshness === "stale"));
  assert.equal(stale[0]!.observedAt, fresh[0]!.observedAt);
  assertSanitized(stale);
});

test("healthy plus offline discovery retains the healthy catalog and sanitizes failure state", async (t) => {
  const f = await fixture(t);
  f.lab.fixture.unavailable = true;
  const catalogs = await f.upstreams.catalogs();
  assert.equal(catalogs[0]!.length, 1);
  assert.deepEqual(catalogs[1], []);
  const state = f.upstreams.status();
  assert.equal(state[0]!.status, "fresh");
  assert.equal(state[1]!.status, "unavailable");
  assert.equal(state[1]!.failure!.category, "unavailable");
  assert.ok(state[1]!.failure!.action);
  assertSanitized(state);
});

test("concurrent handler discovery coalesces and all hung hosts share one overall budget", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  f.home.fixture.listGate = gate.promise; f.lab.fixture.listGate = gate.promise;
  const start = performance.now();
  try {
    const catalogs = await Promise.all([f.upstreams.catalogs(), f.upstreams.catalogs(), f.upstreams.catalogs()]);
    assert.ok(catalogs.every((value) => value.every((tools) => tools.length === 0)));
    assert.ok(performance.now() - start < DISCOVERY_BUDGET_MS + 1500);
    assert.equal(f.home.fixture.initializes, 1); assert.equal(f.lab.fixture.initializes, 1);
    assert.equal(f.home.fixture.lists, 1); assert.equal(f.lab.fixture.lists, 1);
    assert.ok(f.upstreams.status().every((item) => item.status === "unavailable"));
    await f.upstreams.catalogs();
    assert.equal(f.home.fixture.initializes, 1, "recent failures do not create request storms");
  } finally { gate.resolve(); }
});

test("stale cached tools remain explicit while healthy and hung hosts stay isolated", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  await f.upstreams.catalogs();
  const success = f.upstreams.status()[1]!.lastSuccessAt;
  const gate = deferred(); f.lab.fixture.listGate = gate.promise;
  const start = Date.now();
  t.mock.method(Date, "now", () => start + CATALOG_FRESH_MS + 1);
  try {
    const catalogs = await f.upstreams.catalogs();
    assert.equal(catalogs[0]!.length, 1); assert.equal(catalogs[1]!.length, 1);
    const state = f.upstreams.status();
    assert.equal(state[0]!.status, "fresh");
    assert.equal(state[1]!.status, "stale");
    assert.equal(state[1]!.discovery, "unavailable");
    assert.equal(state[1]!.catalog.fallback, true);
    assert.equal(state[1]!.lastSuccessAt, success);
    assert.notEqual(state[1]!.observedAt, success);
    assertSanitized(state);
  } finally { gate.resolve(); }
});

test("missing grants are sign-in required, distinct from network errors", async (t) => {
  const f = await fixture(t);
  f.db.prepare("DELETE FROM upstream_oauth_state WHERE instance = 'home' AND kind = 'tokens'").run();
  f.lab.fixture.unavailable = true;
  await f.upstreams.catalogs();
  const state = f.upstreams.status();
  assert.equal(state[0]!.status, "sign_in_required");
  assert.equal(state[1]!.status, "unavailable");
  assert.equal(f.home.fixture.initializes, 0);
  assert.equal(f.home.fixture.registrations, 0);
});

test("a discovery deadline does not cancel an unrelated long-running native call", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  await f.upstreams.list("home");
  const callGate = deferred(), entered = deferred(), listGate = deferred();
  f.home.fixture.callGate = async () => { entered.resolve(); await callGate.promise; };
  f.home.fixture.listGate = listGate.promise;
  try {
    const call = f.upstreams.call("home", "echo", { message: "slow" });
    await entered.promise;
    await f.upstreams.list("home");
    callGate.resolve();
    assert.deepEqual((await call).content, [{ type: "text", text: "home:slow" }]);
    assert.equal(f.home.calls.length, 1);
    assert.equal(f.home.fixture.initializes, 1);
  } finally { callGate.resolve(); listGate.resolve(); }
});

test("late discovery after callback replacement cannot overwrite the new catalog or observation", async (t) => {
  const f = await fixture(t);
  await f.upstreams.list("home");
  const gate = deferred(), entered = deferred();
  f.home.fixture.listGate = gate.promise; f.home.fixture.onList = entered.resolve;
  const old = f.upstreams.list("home");
  await entered.promise;
  const link = await f.upstreams.startAuthorization("home");
  f.home.fixture.challenge = link.searchParams.get("code_challenge")!;
  await f.upstreams.finishAuthorization("home", new URLSearchParams({ code: "synthetic-code", state: link.searchParams.get("state")!, iss: new URL(f.home.url).origin }));
  f.home.fixture.listGate = undefined;
  f.home.fixture.tools = [{ name: "replacement", inputSchema: { type: "object" } }];
  const latest = await f.upstreams.list("home");
  const state = f.upstreams.status()[0];
  gate.resolve(); await old;
  assert.equal(latest[0]!.name, "replacement");
  assert.deepEqual(f.upstreams.status()[0], state);
  assert.equal((await f.upstreams.catalogs())[0]![0]!.name, "replacement");
});

async function authenticated(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const previous = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = "t".repeat(64);
  t.after(() => { if (previous === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previous; });
  const initializer = createAuth(f.config, f.db, { setup: true });
  await (await getMigrations(initializer.options)).runMigrations();
  const bridge = createBridge(f.config, f.db);
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    return new URL(request.url).origin === f.config.publicUrl ? bridge.handle(request) : original(input, init);
  });
  const { token } = await bridge.auth.api.signJWT({ body: { payload: { sub: "synthetic-owner", iss: `${f.config.publicUrl}/api/auth`, aud: `${f.config.publicUrl}/mcp`, scope: "mcp:tools" } } });
  const client = new Client({ name: "synthetic-resilience", version: "1" });
  t.after(async () => { await client.close(); await bridge.close(); });
  return { bridge, client, connect: () => client.connect(new StreamableHTTPClientTransport(new URL(`${f.config.publicUrl}/mcp`), { fetch: globalThis.fetch, requestInit: { headers: { authorization: `Bearer ${token}` } } })) };
}

test("bridge_status is OAuth-protected and usable when every host is down", async (t) => {
  const f = await fixture(t);
  f.home.fixture.unavailable = true; f.lab.fixture.unavailable = true;
  const a = await authenticated(t, f);
  const denied = await a.bridge.handle(new Request(`${f.config.publicUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bridge_status", arguments: {} } }) }));
  assert.equal(denied.status, 401);
  assert.equal(f.home.fixture.requests + f.lab.fixture.requests, 0);
  const { token: wrongScope } = await a.bridge.auth.api.signJWT({ body: { payload: { sub: "synthetic-owner", iss: `${f.config.publicUrl}/api/auth`, aud: `${f.config.publicUrl}/mcp`, scope: "openid" } } });
  const forbidden = await a.bridge.handle(new Request(`${f.config.publicUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${wrongScope}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bridge_status", arguments: {} } }) }));
  assert.equal(forbidden.status, 403);
  assert.equal(f.home.fixture.requests + f.lab.fixture.requests, 0);
  await a.connect();
  const tools = (await a.client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["bridge_status"]);
  assert.equal(tools[0]!.annotations!.readOnlyHint, true);
  const result = await a.client.callTool({ name: "bridge_status", arguments: {} });
  const state = (result.structuredContent as { upstreams: UpstreamStatus[] }).upstreams;
  assert.ok(state.every((item) => item.status === "unavailable"));
  assertSanitized(result);
  assert.equal(f.home.calls.length + f.lab.calls.length, 0);
  assert.equal(f.home.fixture.registrations + f.lab.fixture.registrations, 0);
});

test("native routing, request keys, permissions and uncertain mutations pass through unchanged", async (t) => {
  const f = await fixture(t);
  for (const mock of [f.home, f.lab]) mock.fixture.tools = ["t3_thread_launch", "t3_thread_send"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true }, annotations: { readOnlyHint: false, destructiveHint: false } }));
  const a = await authenticated(t, f); await a.connect();
  const args = { clientRequestId: "synthetic-native-key", environmentId: "synthetic-environment", projectId: "synthetic-project", message: "native mutation", runtimeMode: "approval-required", workspaceStrategy: { type: "root" } };
  f.home.fixture.permissionDenied = true;
  const denied = await a.client.callTool({ name: "home__t3_thread_launch", arguments: args });
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.content, [{ type: "text", text: "T3 approval required" }]);
  assert.deepEqual(f.home.calls, [{ name: "t3_thread_launch", arguments: args }]);
  assert.equal(f.lab.calls.length, 0);
  const send = { clientRequestId: "synthetic-send-key", threadId: "synthetic-thread", environmentId: "synthetic-environment", mode: "queue", message: "native send" };
  assert.equal((await a.client.callTool({ name: "home__t3_thread_send", arguments: send })).isError, true);
  assert.deepEqual(f.home.calls[1], { name: "t3_thread_send", arguments: send });
  f.home.fixture.permissionDenied = false; f.home.fixture.dropResponse = true;
  const uncertain = await a.client.callTool({ name: "home__t3_thread_launch", arguments: { ...args, clientRequestId: "synthetic-next-key" } });
  assert.equal(uncertain.isError, true);
  assert.equal(f.home.calls.length, 3, "lost response is never retried by the bridge");
  assert.equal(f.lab.calls.length, 0, "no cross-host rerouting");
});


test("a cold healthy host stays usable while another host hangs during serving", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const gate = deferred(); f.lab.fixture.listGate = gate.promise;
  const a = await authenticated(t, f);
  const start = performance.now();
  try {
    await a.connect();
    const tools = (await a.client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name), ["bridge_status", "home__echo"]);
    const result = await a.client.callTool({ name: "bridge_status", arguments: {} });
    const state = (result.structuredContent as { upstreams: UpstreamStatus[] }).upstreams;
    assert.equal(state[0]!.status, "fresh"); assert.equal(state[1]!.status, "unavailable");
    assert.ok(performance.now() - start < DISCOVERY_BUDGET_MS + 1500);
    assert.deepEqual((await a.client.callTool({ name: "home__echo", arguments: { message: "healthy" } })).content, [{ type: "text", text: "home:healthy" }]);
    assert.equal(f.lab.fixture.lists, 1);
    assertSanitized(result);
  } finally { gate.resolve(); }
});

test("discovery timeout during shared initialization leaves a native call running", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const gate = deferred(), entered = deferred();
  f.home.fixture.initializeGate = gate.promise; f.home.fixture.onInitialize = entered.resolve;
  try {
    const call = f.upstreams.call("home", "echo", { message: "pending initialization" });
    await entered.promise;
    assert.deepEqual(await f.upstreams.list("home"), []);
    gate.resolve();
    assert.deepEqual((await call).content, [{ type: "text", text: "home:pending initialization" }]);
    assert.equal(f.home.fixture.initializes, 1);
    assert.equal(f.home.calls.length, 1);
  } finally { gate.resolve(); }
});


test("initialization failure is observed even when client cleanup settles immediately", async (t) => {
  const f = await fixture(t);
  f.home.fixture.unavailable = true; f.lab.fixture.unavailable = true;
  t.mock.method(Client.prototype, "close", async () => {});
  await f.upstreams.catalogs();
  assert.ok(f.upstreams.status().every((item) => item.discovery === "unavailable" && item.observedAt !== null));
});
