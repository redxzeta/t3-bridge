import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "./auth.js";
import { createBridge } from "./server.js";
import { openState } from "./state.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t3-http-security-"));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  const tlsPort = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const certFile = join(root, "server.crt"), keyFile = join(root, "server.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=Synthetic bridge test", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  const config = { publicUrl: `https://127.0.0.1:${tlsPort}`, listenPort: 0, privateHttps: { certFile, keyFile }, ownerEmail: "owner@example.com", upstreams: [{ name: "home", url: "http://127.0.0.1:3773/mcp" }] };
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = "synthetic-http-security-".repeat(3);
  const db = openState(join(root, "state"));
  const initializer = createAuth(config, db, { setup: true });
  await (await getMigrations(initializer.options)).runMigrations();
  await initializer.api.signUpEmail({ body: { name: "Owner", email: config.ownerEmail, password: "synthetic-owner-password" } });
  const bridge = createBridge(config, db);
  await bridge.start();
  const httpAddress = bridge.server.address(); assert.ok(httpAddress && typeof httpAddress !== "string");
  config.listenPort = httpAddress.port;
  const call = (protocol: "http" | "https", body: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = `${protocol}://127.0.0.1:${protocol === "https" ? tlsPort : config.listenPort}/api/auth/sign-in/email`;
    const options: RequestOptions & { ca?: Buffer } = { method: "POST", agent: false, headers: { origin: config.publicUrl, "content-type": "application/json", ...headers }, ...(protocol === "https" ? { ca: readFileSync(certFile) } : {}) };
    const req = (protocol === "https" ? httpsRequest : httpRequest)(url, options, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: text }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("Synthetic request timed out")));
    req.on("error", reject); req.end(body);
  });
  return { config, db, bridge, call, async close() {
    await bridge.close(); db.close();
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previousSecret;
    rmSync(root, { recursive: true });
  } };
}

test("HTTP and HTTPS login limits use the socket peer despite forged IP headers", async () => {
  for (const protocol of ["http", "https"] as const) {
    const f = await fixture();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const claimedIp = `198.51.100.${i + 1}`;
        const response = await f.call(protocol, JSON.stringify({ email: f.config.ownerEmail, password: "synthetic-wrong-password" }), {
          "x-forwarded-for": claimedIp, "x-real-ip": claimedIp, "cf-connecting-ip": claimedIp, "x-t3-bridge-peer-ip": claimedIp,
        });
        statuses.push(response.status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429], protocol);
    } finally { await f.close(); }
  }
});
