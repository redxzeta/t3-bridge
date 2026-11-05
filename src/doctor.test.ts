import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { openState, readRecord, writeRecord } from "./state.js";
import { Upstreams } from "./upstream.js";
import { mockUpstream } from "./mock-upstream.test-helper.js";
import type { BridgeConfig } from "./config.js";

async function fixture(t: TestContext) {
  const mock = await mockUpstream("home");
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-doctor-"));
  const db = openState(directory);
  const config: BridgeConfig = {
    publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com",
    upstreams: [{ name: "home", url: mock.url }],
  };
  writeRecord(db, "home", "tokens", { access_token: "home-access", refresh_token: "home-refresh", expires_at: Date.now() + 3600000 });
  writeRecord(db, "home", "client", { client_id: "home-client" });
  const upstreams = new Upstreams(config, db);
  t.after(async () => {
    await upstreams.close(); db.close(); await mock.close();
    rmSync(directory, { recursive: true });
  });
  return { mock, directory, db, config, upstreams };
}

function assertPrivate(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /home-access|home-refresh|Bearer|127\.0\.0\.1|https?:|synthetic-private/);
}

test("doctor performs fresh paginated discovery, closes clients, and does not invoke or register", async (t) => {
  const f = await fixture(t);
  const close = t.mock.method(Client.prototype, "close");
  f.mock.fixture.paginate = true;
  assert.deepEqual(await f.upstreams.doctor(), [{ name: "home", status: "ok", toolCount: 2 }]);
  assert.equal(f.mock.fixture.initializes, 1);
  assert.ok(close.mock.callCount() > 0);
  assert.equal(f.mock.fixture.registrations, 0);
  assert.equal(f.mock.calls.length, 0);
});

test("doctor checks unlinked and healthy upstreams independently", async (t) => {
  const f = await fixture(t);
  f.config.upstreams.unshift({ name: "unlinked", url: f.mock.url });
  const report = await f.upstreams.doctor();
  assert.equal(report[0]!.status, "sign_in_required");
  assert.equal(report[1]!.status, "ok");
  assertPrivate(report);
});

test("doctor refreshes an existing grant and preserves the saved refresh token", async (t) => {
  const f = await fixture(t);
  writeRecord(f.db, "home", "tokens", { access_token: "expired", refresh_token: "home-refresh", expires_at: 0 });
  assert.equal((await f.upstreams.doctor())[0]!.status, "ok");
  assert.equal(f.mock.fixture.refreshes, 1);
  assert.equal(readRecord<{ access_token: string }>(f.db, "home", "tokens")!.access_token, "home-fresh");
  assert.equal(readRecord<{ refresh_token: string }>(f.db, "home", "tokens")!.refresh_token, "home-refresh");
  assert.equal(f.mock.fixture.registrations, 0);
});

test("doctor reports rejected refresh without changing retained tokens or exposing secrets", async (t) => {
  const f = await fixture(t);
  const old = { access_token: "expired", refresh_token: "home-refresh", expires_at: 0 };
  writeRecord(f.db, "home", "tokens", old);
  f.mock.fixture.refreshFails = true;
  const report = await f.upstreams.doctor();
  assert.equal(report[0]!.status, "sign_in_required");
  assert.deepEqual(readRecord(f.db, "home", "tokens"), old);
  assertPrivate(report);
});

test("doctor never registers a missing client to refresh a grant", async (t) => {
  const f = await fixture(t);
  f.db.prepare("DELETE FROM upstream_oauth_state WHERE kind = 'client'").run();
  writeRecord(f.db, "home", "tokens", { access_token: "expired", refresh_token: "home-refresh", expires_at: 0 });
  assert.equal((await f.upstreams.doctor())[0]!.status, "sign_in_required");
  assert.equal(f.mock.fixture.refreshes, 0);
  assert.equal(f.mock.fixture.registrations, 0);
});

test("doctor does not accept the serving catalog as evidence during an outage", async (t) => {
  const f = await fixture(t);
  const warning = t.mock.method(console, "warn", () => {});
  const catalog = await f.upstreams.list("home");
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("synthetic-private-network-detail"); });
  assert.deepEqual(await f.upstreams.list("home"), catalog);
  const log = JSON.parse(warning.mock.calls[0]!.arguments[0]);
  assert.equal(log.cached, true);
  assert.equal(log.status, "unavailable");
  assertPrivate(log);
  const report = await f.upstreams.doctor();
  assert.equal(report[0]!.status, "unavailable");
  assert.equal(report[0]!.toolCount, undefined);
  assertPrivate(report);
});

test("doctor cancels hung discovery after 15 seconds and continues to the next upstream", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.mock.fixture.listGate = new Promise<void>((resolve) => { release = resolve; });
  f.config.upstreams.push({ name: "unlinked", url: f.mock.url });
  const start = Date.now();
  try {
    const report = await f.upstreams.doctor();
    assert.equal(report[0]!.status, "unavailable");
    assert.match(report[0]!.reason!, /timed out/);
    assert.equal(report[1]!.status, "sign_in_required");
    assert.ok(Date.now() - start < 18000);
    assertPrivate(report);
  } finally { release(); }
});

test("doctor sanitizes unreadable local state as an error", async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE upstream_oauth_state SET value = ? WHERE kind = 'tokens'").run("synthetic-private-invalid-json");
  const report = await f.upstreams.doctor();
  assert.equal(report[0]!.status, "error");
  assertPrivate(report);
});

async function cli(directory: string, configPath: string) {
  const child = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname, "doctor"], {
    env: { ...process.env, BETTER_AUTH_SECRET: "", T3_BRIDGE_CONFIG: configPath, T3_BRIDGE_STATE_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (value) => { stdout += value; });
  child.stderr.on("data", (value) => { stderr += value; });
  const [code] = await once(child, "close");
  return { code, report: JSON.parse(stdout), stderr };
}

test("doctor CLI returns JSON and exit codes 0, 1, and 2 without a gateway secret", async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, "config.json");
  writeFileSync(path, JSON.stringify(f.config));
  const healthy = await cli(f.directory, path);
  assert.equal(healthy.code, 0);
  assert.equal(healthy.report.upstreams[0].status, "ok");
  assert.equal(healthy.stderr, "");
  f.db.prepare("DELETE FROM upstream_oauth_state WHERE kind = 'tokens'").run();
  const unlinked = await cli(f.directory, path);
  assert.equal(unlinked.code, 1);
  assert.equal(unlinked.report.upstreams[0].status, "sign_in_required");
  assert.equal(unlinked.stderr, "");
  writeFileSync(path, "synthetic-private-invalid-config");
  const invalid = await cli(f.directory, path);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.report.status, "error");
  assert.equal(invalid.stderr, "");
  assertPrivate(invalid);
});

test("doctor CLI sanitizes state startup failures with exit 2", async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, "config.json"), statePath = join(f.directory, "blocked-state");
  writeFileSync(path, JSON.stringify(f.config));
  writeFileSync(statePath, "synthetic-private-not-a-directory");
  const result = await cli(statePath, path);
  assert.equal(result.code, 2);
  assert.equal(result.report.status, "error");
  assert.equal(result.stderr, "");
  assertPrivate(result);
});

test("close cancels pending discovery and allows a later explicit reconnect", async (t) => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  f.mock.fixture.listGate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.mock.fixture.onList = entered;
  try {
    const pending = f.upstreams.list("home");
    await started;
    await f.upstreams.close();
    assert.deepEqual(await pending, []);
    release();
    f.mock.fixture.listGate = undefined;
    assert.equal((await f.upstreams.list("home")).length, 1);
  } finally { release(); }
});

test("shutdown cancels a refresh before state is closed and retains the old grant", async (t) => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  f.mock.fixture.refreshGate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.mock.fixture.onRefresh = entered;
  const old = { access_token: "expired", refresh_token: "home-refresh", expires_at: 0 };
  writeRecord(f.db, "home", "tokens", old);
  try {
    const pending = f.upstreams.list("home");
    await started;
    await f.upstreams.close();
    assert.deepEqual(await pending, []);
    assert.deepEqual(readRecord(f.db, "home", "tokens"), old);
  } finally { release(); }
});

test("shutdown closes a retired client even while another call is still in flight", async (t) => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.mock.fixture.callGate = async (args) => { if (args.message === "slow") { entered(); await gate; } };
  f.mock.fixture.dropMessage = "drop";
  try {
    await f.upstreams.list("home");
    const slow = f.upstreams.call("home", "echo", { message: "slow" });
    await started;
    assert.equal((await f.upstreams.call("home", "echo", { message: "drop" })).isError, true);
    await f.upstreams.close();
    assert.equal((await slow).isError, true);
    assert.equal(f.mock.calls.length, 2);
  } finally { release(); }
});
