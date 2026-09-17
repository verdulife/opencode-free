# opencode-free

[Pi](https://pi.dev) provider for [OpenCode Zen](https://opencode.ai/docs/zen) free models — no API key, no login, no local opencode CLI needed.

## What it does

Registers an `opencode` provider in Pi that talks directly to the OpenCode Zen gateway (`https://opencode.ai/zen/v1`). Free models work without any authentication.

## Available models

| Model | Context | Reasoning | Multimodal |
|---|---|---|---|
| `big-pickle` | 200K | ✓ | text |
| `nemotron-3.5-lightning-free` | 262K | ✓ | text |
| `nemotron-3-ultra-free` | 1M | ✓ | text |
| `ling-3.0-flash-fin-free` | 262K | ✓ | text |
| `muse-spark-1.2-contributor-free` | 1M | ✓ | text, image |
| `mimo-v2.5-free` | 200K | ✓ | text, image, audio, video |

Use them as `opencode/big-pickle`, `opencode/nemotron-3-ultra-free`, etc.

> OpenCode updates its free model roster frequently. Use `/opencode-pi refresh` to update the list.

## Install

```bash
# From git (recommended):
pi install git:github.com/YOUR_USERNAME/opencode-free

# From npm (if published):
pi install npm:opencode-free

# Local / development:
pi install ./path/to/opencode-free
```

Then `/reload` in Pi (or restart).

## Commands

```text
/opencode-pi refresh   Update models + CLI version from catalog
/opencode-pi models    List registered free models
/opencode-pi version   Show CLI version used in client headers
```

## How it works

The Zen gateway applies strict rate limits to requests without the official client fingerprint (`x-opencode-*` headers, `User-Agent: opencode/...`). This extension replicates the opencode CLI's request headers so anonymous usage behaves the same way as the CLI.

See [anomalyco/opencode `session/llm/request.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm/request.ts) for reference.

## License

MIT
