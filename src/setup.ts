import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "./auth.js";
import type { BridgeConfig } from "./config.js";
import { openState } from "./state.js";

export class OperatorError extends Error {}

export async function setup(config: BridgeConfig, directory: string, envPath = ".env"): Promise<string> {
  if (existsSync(envPath) || process.env.BETTER_AUTH_SECRET) {
    throw new OperatorError("Signing material already exists; setup will not overwrite it.");
  }
  const db = openState(directory);
  try {
    const users = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'").get();
    if (users && (db.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number }).n !== 0) {
      throw new OperatorError("An account already exists; setup will not reset it.");
    }
    const secret = randomBytes(48).toString("base64url");
    const password = randomBytes(96).toString("base64url");
    // Exclusive creation also protects against two operators starting setup at once.
    writeFileSync(envPath, `BETTER_AUTH_SECRET=${secret}\n`, { flag: "wx", mode: 0o600 });
    try {
      const auth = createAuth(config, db, { secret, setup: true });
      await (await getMigrations(auth.options)).runMigrations();
      await auth.api.signUpEmail({ body: { name: "Owner", email: config.ownerEmail, password } });
    } catch {
      throw new OperatorError("Setup failed after saving signing material. Keep .env and state private; see setup recovery documentation before retrying.");
    }
    return password;
  } finally { db.close(); }
}
