import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { request } from "node:https";
import test from "node:test";
import { checkServerIdentity } from "node:tls";
import { createAuth } from "./auth.js";
import { getMigrations } from "better-auth/db/migration";
import type { BridgeConfig } from "./config.js";
import { createBridge } from "./server.js";
import { openState } from "./state.js";
import { privateTlsOptions } from "./tls.js";
import { readFileSync } from "node:fs";

function certificate(root: string, name: string, ip = "127.0.0.1") {
  const certFile = join(root, `${name}.crt`), keyFile = join(root, `${name}.key`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=Synthetic bridge test", "-addext", `subjectAltName=IP:${ip}`, "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  return { certFile, keyFile };
}
async function listener() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { server, port: address.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
const base = { listenPort: 0, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: "http://127.0.0.1:3773/mcp" }] };

test("TLS rejects unreadable, malformed, mismatched, wrong-IP and expired material", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-bridge-tls-invalid-"));
  try {
    const a = certificate(root, "a"), b = certificate(root, "b"), wrongIp = certificate(root, "other", "127.0.0.2");
    const expired = join(root, "expired.crt");
    execFileSync("openssl", ["x509", "-in", a.certFile, "-signkey", a.keyFile, "-days", "-1", "-out", expired], { stdio: "ignore" });
    const malformed = join(root, "invalid.crt"); writeFileSync(malformed, "invalid");
    for (const privateHttps of [
      { ...a, certFile: join(root, "missing.crt") }, { ...a, keyFile: join(root, "missing.key") },
      { ...a, keyFile: b.keyFile }, wrongIp, { ...a, certFile: expired }, { ...a, certFile: malformed },
    ]) assert.throws(() => privateTlsOptions({ ...base, publicUrl: "https://127.0.0.1:9443", privateHttps }), /privateHttps:/);
    assert.ok(privateTlsOptions({ ...base, publicUrl: "https://127.0.0.1:9443", privateHttps: a }));
    assert.equal(privateTlsOptions({ ...base, publicUrl: "https://bridge.example.com" }), undefined);
  } finally { rmSync(root, { recursive: true }); }
});

test("private HTTPS validates TLS, rejects bad Host and bearer, and closes both listeners", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-bridge-tls-"));
  const reservation = await listener(); const port = reservation.port; await reservation.close();
  const privateHttps = certificate(root, "server");
  const config: BridgeConfig = { ...base, publicUrl: `https://127.0.0.1:${port}`, privateHttps };
  const db = openState(join(root, "state"));
  const previous = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = "synthetic-test-secret-".repeat(3);
  const initializer = createAuth(config, db, { setup: true });
  await (await getMigrations(initializer.options)).runMigrations();
  const bridge = createBridge(config, db);
  const call = (path: string, headers: Record<string, string> = {}, method = "GET") => new Promise<number>((resolve, reject) => {
    const req = request(`${config.publicUrl}${path}`, { method, ca: readFileSync(privateHttps.certFile), checkServerIdentity: (_host, cert) => checkServerIdentity("127.0.0.1", cert), headers, agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.end();
  });
  try {
    await bridge.start();
    const address = bridge.server.address(); assert.ok(address && typeof address !== "string");
    config.listenPort = address.port;
    assert.equal(await call("/sign-in"), 200);
    assert.equal(await call("/sign-in", { host: `127.0.0.1:${config.listenPort}` }), 400);
    assert.equal(await call("/sign-in", { host: "untrusted.example.com" }), 400);
    assert.equal(await call("/mcp", {}, "POST"), 401);
    assert.equal(await call("/mcp", { authorization: "Bearer invalid-synthetic-token" }, "POST"), 401);
    assert.equal(bridge.server.listening, true);
    assert.equal(bridge.httpsServer?.listening, true);
    await bridge.close();
    assert.equal(bridge.server.listening, false);
    assert.equal(bridge.httpsServer?.listening, false);
  } finally {
    await bridge.close(); db.close();
    if (previous === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previous;
    rmSync(root, { recursive: true });
  }
});

test("a private HTTPS bind failure rolls back the HTTP listener", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-bridge-tls-bind-"));
  const busy = await listener(); const db = openState(join(root, "state"));
  const previous = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = "synthetic-bind-secret-".repeat(3);
  const config = { ...base, publicUrl: `https://127.0.0.1:${busy.port}`, privateHttps: certificate(root, "server") };
  const initializer = createAuth(config, db, { setup: true });
  await (await getMigrations(initializer.options)).runMigrations();
  const bridge = createBridge(config, db);
  try {
    await assert.rejects(bridge.start(), /could not bind/);
    assert.equal(bridge.server.listening, false);
    assert.equal(bridge.httpsServer?.listening, false);
  } finally {
    await bridge.close(); db.close(); await busy.close();
    if (previous === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previous;
    rmSync(root, { recursive: true });
  }
});
