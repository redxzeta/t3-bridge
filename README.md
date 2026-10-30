# T3 Bridge

Connect multiple T3 Code MCP servers through one authenticated endpoint. Tools keep an instance prefix, such as `home__list_projects` or `lab__list_projects`.

T3 Bridge is a single-user application: one configured password account, downstream OAuth for MCP clients, and separate upstream OAuth grants with PKCE. SQLite persists accounts, grants, and upstream tokens. T3 remains responsible for read/write permissions and approval of operations.

## Install and connect

Use Node.js 24 and pnpm 12.14.0 on Linux or macOS. Windows uses WSL2 and the Linux instructions. The primary compiler is the experimental [tsc-ts 0.0.2](https://github.com/vercel-labs/tsc-ts); installation needs its matching optional native package. There is no source-build toolchain or fallback compiler.

```sh
git clone https://github.com/redxzeta/t3-bridge.git
cd t3-bridge
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
cp examples/config.example.json config.json
# Edit config.json with your public HTTPS origin, owner email, and upstreams.
pnpm run setup
pnpm start
```

Save the password shown by setup in your password manager. Setup and password rotation require an interactive terminal; do not redirect or record their output.

Continue with the complete [setup guide](docs/setup.md) to start ngrok, authorize each upstream, and connect your MCP client. It also covers platform prerequisites, optional Linux systemd operation, Proxmox, restart, and troubleshooting.

For a private ChatGPT route, see the [Secure MCP Tunnel migration runbook](docs/secure-mcp-tunnel.md). Authentication compatibility and ChatGPT execution must be verified before production cutover.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm test
```

Tests use synthetic accounts, disposable state, and local mock upstreams. See [CONTRIBUTING.md](CONTRIBUTING.md) for publication checks and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

Manual Linux and macOS installation is documented; Windows support is through WSL2. Platform execution results are recorded in the migration PR. Native Windows, automatic container provisioning, Docker packaging, a management UI, additional login providers, package releases, and automated deployment are deferred. npm publishing is disabled.

T3 Bridge is an independent community project, unaffiliated with T3 Code, OpenAI, or ngrok. Licensed under [MIT](LICENSE).
