# T3 Bridge

Connect multiple T3 Code MCP servers through one authenticated endpoint.

T3 Bridge is intended for people who run more than one T3 Code environment and want one MCP connection for clients such as ChatGPT. Each instance's tools will have a distinct prefix so clients can tell them apart.

## Project status

This repository contains the initial project scaffold. The gateway implementation and installation tooling have not been migrated yet. There is no runnable bridge or installer in this revision.

T3 Bridge is an independent community project and is not affiliated with or endorsed by T3 Code, OpenAI, or ngrok.

## Intended scope

- One authenticated MCP endpoint for multiple T3 Code environments.
- Separate OAuth authorization for each upstream instance.
- Instance prefixes on tool names to avoid collisions.
- One owner account, configured through a file.
- Persistent OAuth credentials stored outside the repository.
- Deployment behind a stable HTTPS endpoint, including ngrok.

T3 remains responsible for its own permissions. A bridge connection must never turn a read-only T3 grant into write access. Each upstream must explicitly approve the actions its tools perform.

## Development

The scaffold uses Node.js 24, pnpm 11.18.0, and TypeScript. The pnpm version is pinned in `package.json`; see the [pnpm installation guide](https://pnpm.io/installation) if it is not installed.

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
```

These commands check and compile the TypeScript scaffold. Automated tests and an application start command will be added with the implementation.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Configuration example

[examples/config.example.json](examples/config.example.json) illustrates the intended configuration using documentation-only hostnames and an example email. It is a design example; the scaffold does not load it yet.

Use local configuration files for real addresses. Keep passwords, ngrok tokens, OAuth credentials, signing keys, databases, and authorization URLs out of commits and issue reports. The repository's ignore rules exclude common local configuration and state files, but they do not replace reviewing a diff before publishing it.

## License

[MIT](LICENSE).
