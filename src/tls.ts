import { readFileSync } from "node:fs";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { createSecureContext, type SecureContextOptions } from "node:tls";
import type { BridgeConfig } from "./config.js";

export class TlsConfigurationError extends Error {}

export function privateTlsOptions(config: BridgeConfig): SecureContextOptions | undefined {
  if (!config.privateHttps) return undefined;
  try {
    const cert = readFileSync(config.privateHttps.certFile);
    const key = readFileSync(config.privateHttps.keyFile);
    const leaf = new X509Certificate(cert);
    const now = Date.now();
    if (now < Date.parse(leaf.validFrom) || now >= Date.parse(leaf.validTo)) throw new Error();
    if (!leaf.checkIP(new URL(config.publicUrl).hostname) || !leaf.checkPrivateKey(createPrivateKey(key))) throw new Error();
    createSecureContext({ cert, key, minVersion: "TLSv1.2" });
    return { cert, key, minVersion: "TLSv1.2" };
  } catch {
    throw new TlsConfigurationError("privateHttps: certificate/key must be readable, valid for the origin IP, unexpired, and matching");
  }
}
