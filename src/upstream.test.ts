import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BridgeConfig } from "./config.js";
import { openState, readRecord, writeRecord } from "./state.js";
import { Upstreams } from "./upstream.js";
import { mockUpstream } from "./mock-upstream.test-helper.js";

test("upstream OAuth validates state, issuer, PKCE and replay; tokens survive reopen and refresh failures", async () => {
  const mock = await mockUpstream("home");
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-oauth-"));
  let db = openState(directory);
  const config: BridgeConfig = { publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: mock.url }] };
  try {
    let upstreams = new Upstreams(config, db);
    const first = await upstreams.startAuthorization("home");
    const second = await upstreams.startAuthorization("home");
    assert.equal(mock.fixture.registrations, 1);
    assert.notEqual(first.searchParams.get("state"), second.searchParams.get("state"));
    assert.equal(second.searchParams.get("code_challenge_method"), "S256");
    assert.equal(second.searchParams.get("resource"), mock.url);
    assert.equal(second.searchParams.get("scope"), "orchestration:read orchestration:operate");
    assert.equal(second.searchParams.get("redirect_uri"), `${config.publicUrl}/upstream/callback/home`);
    const pending = readRecord<{ verifier: string }>(db, "home", "pending")!;
    const verifier = pending.verifier;
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), second.searchParams.get("code_challenge"));
    mock.fixture.challenge = second.searchParams.get("code_challenge")!;
    const callback = new URLSearchParams({ code: "synthetic-code", state: second.searchParams.get("state")!, iss: new URL(mock.url).origin });
    for (const params of [new URLSearchParams({ ...Object.fromEntries(callback), state: "wrong" }), new URLSearchParams({ ...Object.fromEntries(callback), iss: "https://wrong.example.com" }), new URLSearchParams({ ...Object.fromEntries(callback), code: "" }), new URLSearchParams({ ...Object.fromEntries(callback), state: first.searchParams.get("state")! })]) await assert.rejects(upstreams.finishAuthorization("home", params), /Invalid upstream OAuth callback/);
    assert.equal(mock.fixture.exchanges, 0);
    writeRecord(db, "home", "pending", { ...pending, verifier: "wrong-verifier" });
    await assert.rejects(upstreams.finishAuthorization("home", callback), /token request failed/);
    assert.equal(readRecord(db, "home", "tokens"), undefined);
    writeRecord(db, "home", "pending", pending);
    await upstreams.finishAuthorization("home", callback);
    assert.equal(readRecord(db, "home", "state"), undefined);
    assert.equal(readRecord(db, "home", "verifier"), undefined);
    assert.equal(readRecord(db, "home", "pending"), undefined);
    await assert.rejects(upstreams.finishAuthorization("home", callback), /Invalid upstream OAuth callback/);
    await upstreams.close();
    db.close(); db = openState(directory);
    upstreams = new Upstreams(config, db);
    assert.equal((await upstreams.list("home"))[0]?.name, "echo");
    await upstreams.close();
    writeRecord(db, "home", "tokens", { access_token: "expired", refresh_token: "home-refresh", expires_at: 0 });
    upstreams = new Upstreams(config, db);
    assert.equal((await upstreams.list("home")).length, 1);
    assert.equal(mock.fixture.refreshes, 1);
    assert.equal(readRecord<{ refresh_token: string }>(db, "home", "tokens")?.refresh_token, "home-refresh");
    await upstreams.close();
    writeRecord(db, "home", "tokens", { access_token: "expired", refresh_token: "home-refresh", expires_at: 0 });
    mock.fixture.refreshFails = true;
    upstreams = new Upstreams(config, db);
    assert.deepEqual(await upstreams.list("home"), []);
    assert.equal((await upstreams.call("home", "echo", { message: "test" })).isError, true);
    assert.equal(readRecord<{ access_token: string }>(db, "home", "tokens")?.access_token, "expired");
    await upstreams.close();
    await assert.rejects(upstreams.startAuthorization("unknown"), /Unknown upstream/);
  } finally { db.close(); await mock.close(); rmSync(directory, { recursive: true }); }
});

test("callback changes stage a replacement without discarding the active grant", async () => {
  const mock = await mockUpstream("home");
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-relink-"));
  const db = openState(directory);
  const config: BridgeConfig = { publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: mock.url }] };
  const upstreams = new Upstreams(config, db);
  const oldClient = { client_id: "legacy-client" };
  const oldTokens = { access_token: "home-access", refresh_token: "home-refresh" };
  writeRecord(db, "home", "client", oldClient);
  writeRecord(db, "home", "tokens", oldTokens);
  try {
    const first = await upstreams.startAuthorization("home");
    assert.deepEqual(readRecord(db, "home", "client"), oldClient);
    assert.deepEqual(readRecord(db, "home", "tokens"), oldTokens);
    assert.equal((await upstreams.list("home")).length, 1);
    assert.equal((await upstreams.call("home", "echo", { message: "active" })).isError, undefined);
    const callback = new URLSearchParams({ code: "synthetic-code", state: first.searchParams.get("state")!, iss: new URL(mock.url).origin });
    await assert.rejects(upstreams.finishAuthorization("home", callback), /token request failed/);
    assert.deepEqual(readRecord(db, "home", "tokens"), oldTokens);
    config.publicUrl = "https://replacement.example.com";
    const second = await upstreams.startAuthorization("home");
    assert.equal(mock.fixture.registrations, 2);
    assert.equal(second.searchParams.get("redirect_uri"), `${config.publicUrl}/upstream/callback/home`);
    await assert.rejects(upstreams.finishAuthorization("home", callback), /Invalid upstream OAuth callback/);
    mock.fixture.challenge = second.searchParams.get("code_challenge")!;
    callback.set("state", second.searchParams.get("state")!);
    await upstreams.finishAuthorization("home", callback);
    assert.equal(readRecord<{ redirect_uri: string }>(db, "home", "client")?.redirect_uri, second.searchParams.get("redirect_uri"));
    assert.equal(readRecord(db, "home", "pending"), undefined);
    await upstreams.startAuthorization("home");
    assert.equal(mock.fixture.registrations, 2, "matching active registration is reused");
  } finally { await upstreams.close(); db.close(); await mock.close(); rmSync(directory, { recursive: true }); }
});

test("an ambiguous tool response is not replayed; a later explicit call reconnects", async () => {
  const mock = await mockUpstream("home");
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-timeout-"));
  const db = openState(directory);
  const upstreams = new Upstreams({ publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: mock.url }] }, db);
  writeRecord(db, "home", "tokens", { access_token: "home-access" });
  try {
    mock.fixture.dropResponse = true;
    assert.equal((await upstreams.call("home", "echo", { message: "ambiguous" })).isError, true);
    assert.equal(mock.calls.length, 1);
    mock.fixture.dropResponse = false;
    assert.deepEqual((await upstreams.call("home", "echo", { message: "explicit-next-call" })).content, [{ type: "text", text: "home:explicit-next-call" }]);
    assert.equal(mock.calls.length, 2);
  } finally { await upstreams.close(); db.close(); await mock.close(); rmSync(directory, { recursive: true }); }
});

test("a superseded or concurrent callback cannot replace the retained grant", async () => {
  const mock = await mockUpstream("home");
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-exchange-race-"));
  const db = openState(directory);
  const upstreams = new Upstreams({ publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: mock.url }] }, db);
  const old = { access_token: "home-access", refresh_token: "home-refresh" };
  writeRecord(db, "home", "client", { client_id: "legacy-client" });
  writeRecord(db, "home", "tokens", old);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  mock.fixture.exchangeGate = new Promise<void>((resolve) => { release = resolve; });
  mock.fixture.onExchange = entered;
  try {
    const first = await upstreams.startAuthorization("home");
    mock.fixture.challenge = first.searchParams.get("code_challenge")!;
    const params = new URLSearchParams({ code: "synthetic-code", state: first.searchParams.get("state")!, iss: new URL(mock.url).origin });
    const finishing = assert.rejects(upstreams.finishAuthorization("home", params), /changed during exchange/);
    await started;
    await assert.rejects(upstreams.finishAuthorization("home", params), /already in progress/);
    const next = await upstreams.startAuthorization("home");
    release(); await finishing;
    assert.equal(mock.fixture.exchanges, 1);
    assert.deepEqual(readRecord(db, "home", "tokens"), old);
    assert.equal(readRecord<{ state: string }>(db, "home", "pending")?.state, next.searchParams.get("state"));
  } finally { release(); await upstreams.close(); db.close(); await mock.close(); rmSync(directory, { recursive: true }); }
});

test("an old refresh cannot overwrite a replacement authorization", async () => {
  const mock = await mockUpstream("home");
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-refresh-race-"));
  const db = openState(directory);
  const upstreams = new Upstreams({ publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: mock.url }] }, db);
  writeRecord(db, "home", "client", { client_id: "legacy-client" });
  writeRecord(db, "home", "tokens", { access_token: "expired", refresh_token: "home-refresh", expires_at: 0 });
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  mock.fixture.refreshGate = new Promise<void>((resolve) => { release = resolve; }); mock.fixture.onRefresh = entered;
  try {
    const listing = upstreams.list("home"); await started;
    const url = await upstreams.startAuthorization("home"); mock.fixture.challenge = url.searchParams.get("code_challenge")!;
    await upstreams.finishAuthorization("home", new URLSearchParams({ code: "synthetic-code", state: url.searchParams.get("state")!, iss: new URL(mock.url).origin }));
    const replacement = readRecord(db, "home", "tokens");
    release(); assert.deepEqual(await listing, []);
    assert.deepEqual(readRecord(db, "home", "tokens"), replacement);
    assert.equal((await upstreams.list("home")).length, 1);
  } finally { release(); await upstreams.close(); db.close(); await mock.close(); rmSync(directory, { recursive: true }); }
});


test("concurrent cold reads share initialization and reuse the same upstream client", async () => {
  const mock = await mockUpstream("home");
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-concurrent-"));
  const db = openState(directory);
  const upstreams = new Upstreams({ publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: mock.url }] }, db);
  writeRecord(db, "home", "tokens", { access_token: "home-access" });
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => upstreams.list("home")));
    assert.ok(results.every((tools) => tools[0]?.name === "echo"));
    assert.equal(mock.fixture.initializes, 1, "one physical client owns all concurrent requests");
    await Promise.all(Array.from({ length: 2 }, () => upstreams.call("home", "echo", { message: "read" })));
    assert.equal(mock.fixture.initializes, 1);
    assert.equal(mock.calls.length, 2);
  } finally { await upstreams.close(); db.close(); await mock.close(); rmSync(directory, { recursive: true }); }
});


test("closing during initialization cannot publish a late client", async () => {
  const mock = await mockUpstream("home");
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-initialize-close-"));
  const db = openState(directory);
  const upstreams = new Upstreams({ publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: mock.url }] }, db);
  writeRecord(db, "home", "tokens", { access_token: "home-access" });
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  mock.fixture.initializeGate = new Promise<void>((resolve) => { release = resolve; });
  mock.fixture.onInitialize = entered;
  try {
    const listing = upstreams.list("home");
    await started;
    await upstreams.close();
    release();
    assert.deepEqual(await listing, [], "late initialization cannot return an abandoned client");
    mock.fixture.initializeGate = undefined;
    assert.equal((await upstreams.list("home"))[0]?.name, "echo");
    assert.equal(mock.fixture.initializes, 2, "the next explicit request establishes a fresh client");
  } finally { release(); await upstreams.close(); db.close(); await mock.close(); rmSync(directory, { recursive: true }); }
});


test("a failed call retires its client without cancelling another in-flight operation", async () => {
  const mock = await mockUpstream("home");
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-drain-"));
  const db = openState(directory);
  const upstreams = new Upstreams({ publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: mock.url }] }, db);
  writeRecord(db, "home", "tokens", { access_token: "home-access" });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  mock.fixture.callGate = async (args) => { if (args.message === "slow") { entered(); await gate; } };
  mock.fixture.dropMessage = "drop";
  try {
    await upstreams.list("home");
    const slow = upstreams.call("home", "echo", { message: "slow" });
    await started;
    assert.equal((await upstreams.call("home", "echo", { message: "drop" })).isError, true);
    assert.equal((await upstreams.call("home", "echo", { message: "next" })).isError, undefined);
    release();
    assert.deepEqual((await slow).content, [{ type: "text", text: "home:slow" }]);
    assert.equal(mock.fixture.initializes, 2);
    assert.equal(mock.calls.length, 3, "failed operations are never replayed");
  } finally { release(); await upstreams.close(); db.close(); await mock.close(); rmSync(directory, { recursive: true }); }
});
