import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "./config.js";

const base = {
  publicUrl: "https://bridge.example.com", listenPort: 8787, ownerEmail: "owner@example.com",
  upstreams: [
    { name: "home", url: "https://t3-one.example.com/mcp" },
    { name: "lab", url: "http://t3-two.example.com:3773/mcp" },
  ],
};
function parse(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "t3-bridge-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(value));
    return loadConfig(path);
  } finally { rmSync(dir, { recursive: true }); }
}
test("accepts HTTP/HTTPS MCP URLs and normalizes the public origin", () => {
  assert.equal(parse(base).upstreams.length, 2);
  assert.equal(parse({ ...base, publicUrl: `${base.publicUrl}/` }).publicUrl, base.publicUrl);
  assert.equal(parse({ ...base, upstreams: [{ name: "local", url: "http://127.0.0.1:3773/mcp" }] }).upstreams.length, 1);
});
test("rejects unsafe or malformed upstream URLs", () => {
  for (const url of ["ftp://t3.example.com/mcp", "https://t3.example.com/", "https://t3.example.com/mcp/", "https://user:pass@t3.example.com/mcp", "https://t3.example.com/mcp?q=1", "https://t3.example.com/mcp#fragment", "https://t3.example.com/mcp?", "https://t3.example.com/mcp#", "invalid"]) {
    assert.throws(() => parse({ ...base, upstreams: [{ name: "one", url }] }));
  }
});
test("rejects duplicate or ambiguous names and invalid configuration", () => {
  assert.throws(() => parse({ ...base, upstreams: [base.upstreams[0], base.upstreams[0]] }));
  for (const name of ["", "Home", "a__b", "trailing_", "x".repeat(32)]) assert.throws(() => parse({ ...base, upstreams: [{ ...base.upstreams[0], name }] }));
  for (const publicUrl of ["http://bridge.example.com", "https://user:pass@bridge.example.com", "https://bridge.example.com/path", "https://bridge.example.com/?q=1", "https://bridge.example.com/#x"]) assert.throws(() => parse({ ...base, publicUrl }));
  assert.throws(() => parse({ ...base, upstreams: [] }));
  assert.throws(() => parse({ ...base, ownerEmail: "invalid" }));
  assert.throws(() => parse({ ...base, listenPort: 0 }));
});

test("private HTTPS binds only a private IP with a distinct unprivileged port and complete TLS paths", () => {
  const privateHttps = { certFile: "cert.crt", keyFile: "key.key" };
  assert.ok(parse({ ...base, publicUrl: "https://127.0.0.1:9443", privateHttps }).privateHttps);
  for (const publicUrl of ["https://bridge.example.com:9443", "https://0.0.0.0:9443", "https://203.0.113.1:9443", "https://127.0.0.1", "https://127.0.0.1:8787"]) {
    assert.throws(() => parse({ ...base, publicUrl, privateHttps }));
  }
  for (const tls of [{ certFile: "a" }, { certFile: "", keyFile: "b" }, { ...privateHttps, listenAddress: "0.0.0.0" }]) {
    assert.throws(() => parse({ ...base, publicUrl: "https://127.0.0.1:9443", privateHttps: tls }));
  }
});

test("published transport examples validate without creating credentials or state", () => {
  const ngrok = loadConfig(fileURLToPath(new URL("../examples/config.example.json", import.meta.url)));
  const tunnel = loadConfig(fileURLToPath(new URL("../examples/private-https.example.json", import.meta.url)));
  assert.equal(ngrok.privateHttps, undefined);
  assert.equal(new URL(ngrok.publicUrl).protocol, "https:");
  assert.ok(tunnel.privateHttps);
  assert.notEqual(new URL(tunnel.publicUrl).port, String(tunnel.listenPort));
  assert.deepEqual(tunnel.upstreams.map((upstream) => upstream.name), ["home", "lab"]);
});
