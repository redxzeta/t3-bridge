import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "./auth.js";
import { createBridge } from "./server.js";
import { openState, writeRecord } from "./state.js";
import { mockUpstream } from "./mock-upstream.test-helper.js";

test("stateless requests own their compiled input schemas and retain argument validation", async () => {
  const mock = await mockUpstream("home");
  const root = mkdtempSync(join(tmpdir(), "t3-schema-ownership-"));
  const db = openState(root);
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = "synthetic-schema-ownership-key-1234567890";
  const config = { publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: mock.url }] };
  const initializer = createAuth(config, db, { setup: true });
  await (await getMigrations(initializer.options)).runMigrations();
  const bridge = createBridge(config, db);
  const originalFetch = globalThis.fetch;
  const originalValidator = AjvJsonSchemaValidator.prototype.getValidator;
  const owners = new Set<AjvJsonSchemaValidator>();
  let compilations = 0;
  AjvJsonSchemaValidator.prototype.getValidator = function (this: AjvJsonSchemaValidator, schema) {
    if (schema.properties && typeof schema.properties === "object" && "message" in schema.properties) {
      owners.add(this); compilations++;
    }
    return originalValidator.call(this, schema);
  } as typeof originalValidator;
  try {
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      return new URL(request.url).origin === config.publicUrl ? bridge.handle(request) : originalFetch(request);
    };
    writeRecord(db, "home", "tokens", { access_token: "home-access" });
    const { token } = await bridge.auth.api.signJWT({ body: { payload: { sub: "synthetic-owner", iss: `${config.publicUrl}/api/auth`, aud: `${config.publicUrl}/mcp`, scope: "mcp:tools" } } });
    const request = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      const response = await bridge.handle(new Request(`${config.publicUrl}/mcp`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }));
      assert.equal(response.status, 200);
      return response.text();
    };
    for (let i = 0; i < 3; i++) assert.match(await request(i, "tools/list"), /home__echo/);
    assert.match(await request(3, "tools/call", { name: "home__echo", arguments: { message: "valid" } }), /home:valid/);
    assert.doesNotMatch(await request(4, "tools/call", { name: "home__echo", arguments: { message: 42 } }), /home:/);
    assert.equal(mock.calls.length, 1, "invalid input must never reach the upstream");
    assert.equal(compilations, 5, "each stateless server wraps its fresh catalog schema");
    assert.equal(owners.size, 5, "compiled schemas must belong to each request, not the SDK's global cache");
  } finally {
    AjvJsonSchemaValidator.prototype.getValidator = originalValidator;
    globalThis.fetch = originalFetch;
    await bridge.upstreams.close(); db.close(); await mock.close(); rmSync(root, { recursive: true });
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previousSecret;
  }
});
