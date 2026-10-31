# Security

T3 Bridge uses a single local owner account, downstream OAuth, and separate upstream OAuth grants. It has not undergone an independent security audit. T3 retains responsibility for its own read/write permissions and operation approvals.

Keep the MCP backend loopback-bound. Use a public HTTPS endpoint or the documented private HTTPS/tunnel setup; restrict private browser access to the trusted LAN/VPN. Plain HTTP upstreams are a trusted-network choice: bearer tokens and tool data are unencrypted on that network. See [the setup guide](docs/setup.md) for credential handling and authorization boundaries.

## HTTP boundary

The Node adapter overwrites an internal peer-IP header from the socket and configures auth throttling to use only that value. Caller-supplied forwarded IP claims cannot select login buckets. IP attribution does not establish authentication. Login permits five attempts per minute per peer; tunnel traffic may share a local peer.

Authentication requests under `/api/auth` are capped at 64 KiB before parsing, counting streamed bytes as well as declared lengths. Oversized requests return 413 and close the connection. MCP tool payloads use the SDK's separate bounds. Keep the listener private or behind the selected authenticated transport; neither transport removes T3's permissions or approvals.

Production dependencies are audited in CI for high/critical advisories. CI and this source review are not an independent audit. Automatic refresh must be verified for the actual client's grant; lack of a refresh token can require LAN/VPN browser reauthentication in the private setup.

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/redxzeta/t3-bridge/security/advisories/new). Include a description of the issue, the affected revision, and a minimal reproduction with synthetic data.

Do not file a public issue containing a vulnerability report, passwords, access or refresh tokens, pairing codes, OAuth state, private keys, authorization URLs, logs, or databases from an installation.

## Credential exposure

If a credential is published, revoke or rotate it with its issuer. Deleting a file or rewriting a commit does not invalidate the credential or remove copies others may have made. Avoid posting the credential again when reporting the incident.
