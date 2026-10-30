# Security

T3 Bridge uses a single local owner account, downstream OAuth, and separate upstream OAuth grants. It has not undergone an independent security audit. T3 retains responsibility for its own read/write permissions and operation approvals.

Keep the MCP backend loopback-bound. Use a public HTTPS endpoint or the documented private HTTPS/tunnel setup; restrict private browser access to the trusted LAN/VPN. Plain HTTP upstreams are a trusted-network choice: bearer tokens and tool data are unencrypted on that network. See [the setup guide](docs/setup.md) for credential handling and authorization boundaries.

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/redxzeta/t3-bridge/security/advisories/new). Include a description of the issue, the affected revision, and a minimal reproduction with synthetic data.

Do not file a public issue containing a vulnerability report, passwords, access or refresh tokens, pairing codes, OAuth state, private keys, authorization URLs, logs, or databases from an installation.

## Credential exposure

If a credential is published, revoke or rotate it with its issuer. Deleting a file or rewriting a commit does not invalidate the credential or remove copies others may have made. Avoid posting the credential again when reporting the incident.
