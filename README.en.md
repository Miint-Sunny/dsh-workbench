# dsh-workbench

[中文](README.md)

A workbench plugin for the DeepSeek Harness (DSH) desktop app, with tasks, change review, checkpoints, session organization, usage statistics, page publishing, model settings and session titles. Each feature has a separate row on the Plugins page. Disabling a row restores any DSH interface it replaced.

## Requirements

- DeepSeek Harness desktop app: `>=0.2.2-rc.2 <0.3.0-0` (see `engines.dsh` in `package.json`; versions outside this range will not load the plugin); verified on App 0.2.2-rc.5.
- Currently supports macOS only. Windows is not supported yet.
- Building from source requires Node.js `>=22.19.0` and npm. Installing a prepared tgz requires no build.

## Installation

The package is not published to npm yet. Download the tgz from [GitHub Releases](https://github.com/Miint-Sunny/dsh-workbench/releases) and save it locally, then open Plugins → Add plugin in DSH and enter its **absolute path**, for example `/absolute/path/miint-sunny-dsh-workbench-0.2.0.tgz`.

Alternatively, fully quit DSH and use the App-bundled `dsh` command for your profile. These examples use `desktop`:

```sh
dsh plugin --profile desktop add /absolute/path/miint-sunny-dsh-workbench-0.2.0.tgz
```

After npm publication, enter `@miint-sunny/dsh-workbench` in the same dialog, or run:

```sh
dsh plugin --profile desktop add @miint-sunny/dsh-workbench
```

Open DSH and check that the workbench rows have loaded on the Plugins page. Each feature can be enabled separately. The Workbench (`dsh-workbench`) root row loads the feature interfaces; disabling it hides all workbench interfaces. Missing optional dependencies are reported by the relevant row or preset description.

## Updating and uninstalling

Packages installed by their npm name can check for and install updates on the Plugins page. Local tgz installations have no version update button: remove the workbench, then add the absolute path of the new tgz.

To uninstall, remove the workbench on the Plugins page. You can also fully quit DSH and run `dsh plugin --profile desktop remove @miint-sunny/dsh-workbench`. Back up your profile and workbench data before changing the source or version. Removing the plugin does not mean deleting stored pages, checkpoints, memory or settings.

## Migrating from the standalone plugins

Model settings and Session titles used to be two standalone plugins (`@miint-sunny/dsh-model-settings` and `@miint-sunny/dsh-session-title-headtail`). They are part of the workbench since 0.2.0 and are no longer released separately. If you installed them, remove them on the Plugins page first, then install or update the workbench and restart DSH.

- While both are installed, the workbench rows Model settings, OpenCode session ID and Session titles do not load, and the Plugins page names the standalone plugin. The standalone plugin keeps working and the other workbench rows are not affected. These rows load after you remove the standalone plugin and restart.
- Providers, models, API keys and the default model are stored in DSH's settings and credentials, and session titles in the session logs, so nothing is lost when you switch.
- Settings written in the profile under the old row IDs (`model-settings`, `model-settings-opencode-session`, `session-title-headtail`) do not carry over; the new row IDs are `dsh-workbench-model-settings`, `dsh-workbench-opencode-session` and `dsh-workbench-session-title`.

## Full package and smaller packages

The full package and the seven smaller packages share feature row IDs and cannot be installed together. On a conflict, the affected feature rows do not load; the Plugins page and startup log list the conflicting packages. Remove the conflict and reload the profile. The seven smaller packages can be combined with each other.

| Package | Features |
| --- | --- |
| `@miint-sunny/dsh-workbench-usage` | Usage overview, balances and quotas, context, idle compaction |
| `@miint-sunny/dsh-workbench-checkpoints` | Checkpoints, regenerate and edit-and-resend, worktree management |
| `@miint-sunny/dsh-workbench-review` | Review (change review and local review), full plan, selected-text replies, commit and change request commands |
| `@miint-sunny/dsh-workbench-navigation` | Session organization, search, attention filter, command palette, new tabs, turn navigation, session header, browser viewport size, session titles |
| `@miint-sunny/dsh-workbench-pages` | Page publishing, design canvas |
| `@miint-sunny/dsh-workbench-settings` | MCP visibility, approval rules, workspace trust, settings page icons, workspace folders and permissions, protect DSH data and workspaces, model settings, OpenCode session ID |
| `@miint-sunny/dsh-workbench-essentials` | Tasks and wrap-up, notifications, keep awake, project memory, side chat, on-demand tools, new session cards |

Install, update and remove a smaller package in the same way, using its package name. Only the full package provides Code mode and Full mode.

## Features

### Conversation and navigation

- **Tasks and wrap-up**: show task progress. The model calls `wrap_up` with a summary and optional choices; selecting a choice sends it as a message. The first choice is the recommended one: press ⌘↵ (Ctrl+Enter on Windows and Linux) while the composer is empty to choose it. Closing the box only collapses the question and choices; nothing is sent.
- **New session cards**: when the model thinks a task belongs in its own session, `propose_session` shows a card at the end of the turn with a title, the brief for the new session, and options for the workspace, worktree, agent preset, model, reasoning effort and permission. By default a session starts only when you choose Start; it starts right away when you asked for a separate session in this turn and its options stay within this session's (same workspace, no higher permission). When the card would use Full access and this session does not have it, Start and ⌘↵ ask you to confirm first. "Handle in this session" sends a message on your behalf, and closing only records the choice so the task is not proposed again. When a task you gave in this turn belongs in its own session, the model may also pass `ask: true` (with only `title` and `brief`) to show a "Start this in its own session?" card at the end of the turn; the turn then ends and the composer stays available. There is at most one such card per turn, with no options and no close action: "New session" (⌘↵) starts a session with this session's settings, without creating a worktree or changing the remembered last model; when the workspace, options or permission cannot be reused as they are, no session starts and the card states the reason. "Handle in this session" (Esc, when the focus is not in the composer) sends a message on your behalf. The "Don't ask again" menu offers "Always create a new session", "Always handle in this session" and "Settings"; after an "Always" choice is saved, later proposals follow it. "Always create a new session" still shows the card when the current settings cannot be reused. If saving fails, the workbench still tries the action you chose and keeps your previous preference for later proposals. To be asked each time again, set "When the model offers a new session" to "Ask" in the workbench's New session cards row on the plugin page. At most three cards per turn (including `ask: true`), no repeated proposals, and sessions started from a card cannot propose more. When the new session stops (completed, waiting for an answer, error), it reports once to this session. The DSH sidebar has no session hierarchy, so the new session opens in the same workspace and, with manual ordering, sits below this session.
- **Review**: the Review tab in the right sidebar shows unstaged, staged, uncommitted, branch and per-turn changes. Stage, unstage and roll back a whole scope, a file or a single change (rollbacks can be undone; untracked files go to the Trash), commit and push to the destination shown in the commit dialog, create a branch on a detached HEAD, and generate a commit message with a separate request. Line comments survive reloads in the same browser tab and can be sent to the model together. Entry points: the changes card at the end of each turn, the new tab page in the right sidebar, More actions in the session header, and a finished `/review`. You can stage and unstage during a session run. Rollbacks and undo wait until the session stops. Operations are rejected and the changes reread when files no longer match the diff on screen.
- **Regenerate and edit-and-resend**: fork a new session before the question and keep the original session. Not available for questions with attachments, references or messages inserted during the turn.
- **Selected-text replies and full plans**: reply to or quote selected text. Pending plans appear in the conversation, and a reply can request changes.
- **Checkpoints**: save workspace state at the start of each top-level turn. Restore files, fork the session or do both; restores can be undone.
- **Session search and turn navigation**: ⌘F searches displayed text. Turn markers support previews, drag navigation and bookmarks. Bookmarks stay in the current browser.
- **Side chat and session organization**: open another session in the right sidebar, add color labels and mark sessions unread. The attention filter collects pending approvals, questions and plans.
- **Command palette**: search sessions, actions, entries and commands. Start with `/` to search commands only. In Settings → Keyboard shortcuts, remove ⌘K from Search sessions before assigning it to Command palette.
- **New tabs and session header**: pin and reorder right-sidebar entries. More actions moves to the left of the header controls; the ordinary change request entry moves into that menu, while requests needing attention retain their header indicator.
- **Session titles**: after the first message of a new session, the model names it from that message only; Regenerate title in the sidebar session menu or `/retitle` names it again from the first and latest messages, replacing a title you set by hand. A session still showing the temporary title after automatic naming failed gets one more try at the end of a later turn. While this row is on, it takes the place of DSH's built-in first-message title generation (the title service accepts one provider at a time). When this row is off, DSH's built-in first-message titles come back right away, without a restart.
- **Browser viewport size**: adds a Viewport size button to the right-sidebar browser toolbar: Phone, Tablet, Desktop or a custom size (240 to 3840 px), in portrait or landscape. The page is laid out at that size and scaled into the tab, with the size and zoom shown under the toolbar. Each tab keeps its own size and new tabs start at Automatic. Only the layout width and height are set; touch, device pixel ratio and the user agent are not emulated.

### Usage and context

- **Usage overview**: summarizes tokens, model requests and estimated costs from session logs, with ranges, trends and breakdowns. Reads on opening or refresh, with no background polling.
- **Balances and quotas**: queries DeepSeek, OpenCode Go and GLM Coding Plan when credentials are configured. Credentials remain in the host process.
- **Context**: inspect tools, skills, memory, tool results, recent requests and compaction history. Viewing the page makes no model request.
- **Idle compaction**: set per-session thresholds for work or idle periods. Disabled by default and applies only to configured presets.

### Code and pages

- **Page publishing and design canvas**: `publish_page` stores HTML and local assets as versioned pages. The canvas offers desktop and phone artboards, element comments, CSS variable previews and HTML export.
- **Local review**: `/review uncommitted` or `/review --base <local-branch>` starts an independent read-only review; findings appear under the diff lines in Review. Untracked files require explicit inclusion; sensitive files, symbolic links, binary files and oversized files are excluded.
- **Commit and change request commands**: `/commit`, `/push`, `/pr` and `/fix-ci` send the task to the model. Normal permission approvals remain in effect.
- **Worktree management**: create, enter and clean up Git worktrees from the session menu. Cleanup moves files to Trash and retains the branch; unpublished commits or active sessions prevent cleanup.
- **Project memory**: `memory_view` and `memory_write` store project facts shared across Git worktrees. These tools are unavailable to subagents.

### Settings and system

- **MCP visibility**: hide servers or tools per session or project and inspect calls observed since startup. Server configuration is unchanged.
- **Approval rules**: save confirmed project, directory, executable and argument rules for simple bash commands. Pipes, redirections and expansions are excluded; DSH automatic review still runs.
- **Workspace trust**: control local resource access in supported HTML previews. Static preview is the default, and trust can be revoked in Settings.
- **Notifications and keep awake**: notify when background sessions finish or require action. Keep the Mac awake while work runs; AC power is required by default.
- **Switch agent preset**. After a session starts, switch between Standard, Code and Full modes from the agent preset label in the session header. A confirmation first shows the tool and system prompt changes and the estimated uncached tokens of the next request, with an option to run `/compact` first. Only an idle root session with no queued input, approvals, plan reviews or questions awaiting a response can switch. The next request uses the new preset, and it stays in effect after a restart, a replay or a fork. Blank sessions keep using the official selector in the header.
- **On-demand tools**: Code mode starts with common tools and lets the model find others as needed. This row is disabled by default in the Essentials package.
- **Settings page icons**: add icons for the settings pages of dsh-bili-whale and dsh-plugin-subscriptions in place of the default gear. When those plugins provide their own icons, theirs are used.
- **Workspace folders and permissions**: open Workspace settings… from the workspace menu in the sidebar to rename the workspace and add subfolders and external folders. A subfolder becomes a separate workspace whose sessions cannot write the main folder unless it is set to writable; under the Workspace Write permission, external folders are writable like the main folder. Change folder… on the main folder row moves the workspace to a new folder, or merges it into the workspace already there: sessions, forks, subagent sessions, and the workbench checkpoints, project memory and workspace trust settings move along. Moving requires quitting DSH, which reopens when the move finishes; a backup is made first, and the move can be undone from the notice shown after reopening or from Workspace settings.
- **Model settings**: replaces the Settings → Models page. It opens in two columns, categories on the left and providers on the right; an added provider opens its details page and one not yet added opens a form. On the details page you can replace or clear the API key, arrange the model catalog and check the connection; Fetch available models asks the provider once, only when clicked. For providers that mix API protocols, such as OpenCode and OpenRouter, models outside the catalog can be added too, stored as one companion entry per protocol. Providers, models and API keys stay in DSH's settings and credentials; turning this row off restores the built-in Models page. The session ID header for the OpenCode models added this way comes from a separate row, OpenCode session ID, which can stay on when only Model settings is turned off.
- **Protect DSH data and workspaces**: across all sessions and subagents, intercepts writes, moves or deletions under `$DSH_HOME/storages` and `$DSH_HOME/sessions`, and moves, renames or deletions of registered workspace root folders themselves, prompting for human approval with guidance; recognized read-only commands pass through. Lengthy or deeply nested commands and writes with unverified targets can also prompt. Approval rules do not auto-answer, and automatic review cannot allow them through.

## Settings

Use Configure on the relevant plugin row; some features also have their own settings pages. The table lists the main defaults. `$DSH_HOME` means the DSH data directory.

| Feature | Default or configuration location |
| --- | --- |
| Change review | Revert backups retained for `keepDays: 30` days |
| Checkpoints | 14 days; 2048 MB per session; 2 MB per non-Git file; wait up to 5 seconds before the first tool |
| Regenerate | Archiving the original session after a fork is disabled |
| Notifications | Four event types enabled; foreground notifications and first-sentence previews disabled; presets can be excluded |
| Keep awake | `graceMs: 60000`; `alsoOnBattery: false` |
| Project memory | `maxBytes: 16384` |
| Usage and quotas | `$DSH_HOME/dsh-workbench/usage.json` and `quota.json`; quota cache 300 seconds, timeout 10 seconds |
| Idle compaction | Disabled; configured per session, with defaults and prompts in Settings → Compaction |
| Local review | Uses the parent session model unless row config `model` overrides it |
| Commit and change request commands | `locale: zh`, with `en` also available |
| Code mode and Full mode | Names follow the interface language unless `locale` is set; LSP and MCP are optional |
| Workspace folders and permissions | `$DSH_HOME/dsh-workbench/workspace-folders.json`, recording external folders and writable subfolders per workspace; move records and backups in `$DSH_HOME/dsh-workbench/workspace-moves/`; the row option `moveUndoDays` sets how many days after a move it can be undone (default 30) |
| Model settings | No storage of its own: providers, models and the default model are in DSH's settings, API keys in DSH's credentials; Check connection outputs at most 16 tokens per click, with a 20-second timeout |
| Session titles | `tailMessages: 6`, `refreshEveryPrompts: 0` (no automatic recompute at the end of turns); the others are in [Preset configuration](docs/configuration.en.md) under Session titles |
| New session cards | Defaults to `ownSession: "ask"` (`ask`, `always-new` or `always-here`), stored in `$DSH_HOME/dsh-workbench/session-cards-prefs.json` and accessed via `GET/POST /api/dsh-workbench.session-cards.prefs`; state stored in `$DSH_HOME/dsh-workbench/session-cards.json` |

Configure `presets` on the full package’s `dsh-workbench-preset-switch` row to choose which of the three modes are shown and in what order. `compactFirstAboveTokens` defaults to 65536. At or above that estimate, compacting first is selected by default. Estimates depend on the current model, context and tool declarations. A field can be unknown when its inputs are unavailable.

See [Preset configuration](docs/configuration.en.md) for LSP paths, MCP JSON format and examples.

## Known limitations

- Switching a started session uses the DSH `recompose` interface, which is documented for blank sessions only (the official selector refuses started sessions). Future DSH versions may restrict it; switching would then report “preset unavailable” and the session keeps its preset.
- Subagents keep the preset chosen at creation. A switch applies to the current session only.
- On models such as DeepSeek V4 Flash that append system prompt updates to the conversation, switching back and forth leaves several copies of the system prompt in the context until compaction. Compacting first is a separate step: a successful compaction still applies if the subsequent switch fails.

- macOS only. Windows is not supported yet.
- Git checkpoints include untracked files but exclude ignored files. Non-Git checkpoints cover file-tool edits, not shell edits. Renames that change only letter case may not restore.
- Per-turn changes depend on the current host process. Older turns may become unavailable after a restart; saved revert undo records remain. In Review, undoing a rollback in a Git scope works only in the current window; after a page reload it can no longer be undone.
- Search only covers displayed text; a word split across text nodes may not match. Turn navigation depends on DSH page structure; the row configuration reports when it cannot attach.
- Published pages open with scripts disabled. The sandbox blocks fetch requests, form submissions and external images. Its resource policy allows scripts and styles from cdnjs, jsDelivr and unpkg, and styles and fonts from Google Fonts. Click Run scripts in the preview or design panel to enable scripts for that version. The browser remembers your choice when storage is available. Once scripts run, the page can navigate to another site and send its content there. Each inlined asset can be up to 4 MiB, with up to 16 MiB and 64 assets per version. Deleted pages are retained for 30 days.
- Design canvas depends on page publishing; the attention filter depends on session organization; balances and quotas are displayed in the usage overview.
- Workspace trust requires dsh-better-sidebar 0.32.0 with the workbench preview patch v3. A regular installation of that dependency does not guarantee support. Trusted page scripts can read permitted local assets and may transmit their contents; trust only familiar projects. Isolation when the preview frame itself navigates to `dsh-app:` has not been fully verified.
- Costs are estimates, and cache lifetime is inferred from local samples rather than guaranteed by the provider. Balance and quota queries require a network connection; failures may show an error or cached result.
- Workspace folders and permissions govern writing only; DSH does not restrict reading. Background jobs started before a folder is set back to read-only or removed can still write there until they exit. A hard link that already exists in a subfolder and points to a file in the main folder lets shell commands change that file. Saving changes in Workspace settings requires a token that the page receives only when it reads the folder list; it keeps out other web pages and preview frames. Programs that can run commands on this computer, including commands the model runs under the Workspace Write permission, can call the local DSH interface directly, and the token does not stop them; the same holds for DSH's own interface.
- Changing the folder requires quitting DSH. In the desktop app the workbench asks DSH to quit through AppleScript, and macOS may ask for Automation permission; if it is not allowed, press ⌘Q to quit. DSH running in a terminal has to be quit and started again by hand. Paths written in session logs are not updated. Undo brings content written in the moved sessions since the move back with them; it is refused once a session log was rewritten, a session folder gained other files, or the workspace registry or workbench data changed.
- In Model settings, custom settings change the display name (custom providers only), API address, API protocol (custom providers only) and retry policy; Provider ID and the credential name are read-only, and other fields need editing in the profile `cordis.patch.yml`.
- Account routes in Model settings only show their status; only the DeepSeek account has a sign-in entry on the Models page, and signing out is in the account menu of the settings sidebar.
- Volcano Ark's Coding Plan and Agent Plan quotas only apply in AI coding tools under Ark's terms; using them elsewhere may be treated as abuse.
- The protocol of a model outside the catalog is inferred from its ID; correct it in the expanded row when the inference is wrong. Its address can only be the API address written in custom settings or the address in the installed catalog. Model settings only recognizes the companion entries it created (display names in the form "<provider> (<protocol>)"); one whose display name was edited in the configuration file shows as a separate custom provider.
- Deleting a provider that holds the default model does not change DSH's default model (as on the built-in Models page).
- While Session titles is on, DSH's built-in first-message title row shows as waiting for a service on the Plugins page (it waits for the workbench to hand back its grant), not as disabled. A new session whose first message is sent in the few milliseconds while the row is being switched may only get the temporary title cut from that message; with Session titles on, it gets one more try at the end of a later turn.
- What Protect DSH data and workspaces cannot block: writes or deletions inside external scripts (such as `python3 script.py` calling `open(path, 'w')`), paths built dynamically at runtime or obfuscated, compiled binaries, Node `fs` calls inside PTC `run_code` that bypass DSH tools, persistent terminal (`terminal_send`) inputs after a prior `cd` or split across separate calls, pre-existing hard links pointing into `storages/` or `sessions/`, and background jobs started before enabling this row. Under Full access (`approval: 'never'`) and in all subagents, execution is still blocked with the explanation and guidance, but DSH's `ApprovalService` suppresses interactive prompts under `never`, so no confirmation card can be shown.

## Feedback

Report problems through [GitHub Issues](https://github.com/Miint-Sunny/dsh-workbench/issues). During private testing, you can also contact the person who gave you the plugin.

Include the DSH App version, package name and version, macOS version and chip, steps, actual and expected results, and any unloaded rows and complete errors from the Plugins page. Screenshots are welcome. Do not include keys, tokens, credentials from configuration or private conversations.

## Development

After cloning with git, install the development dependencies, then run the tests:

```sh
npm ci --legacy-peer-deps
npm test
```

Keep `--legacy-peer-deps`: the DSH App provides the peer dependencies, which are not installed from npm. The only development dependency is [dsh-ui-guard](https://github.com/Miint-Sunny/dsh-ui-guard): `npm test` uses it to check the interface's icons and wording against the DSH App installed on this machine, and skips that check when the App is not installed.

## License

MIT; see [LICENSE](LICENSE). The adapted code below retains its third-party notices.

## Third-party sources

- `lib/quota-adapters.js` and the credential resolution and config reading in `lib/quota.js` are adapted from `src/core/adapters.ts` and `src/host/usage-service.ts` of [@linxin666/dsh-usage](https://www.npmjs.com/package/@linxin666/dsh-usage) 0.4.15 (Apache-2.0). Changes: only three providers are kept; DeepSeek reads all currencies; output fields are those of the balances and quotas row; queries run only on request instead of polling, with caching, de-duplication of concurrent requests, fallback on failure, and a state file for the accumulated balance decrease. The original project is released under Apache-2.0, and this notice is kept under that license.
- The statutory holiday table in `lib/usage-holidays.js` is adapted from `src/core/holidays.ts` of the same package (Apache-2.0), whose data comes from [chinese-holidays-node](https://github.com/bastengao/chinese-holidays-node) (MIT). Only the holiday entries are taken; both license notices are kept in that file's header.
- In the Model settings row, the credential name derivation (`lib/model-settings/key-ref.js`); the API key format checks, capacity notation, model catalog and reasoning level validation, path operations, and provider directory joining and read order in `keys.js`, `models.js`, `status.js` and `store.js` under `src/client/model-settings/`; the drag insertion line style in `style.js`; and the Gemini API rule in `protocol.js` are adapted from `@deepseek-ai/dsh-client-ui-settings-models` in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT). Versions, commits and the full license text are in [NOTICE](NOTICE).
