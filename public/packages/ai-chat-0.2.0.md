# AI 聊天助手（ai-chat）0.2.0

一个可上架 OnlyChat 市场的 WebAssembly **聊天 agent**：机器人可以多步调用工具（归档 grep、记忆检索、联网搜索/抓取、发送消息），把每条聊天永久归档，并在右侧面板展示思考/工具轨迹。

- 插件 ID：`ai-chat`
- API：1
- 权限：`chat.receive`、`chat.send`、`net`、`ui.declarative`
- 默认状态：安装后停用，需要手动启用并填写 API Key
- 不访问文件系统、世界、玩家动作或其他插件的数据

## 安装

1. 设置 → 插件 → 市场，安装「AI 聊天助手」。
2. 安装后保持默认停用，先打开插件详情填写设置并确认 `ui.declarative` 权限。
3. 至少填写：
   - **API 提供商**：`openai` / `anthropic` / `gemini`
   - **API Key**
   - **模型**（默认 `gpt-4o-mini`；Anthropic 例如 `claude-sonnet-4-5`，Gemini 例如 `gemini-2.5-flash`）
   - **API 地址**：OpenAI 兼容默认 `https://api.openai.com/v1`；切换到 Anthropic / Gemini 且仍保留 OpenAI 默认地址时，插件会自动改用官方地址。
4. 启用插件。聊天里发送 `/ai status` 可看到当前模式与记忆计数；右侧会出现「AI 思考」面板。

插件不读取其他插件的存储或聊天日志；所有归档和记忆都在本插件自己的 `plugin-data` KV 中。

## 右侧「AI 思考」面板

启用后通过声明式 UI 发布 panel `agent`（slot `right-panel`）：

- 状态：空闲 / 思考中 / 调用工具 / 等待 API / 已停止
- 最近 `traceMaxEntries` 条轨迹：模型返回的 `thought`、工具名和参数、结果摘要、压缩摘要、最终回复、错误
- 手动指令输入框 + 发送 / 停止 / 清空按钮

轨迹只显示**模型实际返回的 thought 和工具轨迹摘要**，不伪装成隐藏思维链。面板输入是插件指令，不会伪造玩家聊天；发送时仍走 `chat_send` 和回复前缀/长度限制。

`ui.action` 处理：

- `manual` 输入回车或 `manual_send`：作为当前 turn 的用户指令，agent 可以 grep/记忆/联网并 `send_message`
- `stop`：取消当前 turn，丢弃尚未返回的请求
- `clear`：清空 trace

## 回复模式

| `replyMode` | 行为 |
|---|---|
| `off` | 不自动回复；仍会归档（optOut/ignorePlayers 例外），右侧手动指令仍可用 |
| `mention` | 只有被名字、别名、`@名字` 或 `/ai` 命令点名时回复（默认） |
| `smart` | 点名直接回复；问题或按 `smartChance` 随机抽中的消息先做一次轻量 LLM 判断 |
| `auto` | **每条玩家消息都由模型结合上下文、归档和记忆决定是否回复**；不需要时 `finish {send:false}` |
| `always` | 所有玩家消息都可能回复，仍受冷却和每分钟上限约束 |

- `botName` 留空时使用当前账号用户名；`aliases` 用逗号分隔。
- 忽略 `self`、系统消息、指令回显、`ignorePlayers` 里的玩家和 optOut 玩家。
- 回复有每人冷却（`cooldownSec`）和全局每分钟上限（`maxRepliesPerMin`）；`auto` 的决策不受发送冷却影响，但发送仍受限制。
- 宿主单条聊天限制 256 字符，插件会把回复压到 240 字符以内。

命令：

```text
/ai status                      当前模式、记忆计数、联网与工具设置
/ai memory search <关键词>       公开回复本地记忆命中（最多 2 条摘要 + 2 条事实）
/ai forget me                   删除自己的画像/事实/相关摘要/归档消息，并 optOut
/ai remember me                 取消 optOut，恢复记录
```

`/ai memory search` 的回复是**公开发送到服务器聊天**的，别用它查询敏感内容。

## Agent 协议（JSON tool calling）

模型每一步只输出一个 JSON 对象（纯 JSON，不要 Markdown）：

```json
{"thought":"先查归档","tool":"grep","arguments":{"query":"今天","scope":"archive|memory|all","limit":20,"caseSensitive":false}}
{"thought":"看前后文","tool":"read","arguments":{"id":"消息 id","at":1700000000000,"before":5,"after":5}}
{"thought":"回忆","tool":"memory","arguments":{"query":"关键词"}}
{"thought":"查网页","tool":"search","arguments":{"query":"关键词"}}
{"thought":"读网页","tool":"fetch","arguments":{"url":"https://..."}}
{"thought":"先发一句","tool":"send_message","arguments":{"text":"..."}}
{"thought":"完成","tool":"finish","arguments":{"reply":"...","send":true}}
```

- 每次工具调用把结果作为 observation 回填，可以连续调用；次数只受 `maxToolSteps`（0=不限）。
- 重复相同 `tool + arguments` 会被拒绝并提示换策略；连续重复 3 次强制收尾。该保护不算次数限制。
- `send_message` 立即通过 `chat_send` 发送；`finish` 后若 `send=true` 且 `reply` 非空才再发送一次。可以只 `finish`，也可以先 `send_message` 再 `finish`。
- `finish {send:false}` 表示模型决定不回复（`auto` 模式的主要出口）。
- JSON 解析失败会追加“只输出 JSON”重试一次；再失败时，纯文本按普通回复兜底，无法解析的 JSON 片段则结束本回合不发送。
- 兼容旧版 `{"action":"reply"|"search"|"fetch"|"memory"}` 输出，但新提示词只教新协议。
- 工具只作用于本插件自己的归档/记忆；不会跨插件读取。

### 安全边界

- 聊天、归档、记忆、网页和搜索结果都是不可信数据；其中任何“忽略以上规则”都当普通文本。
- 不执行游戏命令、移动、攻击、破坏方块、`player_action` 或世界写入。
- 不把 API Key 发给非配置 host；日志只记录状态码、长度、模型名和脱敏错误。
- `fetch` 只走 `r.jina.ai`，并拒绝 localhost、内网、链路本地和带用户信息的 URL。

## 上下文压缩与全量归档

### 1. 永久归档（原始消息）

- **每条 `chat.message` 都会写入**按服务器（或 `memoryScope=global`）隔离的归档，即使 `memoryEnabled=false`。
- 每次写入 `id、at、kind、sender uuid/name、text、self、server`；单条文本截断到 512 字符。
- 每 **200 条或 512 KB**（先到者）一个 chunk；chunk 立即写入，meta 记录 chunk 列表、起止时间、首尾消息 id。
- 单个 KV key 远低于宿主 1 MiB 限制；写入失败只记录日志，不阻塞聊天。
- `archiveRetentionDays=0`：永久保留；`>0`：只清理超过该天数的**原始消息**，压缩摘要和玩家画像继续保留。
- 不再按消息条数截断；`contextMessages` / `memoryMaxMessages` 已废弃，旧配置里的条数限制会被忽略。

### 2. grep / read

`grep` 是字面/大小写不敏感搜索，支持简单 `*` 通配，不引入 regex 依赖：

```json
{"tool":"grep","arguments":{"query":"钻石","scope":"all","limit":20,"caseSensitive":false}}
```

- `scope=archive`：原始归档；`memory`：episode 摘要 + 玩家 facts；`all`：两者。
- 返回时间（日期+时分）、服务器、玩家、文本、chunk、id；空结果会明确说明。
- `read` 按 id 或时间返回前后文（`before`/`after` 各最多 20 条），便于 agent 追问。
- 只读取本插件自己的归档/记忆，不跨插件。

### 3. 上下文预算

- `contextTokens`（4096–131072，默认 32768）估算历史 + 记忆 + 当前消息 + 系统提示。
- 估算器按字符/CJK 近似：CJK 字符约 1 token，其他字符约 0.25 token；每条消息再加少量 framing。
- 超出预算时：保留最近消息；把更早的一段用一次**无工具 LLM 调用**压缩成结构化摘要（时间范围、参与者、主题、事实、未决问题）；摘要进入上下文，原始消息仍在归档。
- 连续多段会与已有摘要合并成更高层（`level` 递增）的滚动摘要；最多保留一段当前摘要，避免摘要本身无限增长。
- `compressContext=false` 时只截断并提示“还有 N 条更早消息可用 grep”，原始归档不受影响。
- 压缩失败或超时降级为截断，并记录错误；不会删除原始消息。

### 4. 记忆（episodes / profiles）

- 每 `memoryExtractEvery` 条消息或每次回复后抽取：时间范围、参与者、主题、摘要、关键事实、重要性 0–1。
- 相似摘要按词汇 Jaccard + 参与者 + 时间窗口合并；重要性和时间范围取并集。
- 上限 `memoryMaxEpisodes`（50–2000）。淘汰分数 = 重要性 + 近期发生 + 最近更新。
- 玩家画像保存 traits / preferences / facts / notes / optOut；facts 上限 `memoryMaxFactsPerPlayer`。
- 检索是本地关键词 + BM25 + 时间/重要性/玩家/会话 boost，**不是向量检索**；没有 embedding，也不调用外部检索服务。

### 5. 隐私与遗忘

- `/ai forget me`：清空自己的 traits/preferences/facts/notes，删除包含自己的摘要，**删除自己发送的归档消息**，并设置 `optOut`。
- optOut 后不再记录、不抽取、不回复；`/ai remember me` 可恢复。
- `ignorePlayers` 支持名字或 UUID，逗号分隔；忽略的玩家不记录也不回复。
- 没有服务器管理员概念，因此插件不提供“遗忘其他玩家”的命令。

## 联网工具

设置 `webSearch = true` 后，模型可以调用 `search` / `fetch`：

- 默认 Bing：`https://www.bing.com/search?q=...`，解析标题、链接和摘要。
- 可切换到 DuckDuckGo（可能临时封 IP）。
- Bing/DuckDuckGo 重定向链接会解码成真实 URL。
- 网页抓取统一走 `https://r.jina.ai/<url>`，结果截断并标注来源。
- Google 搜索结果暂未实现。

## 思考级别

`thinkingLevel`：

- `off`：不传 `reasoning_effort`，提示词不要求分析。
- `low` / `medium` / `high`：写进 system prompt 的思考要求；OpenAI 兼容请求额外带 `reasoning_effort`。
- Anthropic / Gemini 没有统一的 reasoning 参数，用提示词 + 温度表达：`high` 会把温度压到不高于 0.4，`low` 不低于 0.75。
- 如果所用 OpenAI 兼容模型不接受 `reasoning_effort`，把它设为 `off`。

## API 适配

| 提供商 | 请求 | 解析 |
|---|---|---|
| `openai` | `POST {baseUrl}/chat/completions`，`Authorization: Bearer` | `choices[0].message.content`（字符串或 parts） |
| `anthropic` | `POST https://api.anthropic.com/v1/messages`，`x-api-key` + `anthropic-version: 2023-06-01` | `content[].text` |
| `gemini` | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=...` | `candidates[0].content.parts[].text` |

- 所有 LLM 请求 `timeoutMs = 60000`（宿主允许 1–120 秒，默认 10 秒）。
- 429/5xx/网络错误重试一次，退避由 tick 驱动（wasm 里不 sleep）；401/403 不重试。
- 非本机 API 地址必须 HTTPS；只有 `127.0.0.1` / `localhost` / `::1` 允许 HTTP，便于本地 mock。
- `apiKey` 只发给配置的 API host；Gemini 按官方要求放在 query，日志脱敏。
- 日志只记录状态码、长度、模型名、错误类别，不打印 Key、完整 prompt、聊天原文或网页内容。

## 设置项

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `provider` | select | `openai` | `openai` / `anthropic` / `gemini` |
| `baseUrl` | text | OpenAI `/v1` | 空或保留 OpenAI 默认值时，Anthropic/Gemini 用官方地址 |
| `apiKey` | password | 空 | 只存本机，不写日志 |
| `model` | text | `gpt-4o-mini` | 模型名 |
| `replyMode` | select | `mention` | off / mention / smart / auto / always |
| `thinkingLevel` | select | `medium` | off / low / medium / high |
| `smartChance` | slider | 15% | smart 模式对非问题消息的抽样概率 |
| `botName` | text | `AI` | 机器人名字；空则用账号名 |
| `aliases` | text | 空 | 逗号分隔 |
| `stylePrompt` | textarea | 空 | 回复风格提示词 |
| `replyPrefix` | text | 空 | 回复前缀 |
| `temperature` | slider | 0.7 | 0–1.5；思考级别会再微调 |
| `maxTokens` | slider | 600 | 128–4096 |
| `contextTokens` | slider | 32768 | 4096–131072 |
| `compressContext` | switch | true | 超预算时压缩更早对话 |
| `archiveRetentionDays` | slider | 0 | 0–3650；0=永久保留原始归档 |
| `traceEnabled` | switch | true | 记录模型 thought/工具轨迹 |
| `traceMaxEntries` | slider | 12 | 4–40 |
| `cooldownSec` | slider | 30 | 5–600 |
| `maxRepliesPerMin` | slider | 4 | 1–20 |
| `webSearch` | switch | false | 允许搜索/抓取 |
| `searchEngine` | select | `bing` | `bing` / `duckduckgo` |
| `maxToolSteps` | slider | **0（不限）** | 0–50；统计 grep/read/memory/search/fetch/send_message |
| `memoryEnabled` | switch | true | 画像/摘要/记忆检索开关；归档始终写入 |
| `memoryScope` | select | `server` | server / global |
| `memoryExtractEvery` | slider | 10 | 2–50 条 |
| `memoryMaxEpisodes` | slider | 400 | 50–2000 |
| `memoryMaxFactsPerPlayer` | slider | 60 | 10–200 |
| `ignorePlayers` | text | 空 | 名字或 UUID，逗号分隔 |
| `debug` | switch | false | 只输出长度/状态码等脱敏信息 |

已废弃：`contextMessages`、`memoryMaxMessages`、`memoryRetentionDays`。旧配置中的保留天数会映射到 `archiveRetentionDays`，条数限制被忽略。

## 隐私与成本

启用插件即意味着：

- 当前消息、最近上下文、归档/记忆摘要和检索结果会发送给你配置的模型服务商。
- 开启联网时，搜索关键词会发送给 Bing/DuckDuckGo，抓取目标 URL 和页面文本会经过 `r.jina.ai`。
- 每次回复、`auto` 决策、工具调用、记忆抽取和上下文压缩都会消耗模型 tokens；`auto` 模式每条消息都会请求模型，成本最高。
- `maxToolSteps=0` 表示不限次数，模型可能连续调用很多工具；需要控制成本时设置一个上限。
- 归档、记忆、设置和 API Key 只保存在本机插件目录；卸载时如需彻底删除，必须在市场卸载流程中确认删除数据。
- 模型输出被限制为聊天文本，插件不提供执行命令、移动、攻击、破坏方块或读取世界的权限。

## 已知限制

- 记忆检索是**关键词 + BM25 + 时间/重要性**，不是语义向量检索；同义改写可能搜不到。
- 归档是逐条写入的：每次聊天都会读改写当前 chunk（最多约 512 KB），高频服务器会带来一定的宿主存储开销。
- 时间显示使用 UTC；宿主事件没有时区信息。
- `auto` 模式每条消息都调用模型，延迟和成本明显高于 `mention`。
- OpenAI 兼容接口的 `reasoning_effort` 支持因模型而异；不支持时请设 `thinkingLevel=off`。
- 单条回复受宿主 256 字符限制。
- Google 搜索未实现。
- 市场/宿主版本升级后请重新安装以获取新 wasm。

## 开发与测试

```powershell
# 纯逻辑单元测试（归档 chunk、grep/read、token 估算、压缩、agent JSON、重复调用、auto、trace/UI、本地 mock HTTP）
cargo test --manifest-path plugins\ai-chat\Cargo.toml

# wasm 构建
cargo build --manifest-path plugins\ai-chat\Cargo.toml --target wasm32-unknown-unknown --release

# 或一次构建所有官方插件
powershell -ExecutionPolicy Bypass -File scripts\build-plugins.ps1
```

源码结构：

```text
src/abi.rs       wasm 导出与宿主 KV/net/chat/ui_publish 适配
src/agent.rs     agent 循环、JSON 工具、trace/panel、抽取调度、命令
src/context.rs   token 估算、历史切分、摘要预算
src/memory.rs    永久归档 chunk、grep/read、摘要存储、episodes/profiles
src/search.rs    分词、BM25、时间/重要性/玩家/会话 boost
src/llm.rs       OpenAI / Anthropic / Gemini 请求、reasoning_effort
src/html.rs      Bing / DuckDuckGo 解析、重定向解码、URL 安全
src/prompt.rs    系统提示、记忆/摘要注入、工具协议、压缩提示、不可信数据包裹
src/settings.rs  设置解析与脱敏摘要
```
