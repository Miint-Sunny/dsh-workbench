# 预设配置

[English](configuration.en.md) · [返回 README](../README.md)

整包提供代码模式和全开模式，从当前 DSH App 的标准模式读取工具。代码模式按需加载部分工具，全开模式从首个请求起加载全部工具定义。单装包不提供这两个预设。

## 基本配置

在「插件」页的预设行配置中设置选项，或在 profile 的 `cordis.patch.yml` 中按行 ID 配置：

```yaml
- id: dsh-workbench-presets
  config:
    locale: zh
    configFile: /absolute/path/lsp.json
    mcpConfigFile: /absolute/path/mcp.json
```

`locale` 可为 `zh` 或 `en`；省略时跟随 DSH 界面语言，读取不到时跟随系统语言。两个文件路径均可省略。路径必须是绝对路径，`~` 和环境变量不会自动展开。配置文件只读，工作台不会修改原文件。

LSP 或 MCP 不可用时，两个基础预设仍然保留，预设说明会显示未启用原因。

## LSP

LSP 需要与当前 App 版本完全一致的 `@deepseek-ai/dsh-lsp`、`@deepseek-ai/dsh-lsp-stdio`、`@deepseek-ai/dsh-tool-lsp`，以及自己准备的语言服务器。工作台不会扫描主目录或下载服务器。

完全退出 DSH 后，使用 App 自带的 `dsh`。把 `<DSH版本>` 替换为 App 的完整版本号，包括 rc 后缀：

```sh
dsh plugin --profile desktop add --save-exact \
  "@deepseek-ai/dsh-lsp@<DSH版本>" \
  "@deepseek-ai/dsh-lsp-stdio@<DSH版本>" \
  "@deepseek-ai/dsh-tool-lsp@<DSH版本>"
```

`configFile` 指定的 JSON 格式如下。三个路径必须指向实际文件，不能填写目录：

```json
{
  "lsp": {
    "nodePath": "/absolute/path/to/node",
    "serverPath": "/absolute/path/to/typescript-language-server/lib/cli.mjs",
    "typescriptPath": "/absolute/path/to/typescript/lib/tsserver.js"
  }
}
```

也可以直接在预设行配置中填写 `lsp` 对象。缺包、版本不符或文件无法加载时不启用 LSP，其他工具仍然可用。配置完成后启动 DSH，检查预设说明及语言服务器状态。

## MCP

`mcpConfigFile` 指定一个 UTF-8 JSON 文件，顶层字段为 `version: 1`、`target: "dsh-desktop"` 和 `servers` 数组。例如：

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

每个条目的 `name` 必须为 `@deepseek-ai/dsh-mcp-client`。`serverName` 必须唯一，由 1–32 个英文字母、数字、下划线或连字符组成。`transport` 支持 `stdio` 和 `streamable-http`；其余字段遵循当前 App 的官方 MCP 客户端配置。`disabled` 可省略，填写时必须为布尔值。

工作台保持服务器顺序和停用状态，只把明确配置的服务器附加到这两个预设。没有配置时不添加服务器；配置损坏或服务器启动失败时保留基础预设，并显示未加载状态。配置可能包含凭据，不要提交到 GitHub 或附在问题报告中。

## 工具发现

整包中的工具发现行默认启用，`presets` 仅包含 `dsh-workbench-coding`。它不改变全开模式或官方预设。小功能单装包默认停用此行，启用后的默认目标为 `standard`。

## 新会话卡片

`dsh-workbench-session-cards` 行支持可选的 `locale` 配置项（`zh` 或 `en`），省略时跟随 DSH 界面语言。

`propose_session` 工具接受可选布尔参数 `ask`：

- 省略或填 `false` 时，在当前轮次末尾出提议卡，或按 `userQuote` 规则直接开会话。
- 填 `true` 时，仅允许提供 `title` 和 `brief`（同时填写 `options` 或 `userQuote` 会被拒绝）；每轮最多一次，计入每轮三张卡片和同名去重上限；按当前偏好立即返回，不在工具内等待用户回答。设为询问时在轮末出一张无选项面板、无关闭动作的询问卡；新建会话只使用当前会话的工作区、Agent 预设、模型、推理等级和权限，不新建工作树，也不修改 `$DSH_HOME/dsh-workbench/session-cards.json` 中的 `lastModel`。

「模型提议另开会话时」的偏好保存在 `$DSH_HOME/dsh-workbench/session-cards-prefs.json`：

```json
{
  "ownSession": "ask"
}
```

`ownSession` 可选值为 `ask`（每次询问，默认）、`always-new`（总是新建会话）和 `always-here`（总是在当前会话处理）。文件缺失或校验失败时按 `ask` 处理。宿主每次执行 `ask: true` 都直接读取磁盘文件，不缓存。处于 `always-new` 时，只有当前会话选项通过校验且不越过当前会话的工作区和权限时才直接新建，否则改为在轮末出待处理卡片；处于 `always-here` 时按在当前会话处理直接返回，让模型在同一轮接着做。

用户在轮末询问卡上选择「新建会话」或「总是新建会话」时，动作路由只用当前会话的工作区、Agent 预设、模型和权限（忽略请求里的 `options`），并在投递首条消息前再核对一次父会话。选项失效或不能安全继承时不开新会话，返回 `409 ask-not-inheritable` 和原因（`options`、`workspace` 或 `permission`），由卡片显示原因。选择「在当前会话处理」或「总是在当前会话处理」时，以用户的名义发一句处理消息。

选择「总是……」时先尝试保存偏好。若写入失败，原有偏好继续生效，工作台仍尝试本次动作。动作成功时，HTTP 200 响应在顶层返回 `notSaved: true`，例如在当前会话处理成功时返回 `{"ok":true,"notSaved":true}`。若新会话不能沿用当前设置，HTTP 409 返回原因，例如 `{"ok":false,"error":{"code":"ask-not-inheritable","reason":"workspace"}}`。这个响应不含 `notSaved`，卡片保留供再次选择。

如果动作已经执行，但会话日志暂时写不进去，动作路由返回 `503 record-pending`。再次选择会先补记已执行的动作。重试相同选择会返回原结果；选择另一个动作会返回 `409 card-decided`，避免重复发消息或创建会话。补记之前，已执行的动作暂存在 `$DSH_HOME/dsh-workbench/session-card-receipts/`，补记成功后删除。

宿主提供受官方会话鉴权保护的配置路由 `GET/POST /api/dsh-workbench.session-cards.prefs`：

- `GET`：返回当前偏好对象 `{ "ownSession": "ask" | "always-new" | "always-here" }`。
- `POST`：接收 `{ "ownSession": ... }`，校验通过后原子写入 `$DSH_HOME/dsh-workbench/session-cards-prefs.json`，返回 `200` `{ "ok": true, "config": { "ownSession": "..." } }`；请求体不是合法 JSON 或字段校验失败时返回 `400` `{ "ok": false, "message": "..." }`。

## 会话标题

`dsh-workbench-session-title` 行的配置项都有默认值，整包补丁不写显式配置。要改时在「插件」页这一行的「配置」中设置，或在 profile 的 `cordis.patch.yml` 中按行 ID 配置：

```yaml
- id: dsh-workbench-session-title
  config:
    refreshEveryPrompts: 10
```

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `tailMessages` | 6 | 参考上下文时取最近多少条对话（用户和助手都算） |
| `refreshEveryPrompts` | 0 | 距上次标题又发了多少条消息后，在一轮结束时参考上下文自动重算；0 表示关闭 |
| `headMaxChars` | 2000 | 首条用户消息最多保留的字符数 |
| `messageMaxChars` | 1500 | 最近对话里每条消息最多保留的字符数 |
| `maxInputChars` | 8000 | 一次请求里对话内容的总字符上限；超出时先丢中间较早的消息，首条和最新一条始终保留 |
| `targetWords`、`targetCjkCharacters` | 6、12 | 标题长度目标：非中日韩语言的词数，中日韩语言的字数 |
| `maxOutputTokens` | 2048 | 标题请求的输出 token 上限；关不掉思考的模型要靠它给思考留出空间，能关思考时模型写完标题就停 |
| `titleEfforts` | `off`、`none`、`minimal`、`low` | 标题请求的思考档位：取模型声明的第一个；都没有就用模型默认档位 |
| `timeoutMs` | 60000 | 单次标题请求的超时，毫秒，最大 600000 |
| `provider`、`model` | 不设 | 固定标题请求用的模型，两项必须同时设置；不设时跟随会话最近一次请求用的模型 |

每次发给模型的内容先以 DSH 的 `session/title-llm-request` 事件记进会话日志，标题提供方记为 `dsh-session-title-headtail`。原来的独立插件 dsh-session-title-headtail 的行 ID 是 `session-title-headtail`，按旧行 ID 写在 profile 里的配置不会跟过来，要改用新行 ID。

## 旧安装

新安装无需生成预设包。如果以前安装过独立的预设生成包，先备份 profile，再停用或卸载旧包，避免旧预设声明覆盖运行时预设。保留旧备份，确认代码模式和全开模式加载后再自行清理。旧包名和安装位置因安装来源不同，请向提供旧安装包的人确认。
