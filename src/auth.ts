import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { BridgeConfig } from "./config.js";
import type { State } from "./state.js";

// The HTTP adapter overwrites this value from the socket; callers cannot select a limiter bucket.
export const PEER_IP_HEADER = "x-t3-bridge-peer-ip";

export function createAuth(config: BridgeConfig, db: State, options: { secret?: string; setup?: boolean } = {}) {
  const secret = options.secret ?? process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Better Auth secret is required");
  const allowed = config.ownerEmail.toLowerCase();
  return betterAuth({
    baseURL: `${config.publicUrl}/api/auth`,
    secret,
    database: db,
    // Setup runs migrations before the first account operation. Runtime validates normally.
    advanced: {
      ipAddress: { ipAddressHeaders: [PEER_IP_HEADER] },
      ...(options.setup ? { database: { validateSchema: false } } : {}),
    },
    emailAndPassword: { enabled: true, disableSignUp: options.setup !== true, minPasswordLength: 16, maxPasswordLength: 128 },
    rateLimit: { enabled: true, storage: "database", customRules: { "/sign-in/email": { window: 60, max: 5 } } },
    databaseHooks: {
      user: {
        create: { before: async (user) => options.setup === true && user.email.toLowerCase() === allowed
          && (db.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number }).n === 0 },
        update: { before: async (user) => user.email === undefined || user.email.toLowerCase() === allowed },
      },
    },
    plugins: [
      jwt(),
      mcp({ loginPage: "/sign-in", consentPage: "/consent", resource: `${config.publicUrl}/mcp`, scopes: ["openid", "profile", "email", "offline_access", "mcp:tools"] }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  });
}
