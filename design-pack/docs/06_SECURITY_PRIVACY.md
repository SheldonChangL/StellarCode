# Security & Privacy

## Default posture

StellarCode is local-first. MVP should not upload repository source or graph data anywhere.

## Required controls

- Local HTTP server binds to `127.0.0.1` by default.
- MCP/IPC endpoints are local-user scoped.
- Project DB permissions should follow the current user's private application-data defaults.
- Do not persist secrets extracted from files as summaries or metadata.
- Respect ignore rules for `.env`, credential directories, private keys, and common secret files.
- Do not index binary blobs.
- Do not execute repository code during indexing.

## Secret filtering

At minimum, classify and exclude likely secrets before any optional external summary provider receives content:

- `.env*`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- credential/config paths for common cloud CLIs
- known token patterns through deterministic secret scanning

## Optional AI summaries

If added later:

- off by default;
- provider configured explicitly;
- disclose what content leaves the machine;
- support local-model providers;
- redact secrets before request;
- cache by file hash;
- summaries never determine graph correctness.

## Destructive operations

`stellar gc` and project removal may delete only StellarCode-derived data, never source repositories.
