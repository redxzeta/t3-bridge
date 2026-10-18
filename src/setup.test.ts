import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { setup } from "./setup.js";
import { createAuth } from "./auth.js";
import { openState } from "./state.js";
import type { BridgeConfig } from "./config.js";

const config: BridgeConfig = { publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: "http://127.0.0.1:3773/mcp" }] };

test("setup creates private signing material and one persistent owner, refusing repeat setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-bridge-setup-"));
  const state = join(root, "state"), env = join(root, ".env");
  try {
    const password = await setup(config, state, env);
    assert.equal(password.length, 128);
    const material = readFileSync(env, "utf8");
    const secret = material.trim().split("=")[1]!;
    assert.ok(secret.length >= 32);
    assert.ok(!material.includes(password));
    assert.equal(statSync(env).mode & 0o777, 0o600);
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.equal(statSync(join(state, "gateway.sqlite")).mode & 0o777, 0o600);
    await assert.rejects(setup(config, state, env), /Signing material already exists/);
    assert.equal(readFileSync(env, "utf8"), material);
    const db = openState(state);
    try {
      const auth = createAuth(config, db, { secret });
      assert.equal((await auth.api.signInEmail({ body: { email: config.ownerEmail, password } })).user.email, config.ownerEmail);
      await assert.rejects(setup(config, state, join(root, "other.env")), /account already exists/);
      assert.ok(!existsSync(join(root, "other.env")));
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number }).n, 1);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true }); }
});

test("setup refuses an existing environment file or inherited signing secret", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-bridge-existing-"));
  const previous = process.env.BETTER_AUTH_SECRET;
  try {
    const env = join(root, ".env");
    writeFileSync(env, "# reserved local file\n");
    await assert.rejects(setup(config, join(root, "state"), env), /Signing material already exists/);
    assert.equal(readFileSync(env, "utf8"), "# reserved local file\n");
    process.env.BETTER_AUTH_SECRET = "synthetic-existing-signing-secret-for-test";
    await assert.rejects(setup(config, join(root, "state"), join(root, "other.env")), /Signing material already exists/);
    assert.ok(!existsSync(join(root, "state")));
  } finally {
    if (previous === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previous;
    rmSync(root, { recursive: true });
  }
});

test("credential CLI commands refuse redirected input/output before creating state", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-bridge-terminal-"));
  try {
    for (const command of ["setup", "rotate-password"]) {
      const result = spawnSync(process.execPath, [new URL("./main.js", import.meta.url).pathname, command], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /interactive terminal/);
      assert.equal(result.stdout, "");
      assert.ok(!existsSync(join(root, ".env")));
      assert.ok(!existsSync(join(root, "state")));
    }
  } finally { rmSync(root, { recursive: true }); }
});
