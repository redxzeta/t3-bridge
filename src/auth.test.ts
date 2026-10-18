import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "./auth.js";
import type { BridgeConfig } from "./config.js";
import { openState } from "./state.js";

test("bootstraps one local password account and disables public signup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "t3-bridge-auth-"));
  const db = openState(directory);
  process.env.BETTER_AUTH_SECRET = "test-only-secret-for-gateway-auth-test-1234567890";
  const config: BridgeConfig = {
    publicUrl: "https://gateway.example.com", listenPort: 8787, ownerEmail: "owner@example.com",
    upstreams: [{ name: "one", url: "http://t3-one.example.com:3773/mcp" }],
  };
  try {
    const bootstrapAuth = createAuth(config, db, { setup: true });
    await (await getMigrations(bootstrapAuth.options)).runMigrations();
    const password = "t".repeat(128);
    await bootstrapAuth.api.signUpEmail({ body: { name: "Owner", email: config.ownerEmail, password } });
    await assert.rejects(bootstrapAuth.api.signUpEmail({ body: { name: "Owner", email: config.ownerEmail, password } }));
    process.env.GATEWAY_BOOTSTRAP = "1";
    const runtimeAuth = createAuth(config, db);
    const signedIn = await runtimeAuth.api.signInEmail({ body: { email: config.ownerEmail, password } });
    assert.equal(signedIn.user.email, config.ownerEmail);
    const login = await runtimeAuth.api.signInEmail({ body: { email: config.ownerEmail, password }, asResponse: true });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const replacement = "n".repeat(128);
    const changed = await runtimeAuth.api.changePassword({ body: { currentPassword: password, newPassword: replacement, revokeOtherSessions: true }, headers: new Headers({ cookie }), asResponse: true });
    assert.equal(changed.ok, true);
    await assert.rejects(runtimeAuth.api.signInEmail({ body: { email: config.ownerEmail, password } }));
    assert.equal((await runtimeAuth.api.signInEmail({ body: { email: config.ownerEmail, password: replacement } })).user.email, config.ownerEmail);
    await assert.rejects(runtimeAuth.api.signUpEmail({ body: { name: "Other", email: "other@example.com", password } }));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user").get() as { n: number }).n, 1);
  } finally {
    delete process.env.GATEWAY_BOOTSTRAP;
    delete process.env.BETTER_AUTH_SECRET;
    db.close();
    rmSync(directory, { recursive: true });
  }
});
