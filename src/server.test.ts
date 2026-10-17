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
