# opencode-free

[Pi](https://pi.dev) provider for [OpenCode Zen](https://opencode.ai/docs/zen) free models — no API key, no login, no local opencode CLI needed.

## What it does

Registers an `opencode` provider in Pi that talks directly to the OpenCode Zen gateway (`https://opencode.ai/zen/v1`).

## Requirements

None:

- **No account.** The provider registers itself with the anonymous public key; you never log in.
- **No `opencode` CLI or desktop app.** The extension only replicates the CLI's request headers. Nothing is executed or read from an opencode installation.
- **No other Pi package.** A bare agent directory with this extension loaded can use the free models.

> The client fingerprint is synthesized locally (see [How it works](#how-it-works)). It is a spoof of the official CLI, so if OpenCode tightens the gateway the free tier can stop working for every third-party client. That risk lives in the gateway, not in this extension.

## Install

```bash
pi install git:github.com/verdulife/opencode-free
```

Then `/reload` in Pi (or restart).

## Available models

Only cost-0, non-deprecated catalog entries are registered. The list refreshes itself
(see [Model list updates](#model-list-updates)); these are the built-in fallbacks,
verified against the live gateway on 2026-10-08:

| Model | Context | Reasoning | Multimodal |
|---|---|---|---|
| `big-pickle` | 200K | yes | text |
| `nemotron-3-ultra-free` | 1M | yes | text |
| `nemotron-3.5-lightning-free` | 262K | yes | text |
| `longcat-2.5-preview-free` | 1M | yes | text, image |
| `space-bunny-free` | 1M | yes | text, image |
| `mimo-v2.6-flash-free` | 200K | yes | text, image |

Use them as `opencode/big-pickle`, `opencode/nemotron-3-ultra-free`, etc. Free models
appear and disappear on OpenCode's side; availability can also be region-dependent.

## Commands

```text
/opencode-pi refresh   Update models + CLI version from the catalog now
/opencode-pi models    List the registered free models
/opencode-pi version   Show the CLI version used in the fingerprint
```

## Model list updates

Three layers, no user action required:

1. **`refreshModels`** — Pi's own provider hook. Pi calls it while refreshing model
   catalogs and replaces the registered models with the returned list.
2. **Stale-cache refresh** — on load, if the cached catalog is older than 12 hours, it is
   refreshed in the background. Startup never waits for the network.
3. **`/opencode-pi refresh`** — on demand. This one also keeps the model currently in use
   even if the catalog dropped it.

The catalog is cached in `~/.cache/opencode-pi/models.json` and read at load, so an
offline start still has the last known list. A failed fetch never empties the list.

## Compaction on the free tier

Pi's own compaction and branch-summary requests are rejected by the free tier with
`403 FreeTierError`, so the extension produces those summaries itself and hands them back to
Pi through `session_before_compact` and `session_before_tree`. That covers automatic
compaction (context threshold and overflow), manual `/compact`, and branch summaries.

If the extension's summarization fails — the gateway changes, the request times out, the
network drops, or the user aborts — the extension notifies and yields. Pi then runs its own
attempt and fails the way it used to, so a failure never leaves the session worse off than
before.

Because that gate is an undocumented check rather than a published contract, treat it as
something that can change without notice. The tests pin the shape the extension relies on;
when `node --test` fails there, the request shape needs revisiting.

## How it works

The Zen free tier only answers requests that look like they come from the official
OpenCode client. Three things are required:

| Header | Value |
|---|---|
| `user-agent` | `opencode/<version>`, version read from npm (falls back to a pinned default) |
| `x-opencode-client` | `cli` |
| `x-opencode-session` / `x-opencode-request` | opencode EIDs: `<prefix>_<12 hex chars><14 chars from a 62-char alphabet>` |

Pi is one of the rejected clients: for any model whose provider is `opencode` or
`opencode-go`, or whose base URL host is `opencode.ai`, Pi adds `x-opencode-client: pi`
plus its own session id. Registering this provider replaces those headers, but that
replacement only applies while this registration is the effective provider config for a
request. So the extension also enforces the fingerprint per request in
`before_provider_headers`: when an outgoing request carries Pi's own identity, or a
session id that is not an EID, it is rewritten into the CLI fingerprint. Requests to any
other provider are never touched, and `x-opencode-request` is minted per request the way
the CLI does. Session names are percent-encoded down to printable ASCII before they reach a
header, because not every header value survives the trip.

### Request shape

The gateway also inspects the body. Measured against the live gateway, a request is accepted
only when the body carries `stream: true` **and** a `tools` array containing tools named
exactly `read` and `bash` — the names are case-sensitive and nothing else about those entries
is read (descriptions and parameter schemas are ignored).

Pi's normal turns satisfy this, which is why they always worked; its summarization requests
carry neither `tools` nor `stream`, which is why compaction used to fail. Everything else the
failing requests differed in — size, system prompt, message count, `max_completion_tokens`,
`reasoning_effort`, `stream_options`, header order, User-Agent version, HTTP/1.1 vs HTTP/2 —
makes no difference.

The extension cannot patch that body: `before_provider_request` never fires for summarization
calls (`before_provider_headers` does). Hence a summarization of its own, with the shape the
gate requires.

Reference: [anomalyco/opencode `session/llm/request.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm/request.ts).

## Development

```bash
node --test        # Node 22+ runs the TypeScript tests directly
```

The tests cover the EID shape, the per-request fingerprint guard (including "never touch
another provider"), catalog mapping, and the compaction machinery: the gate-required request
shape, the streaming parser, message serialization, file tracking and the prompts mirrored
from Pi.

## License

MIT
