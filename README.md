# Pi session name

Automatic conversation titles for interactive [Pi](https://github.com/earendil-works/pi) sessions. Works in ordinary terminals by default; TUIOS is not required.

- Names conversations in the background without blocking the main agent.
- Defaults to `openai/gpt-6-luna` through Pi's model registry and credentials.
- Stops automatic changes after a manual rename.
- Optionally synchronizes Pi titles and TUIOS custom window names in both directions.
- Provides `/name-status` for model, lock, request count, token totals, and safe error diagnostics.

## Install

Requires Pi APIs available in version 1.2.0. Older versions have not been verified. Your Pi model registry and authentication must support the configured naming model; there is no automatic model fallback.

```sh
pi install git:github.com/drawde-nadroj/pi-session-name
```

Run `/reload` in an existing Pi session, then `/new` to start an unnamed conversation. Send a message and check `/name-status`.

**Existing local installation:** if you already load `~/.pi/agent/extensions/tuios-session-name.ts`, use either that file or this package, not both. Disable or move the old extension out of the auto-loaded extensions directory before installing the package. Your existing configuration and saved naming state remain compatible.

## Configure

Optional file: `~/.pi/agent/tuios-session-name.json`. When `PI_CODING_AGENT_DIR` is set, the file is read from that directory instead. The historical filename is retained for compatibility; it does not require TUIOS.

Example:

```json
{
  "enabled": true,
  "provider": "openai",
  "model": "gpt-6-luna"
}
```

If that model is unavailable to your account, choose a provider/model pair from your Pi registry. Reload after changing configuration. Invalid or unknown settings disable naming and synchronization until corrected.

| Setting | Default | Accepted values |
| --- | --- | --- |
| `enabled` | `true` | Boolean; `false` disables model calls but retains attached TUIOS manual sync |
| `provider` | `openai` | Nonblank string, at most 2,000 characters |
| `model` | `gpt-6-luna` | Nonblank string, at most 2,000 characters |
| `maxContextChars` | `6000` | Integer, 256–12,000 |
| `maxNameChars` | `60` | Integer, 10–120 |
| `maxOutputTokens` | `160` | Integer, 64–512 |
| `timeoutMs` | `15000` | Integer, 1,000–60,000 milliseconds |
| `instructions` | See below | Nonblank string, at most 2,000 characters |

Default instructions:

> Use a clear, specific title of 3–7 words in the user's language. Keep the current title unless the subject meaningfully changes. Do not include secrets or personal identifiers in titles.

Requests use minimal reasoning. Provider/model combinations must support the request parameters and tool calling.

## Naming and manual control

Each nonblank interactive text input queues a background naming request when naming is enabled and unlocked. Newer inputs invalidate older results. Extension-generated inputs and noninteractive modes (RPC, JSON, print) do not trigger naming.

A manual Pi rename locks automatic naming for that session. Existing named sessions without this extension's matching saved state are also locked conservatively. Locks survive reload and resume, including branches or forks that inherit the saved entries. There is no unlock command; start a new conversation with `/new` for fresh automatic naming.

The model may request one `rename_current_session({name})` call or leave the title unchanged. The host rejects extra tools, extra arguments, control characters, and oversized names. It checks session identity, revision, cancellation, and manual ownership before applying a title.

## Optional TUIOS synchronization

The extension attaches only when all three are present:

- `TUIOS_ENV=1`
- A nonempty `TUIOS_WINDOW_ID`
- A nonempty `TUIOS_SESSION`

Otherwise it starts no TUIOS watcher and makes no TUIOS CLI calls. In attached mode, `tuios` must be available on `PATH` and support `subscribe`, `list-windows --json`, and `set-window`.

Explicit TUIOS custom-name changes lock automatic naming and sync to Pi. Subsequent manual changes sync both ways. OSC terminal-title updates are ignored. On attachment, a conflicting existing custom window name wins conservatively. `/new` clears inherited names instead of importing the previous conversation's window title.

A lost event stream or event gap pauses attached naming and synchronization until `/reload`, protecting manual names. CLI writes are serialized and have three-second timeouts. Shutdown closes the watcher, aborts inference, and drains pending CLI writes.

TUIOS provides neither an origin identifier nor atomic compare-and-set for renames. Fresh reads and reconciliation reduce races but cannot guarantee ownership in every interleaving, particularly when a human rename matches an expected automatic echo.

## Privacy and cost

The naming provider receives the current title and up to 12 recent user-message excerpts, bounded to `maxContextChars`. Images, assistant responses, tool output, files, and authentication credentials are not added to naming context. **Secrets typed into user messages can still be included in those excerpts.** The instruction to avoid secrets in titles is not a redaction guarantee.

These excerpts and usage counters are stored as custom entries in the Pi session file. Background requests can incur provider charges. `/name-status` reports returned token usage; aborted requests can incur usage that the provider does not return.

The naming model has no general Pi tools or shell access. The extension itself runs with Pi's normal OS permissions; it is not sandboxed.

## Development and verification

Tests require Node.js 22.18+ with native TypeScript type stripping (tested on Node.js 26.7.0):

```sh
npm test
```

The 26 offline tests cover standalone naming without TUIOS, incomplete environments, manual-rename races, resume, `/new`, disabled/noninteractive modes, bounded context, validation, diagnostics, and attached TUIOS synchronization. Model responses, CLI operations, and event streams are mocked. This suite does not verify live provider access or a live TUIOS rename cycle.

The source filename and state key retain their historical TUIOS names for existing installations. The package ships only the naming extension; no startup naming prompt is included.
