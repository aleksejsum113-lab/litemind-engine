# LiteMind Engine (English, short version)

Lightweight **local** engine for running small AI models on weak Windows PCs
(8–16 GB RAM, integrated graphics). Free, no paid APIs, no cloud, no telemetry.

LiteMind does **not** compute neural networks itself: it manages resources and talks to an
existing local backend (currently **Ollama** via its HTTP API). All the safety policy —
queue, memory forecast, timeouts, cancellation, model unloading — lives in LiteMind.

Full documentation is in Russian: see [README.md](README.md) and [docs/](docs/).

## Quick start

Requirements: [Node.js](https://nodejs.org) 18.17+ (only dependency — `npm install` is not needed).
Ollama is optional: without it the engine and dashboard still run, generation returns a clear error.

```powershell
.\scripts\doctor.ps1      # system + Ollama diagnostics (read-only)
.\scripts\start.ps1       # start engine + dashboard at http://127.0.0.1:8399
.\scripts\stop.ps1        # graceful stop
.\scripts\test.ps1        # run the test suite (mock backend, no models, ~3 s)
```

## What it does

- Detects installed Ollama and local models.
- **Low Resource profile by default**: 1 request at a time, 2048-token context, short
  answers, CPU thread cap, automatic unload after idle.
- **Memory forecast before start**: model weights + KV cache + Windows reserve; refuses
  to start a model that does not fit, with an explanation.
- Full cancellation (button, API, client disconnect) and timeouts.
- Local **OpenAI-compatible API** for OpenCode and other tools: `/v1/models`,
  `/v1/chat/completions` (streaming SSE), `/health`.
- Lightweight dashboard — one browser tab, no Electron, no background services.
- Diagnostics: JSONL log, TTFT / tokens-per-second metrics.

## Tests

```powershell
npm test     # 61 tests, mock Ollama server, no models downloaded or run
```

## Limitations

- Windows 10 22H2+ / 11, x64. Real-model benchmarks are **not yet measured** on the
  reference machine — see [docs/BENCHMARKS.md](docs/BENCHMARKS.md); empty cells mean
  "not measured", not "fast".
- Ollama and models are installed by the user, manually, never automatically.
- LAN exposure is off by default and requires an explicit config + token.

## License

MIT — see [LICENSE](LICENSE). Third-party components and their licenses are listed in
[README.md](README.md).
