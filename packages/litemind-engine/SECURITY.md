# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ current development version |

## Reporting a vulnerability

Please report security problems **privately** (do not open a public issue with exploit
details): describe the version, steps to reproduce, and the impact. The maintainer will
confirm receipt and discuss a fix before anything is published.

## Security model (summary)

- The API server listens on **127.0.0.1 only** by default. LAN exposure requires an
  explicit `api.allowLan: true` **and** a configured token; the config validator refuses
  `allowLan` without auth.
- LiteMind contains **no secrets**, no API keys, no telemetry, and makes **no
  outbound internet requests**.
- Models and Ollama are never downloaded automatically.
- Foreign Windows processes are never terminated; stopping generation closes only
  LiteMind's own HTTP connection to the local backend.
- Logs contain technical events only — prompts and answers are not written to disk.
- User configuration lives in `%APPDATA%\LiteMind\` (outside the install folder) and is
  not removed by default when uninstalling.

Детали по-русски: [docs/SECURITY.md](docs/SECURITY.md).
