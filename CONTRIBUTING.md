# Contributing to T3 Bridge

The project is currently a scaffold. Open an issue to discuss a bug or a proposed feature before making a substantial change.

## Local development

Use Node.js 24 and pnpm 11.18.0, as pinned in `package.json`. Install the locked dependencies with `pnpm install --frozen-lockfile`, then run `pnpm run check` and `pnpm run build`. Commit dependency changes in `pnpm-lock.yaml`.

There are no automated application tests yet. When adding behavior, include focused tests that exercise observable outcomes. Use synthetic fixtures and disposable local state.

## Pull requests

- Keep the change focused on the issue it addresses.
- Explain the problem, the resulting behavior, and how you checked it.
- Preserve upstream OAuth permission boundaries.
- Use example hostnames and synthetic accounts in documentation and fixtures.
- Inspect the complete staged diff for credentials, personal addresses, local paths, logs, databases, OAuth state, and authorization URLs before pushing.

Do not copy configuration or state from a running installation into this repository. Report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md).
