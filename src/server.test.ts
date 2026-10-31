import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getMigrations } from "better-auth/db/migration";
import { createBridge } from "./server.js";
import { openState, writeRecord } from "./state.js";
import { mockUpstream } from "./mock-upstream.test-helper.js";

// Real bridge auth middleware and MCP transport, with synthetic signing keys and local upstreams.
test("authenticated MCP prefixes and routes two upstreams, preserving approval errors and partial availability", async () => {
  const home = await mockUpstream("home"), lab = await mockUpstream("lab");
  const root = mkdtempSync(join(tmpdir(), "t3-bridge-server-"));
  const db = openState(root);
  process.env.BETTER_AUTH_SECRET = "synthetic-server-test-signing-secret-1234567890";
  const config = { publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: home.url }, { name: "lab", url: lab.url }] };
  // Initialize schema before creating runtime auth.
  const { createAuth } = await import("./auth.js");
  const initializer = createAuth(config, db, { setup: true });
  await (await getMigrations(initializer.options)).runMigrations();
  const bridge = createBridge(config, db);
  const originalFetch = globalThis.fetch;
  const client = new Client({ name: "synthetic-client", version: "0.0.0" });
  let labClosed = false;
  try {
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === config.publicUrl) return bridge.handle(request);
      return originalFetch(input, init);
    };
    const unauthenticated = await bridge.handle(new Request(`${config.publicUrl}/mcp`, { method: "POST" }));
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get("www-authenticate")!, /oauth-protected-resource/);
    assert.equal((await bridge.handle(new Request(`${config.publicUrl}/mcp`))).status, 405);
    assert.equal((await bridge.handle(new Request(`${config.publicUrl}/consent?scope=mcp:tools`))).status, 400);
    const metadata = await bridge.handle(new Request(`${config.publicUrl}/.well-known/oauth-protected-resource/mcp`));
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).resource, `${config.publicUrl}/mcp`);
    for (const payload of [
      { iss: "https://wrong.example.com", aud: `${config.publicUrl}/mcp`, scope: "mcp:tools" },
      { iss: `${config.publicUrl}/api/auth`, aud: "https://wrong.example.com/mcp", scope: "mcp:tools" },
      { iss: `${config.publicUrl}/api/auth`, aud: `${config.publicUrl}/mcp`, scope: "openid" },
    ]) {
      const { token } = await bridge.auth.api.signJWT({ body: { payload: { sub: "synthetic-owner", ...payload } } });
      const response = await bridge.handle(new Request(`${config.publicUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}` } }));
      assert.equal(response.status, payload.scope === "openid" ? 403 : 401);
    }
    for (const name of ["home", "lab"]) writeRecord(db, name, "tokens", { access_token: `${name}-access` });
    const { token } = await bridge.auth.api.signJWT({ body: { payload: { sub: "synthetic-owner", iss: `${config.publicUrl}/api/auth`, aud: `${config.publicUrl}/mcp`, scope: "mcp:tools" } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${config.publicUrl}/mcp`), {
      fetch: globalThis.fetch, requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["home__echo", "lab__echo"]);
    assert.deepEqual((await client.callTool({ name: "home__echo", arguments: { message: "one" } })).content, [{ type: "text", text: "home:one" }]);
    assert.deepEqual((await client.callTool({ name: "lab__echo", arguments: { message: "two" } })).content, [{ type: "text", text: "lab:two" }]);
    assert.deepEqual(home.calls, [{ name: "echo", arguments: { message: "one" } }]);
    assert.deepEqual(lab.calls, [{ name: "echo", arguments: { message: "two" } }]);
    lab.fixture.permissionDenied = true;
    const denied = await client.callTool({ name: "lab__echo", arguments: { message: "write" } });
    assert.equal(denied.isError, true);
    assert.deepEqual(denied.content, [{ type: "text", text: "T3 approval required" }]);
    await lab.close(); labClosed = true;
    assert.equal((await client.callTool({ name: "lab__echo", arguments: { message: "offline" } })).isError, true);
    assert.deepEqual((await client.callTool({ name: "home__echo", arguments: { message: "still available" } })).content, [{ type: "text", text: "home:still available" }]);
  } finally {
    await client.close(); await bridge.upstreams.close();
    globalThis.fetch = originalFetch;
    delete process.env.BETTER_AUTH_SECRET;
    db.close(); await home.close(); if (!labClosed) await lab.close();
    rmSync(root, { recursive: true });
  }
});

test("HTTP adapter preserves separate browser cookies through downstream OAuth login and consent", async () => {
  const { createHash } = await import("node:crypto");
  const { createAuth } = await import("./auth.js");
  const root = mkdtempSync(join(tmpdir(), "t3-bridge-oauth-http-"));
  const db = openState(root);
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = "synthetic-http-oauth-test-secret-1234567890";
  const config = { publicUrl: "https://bridge.example.com", listenPort: 0, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: "http://127.0.0.1:3773/mcp" }] };
  const initializer = createAuth(config, db, { setup: true });
  await (await getMigrations(initializer.options)).runMigrations();
  const password = "p".repeat(128);
  await initializer.api.signUpEmail({ body: { name: "Owner", email: config.ownerEmail, password } });
  const bridge = createBridge(config, db);
  const cookies = new Map<string, string>();
  try {
    await new Promise<void>((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
    const address = bridge.server.address();
    assert.ok(address && typeof address !== "string");
    config.listenPort = address.port;
    // Use loopback HTTP transport while preserving the configured public HTTPS origin.
    const request = async (path: string, init: RequestInit = {}, useCookies = true) => {
      const headers = new Headers(init.headers);
      headers.set("origin", config.publicUrl);
      if (useCookies && cookies.size) headers.set("cookie", [...cookies.values()].join("; "));
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers, redirect: "manual" });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!;
        cookies.set(pair.split("=")[0]!, pair);
      }
      return response;
    };
    const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const login = await request("/api/auth/sign-in/email", post({ email: config.ownerEmail, password, rememberMe: false }));
    assert.equal(login.status, 200);
    assert.equal(login.headers.getSetCookie().length, 2, "session and remember-me cookies must remain separate HTTP fields");
    await login.arrayBuffer();
    const session = await request("/api/auth/get-session");
    assert.equal((await session.json()).user.email, config.ownerEmail);
    const registration = await request("/api/auth/oauth2/create-client", post({
      client_name: "Synthetic client", redirect_uris: ["https://client.example.com/callback"],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "openid offline_access mcp:tools",
    }));
    assert.equal(registration.status, 201);
    const { client_id } = await registration.json();
    cookies.clear();
    const verifier = "v".repeat(64);
    const query = new URLSearchParams({ client_id, redirect_uri: "https://client.example.com/callback", response_type: "code", scope: "openid offline_access mcp:tools", resource: `${config.publicUrl}/mcp`, state: "synthetic-state", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
    const authorize = await request(`/api/auth/oauth2/authorize?${query}`, { headers: { accept: "application/json" } });
    assert.equal(authorize.status, 200);
    const signIn = new URL((await authorize.json()).url, config.publicUrl);
    assert.equal(signIn.pathname, "/sign-in");
    const resumed = await request("/api/auth/sign-in/email", post({ email: config.ownerEmail, password, rememberMe: false, oauth_query: signIn.search.slice(1) }));
    assert.equal(resumed.status, 200);
    const continuation = await resumed.json();
    assert.equal(continuation.redirect, true);
    const consentUrl = new URL(continuation.url, config.publicUrl);
    assert.equal(consentUrl.pathname, "/consent");
    const consentPage = await request(`${consentUrl.pathname}${consentUrl.search}`);
    assert.equal(consentPage.status, 200);
    await consentPage.arrayBuffer();
    const consent = await request("/api/auth/oauth2/consent", post({ accept: true, oauth_query: consentUrl.search.slice(1) }));
    assert.equal(consent.status, 200);
    const callback = new URL((await consent.json()).url);
    assert.equal(callback.origin, "https://client.example.com");
    assert.equal(callback.searchParams.get("state"), "synthetic-state");
    assert.equal(callback.searchParams.get("iss"), `${config.publicUrl}/api/auth`);
    assert.ok(callback.searchParams.get("code"));
    const exchange = await request("/api/auth/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id, code: callback.searchParams.get("code")!, redirect_uri: "https://client.example.com/callback", code_verifier: verifier, resource: `${config.publicUrl}/mcp` }),
    }, false);
    assert.equal(exchange.status, 200);
    const tokens = await exchange.json();
    assert.equal(typeof tokens.access_token, "string");
    assert.equal(typeof tokens.refresh_token, "string");
    const refreshed = await request("/api/auth/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id, refresh_token: tokens.refresh_token, resource: `${config.publicUrl}/mcp` }),
    }, false);
    assert.equal(refreshed.status, 200);
    const freshTokens = await refreshed.json();
    assert.equal(typeof freshTokens.access_token, "string");
    assert.equal(typeof freshTokens.refresh_token, "string");
    const revoked = await request("/api/auth/oauth2/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id, token: freshTokens.refresh_token, token_type_hint: "refresh_token" }),
    }, false);
    assert.equal(revoked.status, 200); await revoked.arrayBuffer();
    const rejectedRefresh = await request("/api/auth/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id, refresh_token: freshTokens.refresh_token, resource: `${config.publicUrl}/mcp` }),
    }, false);
    assert.equal(rejectedRefresh.status, 400); await rejectedRefresh.arrayBuffer();
  } finally {
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
    await bridge.upstreams.close();
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previousSecret;
    db.close(); rmSync(root, { recursive: true });
  }
});
