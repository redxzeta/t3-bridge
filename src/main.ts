import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";
import { openState } from "./state.js";
import { createAuth } from "./auth.js";
import { createBridge } from "./server.js";
import { setup, OperatorError } from "./setup.js";
import { Upstreams } from "./upstream.js";

process.umask(0o077);

function requireTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new OperatorError("Credential commands require an interactive terminal with no output redirection.");
  }
}

async function currentPassword(): Promise<string> {
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  // Enable terminal raw mode before announcing readiness for a paste.
  process.stdout.write("Current T3 Bridge password (hidden): ");
  try { return await input.question(""); }
  finally { input.close(); process.stdout.write("\n"); }
}

async function main() {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const command = args[0] ?? "start";
  if (!["setup", "start", "link", "rotate-password"].includes(command)) throw new OperatorError("Usage: setup | start | link <instance> | rotate-password");
  if (command === "setup" || command === "rotate-password") requireTerminal();
  const config = loadConfig(process.env.T3_BRIDGE_CONFIG ?? "config.json");
  const directory = process.env.T3_BRIDGE_STATE_DIR ?? "state";
  if (command === "setup") {
    const password = await setup(config, directory);
    console.log(`Owner created. Save this T3 Bridge password now (shown once): ${password}`);
    return;
  }
  const db = openState(directory);
  if (command === "start") {
    try {
      const bridge = createBridge(config, db);
      bridge.server.on("error", () => { console.error("T3 Bridge could not listen; check the configured port."); db.close(); process.exitCode = 1; });
      bridge.server.listen(config.listenPort, "127.0.0.1", () => console.log(`T3 Bridge listening on loopback port ${config.listenPort}`));
      const stop = () => bridge.server.close(() => {
        void bridge.upstreams.close().finally(() => { db.close(); process.exit(0); });
      });
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    } catch (error) { db.close(); throw error; }
    return;
  }
  try {
    if (command === "link") {
      if (!args[1]) throw new OperatorError("Usage: pnpm run link -- <instance>");
      console.log((await new Upstreams(config, db).startAuthorization(args[1])).href);
      return;
    }
    const password = await currentPassword();
    const auth = createAuth(config, db);
    const login = await auth.api.signInEmail({ body: { email: config.ownerEmail, password }, asResponse: true });
    if (!login.ok) throw new OperatorError("Current password is incorrect.");
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new OperatorError("Sign-in did not issue a session cookie.");
    const newPassword = randomBytes(96).toString("base64url");
    const changed = await auth.api.changePassword({ body: { currentPassword: password, newPassword, revokeOtherSessions: true }, headers: new Headers({ cookie }), asResponse: true });
    if (!changed.ok) throw new OperatorError("Password change failed.");
    console.log(`Save this new T3 Bridge password now (shown once): ${newPassword}`);
  } finally { db.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof OperatorError ? error.message : "T3 Bridge command failed. Check configuration, initialization, and upstream availability; keep local diagnostics private.");
  process.exitCode = 1;
});
