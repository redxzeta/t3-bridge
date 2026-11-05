# T3 Bridge

Connect multiple T3 Code MCP servers through one authenticated endpoint. Tools keep an instance prefix, such as `home__list_projects` or `lab__list_projects`.

T3 Bridge is a single-user application: one configured password account, downstream OAuth for MCP clients, and separate upstream OAuth grants with PKCE. SQLite persists accounts, grants, and upstream tokens. T3 remains responsible for read/write permissions and approval of operations.

## Install and connect

Use Node.js 24 and pnpm 12.14.0 on Linux or macOS. Windows uses WSL2 and the Linux instructions. The primary compiler is the experimental [tsc-ts 0.1.2](https://github.com/vercel-labs/tsc-ts); installation needs its matching optional native package. There is no source-build toolchain or fallback compiler.

```sh
git clone https://github.com/redxzeta/t3-bridge.git
cd t3-bridge
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
# Choose one example; use private-https.example.json for Secure MCP Tunnel.
cp examples/config.example.json config.json
# Edit the HTTPS origin, owner email, and upstreams for your chosen route.
pnpm run setup
pnpm start
```

Save the password shown by setup in your password manager. Setup and password rotation require an interactive terminal; do not redirect or record their output.

Choose either transport and follow the [complete setup guide](docs/setup.md):

| Transport | Bridge origin | Requirements |
| --- | --- | --- |
| ngrok | Assigned public HTTPS origin, forwarding to the loopback bridge | An ngrok account and available endpoint quota |
| OpenAI Secure MCP Tunnel | Real private HTTPS origin, reached by tunnel-client | Platform/workspace tunnel access, a stable private IP, private-CA trust, and LAN/VPN browser access |

Both use the same owner OAuth, upstream grants, tool prefixes, and T3 approvals. Choose one per installation; there is no automatic fallback. The [tunnel runbook](docs/secure-mcp-tunnel.md) covers authentication proof, systemd credentials, limits, migration, and rollback. Switching the OAuth origin requires reviewing existing connections rather than resetting state.

The HTTP adapter derives login throttling from the socket peer and caps authentication bodies at 64 KiB. MCP payloads retain their separate SDK limits. Plain HTTP upstreams remain a trusted-LAN risk, and automatic refresh must be verified for the actual client grant.

For ChatGPT setup, explicitly request `offline_access` in **Base scopes** when that field is available, retaining `mcp:tools`. See [OAuth setup and reconnect troubleshooting](docs/chatgpt-oauth.md) for the personal/workspace UI differences, private-network browser access, and a post-expiry acceptance check.

Agents can use the repository's [setup skill](.agents/skills/t3-bridge-setup/SKILL.md), [connection diagnosis skill](.agents/skills/t3-bridge-diagnose/SKILL.md), and [publication skill](.agents/skills/t3-bridge-publish/SKILL.md). [AGENTS.md](AGENTS.md) describes repository conventions and operational boundaries.

## Bridge status and partial outages

The OAuth-protected, read-only `bridge_status` MCP tool reports only this bridge's observed connection/discovery state, timestamps, catalog freshness/cache fallback, and sanitized failure categories. It never invokes native T3 tools or repairs an upstream. Unknown and cached data are explicit; discovery success does not establish permission or completed work.

Serving discovers hosts concurrently within a shared five-second budget. Requests share in-flight discovery; successful catalogs can be reused for 30 seconds and failures for five seconds without polling. A hung host cannot suppress a healthy host's prefixed tools or the local status tool. These discovery deadlines do not limit native tool-call duration. See [behavior, boundaries, and source comparisons](docs/setup.md#bridge-status-and-partial-outages).

## On-demand upstream diagnostics

After building, run `pnpm run doctor` from the same checkout and OS account as the bridge. It uses `.env`, `T3_BRIDGE_CONFIG` (default `config.json`), and `T3_BRIDGE_STATE_DIR` (default `state`). It needs no bridge signing secret and does not start an HTTP listener.

The command connects to each configured upstream and lists tools with a 15-second deadline per upstream. It never invokes tools, starts sign-in, registers an OAuth client, or treats cached tools as success. Existing OAuth grants may be refreshed and rotated tokens saved. Refresh coordination is per process; avoid running diagnostics concurrently with a serving process when both would refresh the same grant.

Stdout contains one JSON object, for example:

```json
{"upstreams":[{"name":"home","status":"ok","toolCount":12},{"name":"lab","status":"sign_in_required","reason":"Upstream sign-in required"}]}
```

Statuses are `ok`, `sign_in_required`, `unavailable`, and `error`. Successful checks include `toolCount`; failures include a sanitized `reason`. Exit codes are `0` when all upstreams succeed, `1` for upstream failures, and `2` for configuration or startup errors. Startup errors emit `{"status":"error","reason":"Bridge configuration or startup failed"}`. Results exclude tokens, URLs, tool arguments, and upstream response bodies.

A running bridge or tunnel does not prove upstream discovery, downstream OAuth renewal, or an end-to-end tool call. Normal serving retains cached tools during discovery failures; its fallback log records the failure category and whether a cache was available. Diagnostics introduce no service or schedule.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm test
```

`pnpm test` builds the current sources before running tests.

CI runs the pinned Linux validation, production dependency audit, and a separate full-history redacted secret scan. It never deploys or publishes packages. Tests use synthetic accounts, disposable state, and local mock upstreams. See [CONTRIBUTING.md](CONTRIBUTING.md) for publication checks and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

Manual Linux and macOS installation is documented; Windows support is through WSL2. Platform execution results are recorded in the migration PR. Native Windows, automatic container provisioning, Docker packaging, a management UI, additional login providers, package releases, and automated deployment are deferred. npm publishing is disabled.

T3 Bridge is an independent community project, unaffiliated with T3 Code, OpenAI, or ngrok. Licensed under [MIT](LICENSE).
