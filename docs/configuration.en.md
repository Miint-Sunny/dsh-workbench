# Preset configuration

[中文](configuration.md) · [Back to README](../README.en.md)

The full package provides Code mode and Full mode, using the tools from the current DSH App's Standard mode. Code mode loads some tools on demand; Full mode includes all tool definitions from the first request. The smaller packages do not provide these presets.

## Basic configuration

Configure the preset row on the Plugins page, or address its row ID in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-workbench-presets
  config:
    locale: en
    configFile: /absolute/path/lsp.json
    mcpConfigFile: /absolute/path/mcp.json
```

`locale` accepts `zh` or `en`. When omitted, it follows the DSH interface language, falling back to the system language when unavailable. Both file paths are optional. Paths must be absolute; `~` and environment variables are not expanded. Configuration files are read only and remain unchanged.

When LSP or MCP is unavailable, both base presets remain available and their descriptions show why an optional component is disabled.

## LSP

LSP requires `@deepseek-ai/dsh-lsp`, `@deepseek-ai/dsh-lsp-stdio` and `@deepseek-ai/dsh-tool-lsp` at exactly the current App version, plus a language server that you provide. Workbench does not scan your home directory or download servers.

Fully quit DSH, then use the App-bundled `dsh`. Replace `<DSH-version>` with the full App version, including its rc suffix:

```sh
dsh plugin --profile desktop add --save-exact \
  "@deepseek-ai/dsh-lsp@<DSH-version>" \
  "@deepseek-ai/dsh-lsp-stdio@<DSH-version>" \
  "@deepseek-ai/dsh-tool-lsp@<DSH-version>"
```

The JSON file referenced by `configFile` has this format. All three paths must point to files, not directories:

```json
{
  "lsp": {
    "nodePath": "/absolute/path/to/node",
    "serverPath": "/absolute/path/to/typescript-language-server/lib/cli.mjs",
    "typescriptPath": "/absolute/path/to/typescript/lib/tsserver.js"
  }
}
```

You can also put the `lsp` object directly in the preset row configuration. Missing packages, version mismatches or files that cannot load disable LSP while leaving other tools available. After configuration, start DSH and check the preset description and language server status.

## MCP

`mcpConfigFile` points to a UTF-8 JSON file with top-level fields `version: 1`, `target: "dsh-desktop"` and a `servers` array. For example:

```json
{
  "version": 1,
  "target": "dsh-desktop",
  "servers": [
    {
      "name": "@deepseek-ai/dsh-mcp-client",
      "disabled": false,
      "config": {
        "serverName": "example",
        "transport": "stdio",
        "command": "/absolute/path/to/node",
        "args": ["/absolute/path/to/server.mjs"]
      }
    }
  ]
}
```

Each entry's `name` must be `@deepseek-ai/dsh-mcp-client`. `serverName` must be unique and contain 1–32 ASCII letters, digits, underscores or hyphens. `transport` accepts `stdio` and `streamable-http`; other fields follow the current App's official MCP client configuration. `disabled` is optional and must be a boolean when present.

Workbench preserves server order and disabled states, and adds only explicitly configured servers to these two presets. With no configuration, no servers are added. Invalid configuration or startup failure leaves the base presets available and shows the component as not loaded. These files can contain credentials; do not commit them to GitHub or attach them to issue reports.

## Tool discovery

The full package enables the tool discovery row by default, with `presets` containing only `dsh-workbench-coding`. It does not change Full mode or official presets. The Essentials package leaves this row disabled; when enabled, its default target is `standard`.

## New session cards

The `dsh-workbench-session-cards` row accepts an optional `locale` option (`zh` or `en`), following the DSH interface language when omitted.

The `propose_session` tool accepts an optional boolean parameter `ask`:

- When omitted or `false`, it shows a proposal card at the end of the turn or starts a session immediately under the `userQuote` rules.
- When `true`, only `title` and `brief` may be provided (passing `options` or `userQuote` is rejected); at most one call is allowed per turn, counting toward the three-card per-turn limit and duplicate-task deduplication; the tool returns immediately without waiting for user input. When prompting, it shows a question card at the end of the turn with no options panel and no close action. A started session reuses this session's workspace, agent preset, model, reasoning effort and permission without creating a worktree or updating `lastModel` in `$DSH_HOME/dsh-workbench/session-cards.json`.

The preference for handling `ask: true` proposals is stored in `$DSH_HOME/dsh-workbench/session-cards-prefs.json`:

```json
{
  "ownSession": "ask"
}
```

Valid values for `ownSession` are `ask` (ask each time, default), `always-new` (always create a new session) and `always-here` (always handle in this session). A missing or invalid file defaults to `ask`. The host reads the file on each `ask: true` call without caching. Under `always-new`, the session starts automatically only when the current session options pass validation and stay within the current workspace and permission; otherwise the tool falls back to a pending question card at the end of the turn. Under `always-here`, the tool returns handle-here directly so the model continues in the same turn.

When the user chooses New session or Always create a new session on the turn-end question card, the action route ignores `options` from the request, uses this session's current settings, and rechecks the parent session before delivering the first message. If the settings cannot be inherited safely, no session is started and the route returns `409 ask-not-inheritable` with a `reason` (`options`, `workspace` or `permission`) for the card to display. Choosing Handle in this session or Always handle in this session sends a user message to continue here.

An "Always" choice first tries to save the preference. If that write fails, the previous preference stays in effect and the workbench still attempts this action. When the action succeeds, HTTP 200 includes `notSaved: true` at the top level. For example, handling the task in this session returns `{"ok":true,"notSaved":true}`. If a new session cannot inherit the settings, HTTP 409 gives the reason, for example `{"ok":false,"error":{"code":"ask-not-inheritable","reason":"workspace"}}`. This response omits `notSaved` and the card remains available for another choice.

If the action succeeds but the session log cannot record it, the action route returns `503 record-pending`. A retry first records the action that already happened. Repeating the same choice returns the original result. Trying the other choice returns `409 card-decided` to avoid sending a second message or starting another session. Until the record is written, the executed action is kept in `$DSH_HOME/dsh-workbench/session-card-receipts/`; it is deleted once the record is written.

The host exposes the authenticated preference route `GET/POST /api/dsh-workbench.session-cards.prefs`:

- `GET`: returns the current preference object `{ "ownSession": "ask" | "always-new" | "always-here" }`.
- `POST`: accepts `{ "ownSession": ... }`, validates it and atomically writes `$DSH_HOME/dsh-workbench/session-cards-prefs.json`, returning `200` `{ "ok": true, "config": { "ownSession": "..." } }`; malformed JSON or invalid values return `400` `{ "ok": false, "message": "..." }`.

## Session titles

Every option of the `dsh-workbench-session-title` row has a default, and the full package patch sets none explicitly. To change one, use Configure on this row in Plugins, or configure it by row ID in the profile `cordis.patch.yml`:

```yaml
- id: dsh-workbench-session-title
  config:
    refreshEveryPrompts: 10
```

| Option | Default | Meaning |
| --- | --- | --- |
| `tailMessages` | 6 | How many recent messages (user and assistant) to sample when the title uses context |
| `refreshEveryPrompts` | 0 | After this many new messages since the last title, recompute it with context at the end of a turn; 0 turns this off |
| `headMaxChars` | 2000 | Characters kept from the first user message |
| `messageMaxChars` | 1500 | Characters kept from each recent message |
| `maxInputChars` | 8000 | Total characters of conversation in one request; older messages in the middle go first, the first and the latest are always kept |
| `targetWords`, `targetCjkCharacters` | 6, 12 | Title length targets: words for non-CJK languages, characters for CJK languages |
| `maxOutputTokens` | 2048 | Output token limit of the title request; leaves room for models whose thinking cannot be turned off, while models that can turn it off stop after the title |
| `titleEfforts` | `off`, `none`, `minimal`, `low` | Reasoning effort of the title request: the first one the model declares; without any, the model default |
| `timeoutMs` | 60000 | Timeout of one title request in milliseconds, at most 600000 |
| `provider`, `model` | Not set | Pins the model of the title request; set both together. When not set, the title follows the model of the session's latest request |

Everything sent to the model is first logged as DSH's `session/title-llm-request` event, with the title provider recorded as `dsh-session-title-headtail`. The standalone dsh-session-title-headtail plugin used the row ID `session-title-headtail`; configuration written in the profile under the old row ID does not carry over, so use the new row ID.

## Older installations

New installations need no generated preset package. If you previously installed a separate generated preset package, back up your profile, then disable or remove that package so its declarations no longer override the runtime presets. Keep your backup until Code mode and Full mode load successfully. Old package names and locations vary by distribution; ask the person who provided that installation if needed.
