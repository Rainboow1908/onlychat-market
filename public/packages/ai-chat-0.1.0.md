# AI 聊天助手（ai-chat）

一个可上架 OnlyChat 市场的 WebAssembly 插件：让机器人在 Minecraft 聊天里回答问题，并把对话整理成**本地长期记忆**（玩家画像、对话摘要、关键词检索）。

- 插件 ID：`ai-chat`
- API：1
- 权限：`chat.receive`、`chat.send`、`net`
- 默认状态：安装后停用，需要手动启用并填写 API Key
- 依赖：OnlyChat 宿主 + 官方插件 SDK，不访问文件系统、世界、玩家动作或 UI

## 安装

1. 设置 → 插件 → 市场，安装「AI 聊天助手」。
2. 安装后保持默认停用，先打开插件详情填写设置。
3. 至少填写：
   - **API 提供商**：`openai` / `anthropic` / `gemini`
   - **API Key**
   - **模型**（默认 `gpt-4o-mini`；Anthropic 例如 `claude-sonnet-4-5`，Gemini 例如 `gemini-2.5-flash`）
   - **API 地址**：OpenAI 兼容默认 `https://api.openai.com/v1`；切换到 Anthropic / Gemini 且仍保留 OpenAI 默认地址时，插件会自动改用官方地址，也可以填自己的兼容网关。
4. 启用插件。聊天里发送 `/ai status` 可看到当前模式与记忆计数。

插件不读取其他插件的存储或聊天日志；所有记忆都在本插件自己的 `plugin-data` KV 中。

## 回复模式

| `replyMode` | 行为 |
|---|---|
| `off` | 不回复，但仍可在启用记忆时记录上下文（`ignorePlayers`/optOut 例外） |
| `mention` | 只有被名字、别名、`@名字` 或 `/ai` 命令点名时回复（默认） |
| `smart` | 点名直接回复；问题或按 `smartChance` 随机抽中的消息先做一次轻量 LLM 判断 |
| `always` | 所有玩家消息都可能回复，仍受冷却和每分钟上限约束 |

- `botName` 留空时使用当前账号用户名；`aliases` 用逗号分隔。
- 忽略 `self`、系统消息、指令回显、`ignorePlayers` 里的玩家和 optOut 玩家。
- 回复有每人冷却（`cooldownSec`）和全局每分钟上限（`maxRepliesPerMin`）。
- 宿主单条聊天限制 256 字符，插件会把回复压到 240 字符以内。

命令：

```text
/ai status                      当前模式、记忆计数、联网与工具设置
/ai memory search <关键词>       公开回复本地记忆命中（最多 2 条摘要 + 2 条事实）
/ai forget me                   删除自己的画像/事实/相关摘要，并 optOut
/ai remember me                 取消 optOut，恢复记录
```

`/ai memory search` 的回复是**公开发送到服务器聊天**的，别用它查询敏感内容。

## 记忆系统

记忆按服务器地址隔离（`memoryScope = server`），或所有服务器共享（`global`）。全部通过宿主的 `storage_get/storage_set` 保存，单 key 小于 1 MiB；写入失败只记录日志，不阻塞聊天。

### 1. 原始消息环

- 每条 `chat.message` 记录 `id、at、kind、sender uuid/name、text、self`。
- 每服务器默认保留最近 300 条（`memoryMaxMessages` 50–2000）。
- 每 80 条一个 chunk，meta 记录 chunk 列表；按条数/天数（`memoryRetentionDays`）淘汰。
- 单条文本截断到 512 字符。

### 2. 对话摘要（episodes）

- 每 `memoryExtractEvery` 条消息或每次回复后，用 LLM 抽取：时间范围、参与者、主题、摘要、关键事实、重要性 0–1。
- 相似摘要按词汇 Jaccard + 参与者 + 时间窗口合并；重要性和时间范围取并集。
- 上限 `memoryMaxEpisodes`（50–2000）。淘汰分数 = 重要性 + 近期发生 + 最近更新；因此既保留最近的事，也保留较早的高重要性事件。
- 索引和完整摘要分 key 存储；索引超过约 950 KB 时自动淘汰，避免超过宿主单值限制。

### 3. 玩家画像（profiles）

每个玩家 UUID 保存：

- 名字/别名、首次/最近出现、消息数
- 性格 traits：`tag + confidence + evidence + updatedAt`；新证据会提升或削弱置信度，低置信度会被清理
- 偏好 preferences
- 事实 facts：`text + importance + source + createdAt + lastUsedAt`
- 与其他玩家的关系 notes
- `optOut`

画像在抽取时合并，不会为每个路人立即创建空画像；每个玩家 facts 上限 `memoryMaxFactsPerPlayer`（10–200）。

### 4. 检索（本地关键词，不是向量检索）

查询 = 当前消息 + 最近上下文 + 玩家名。

- 分词：ASCII 单词 + CJK bigram；过滤中英文停用词和“的/吗/呢”等虚词 bigram。
- BM25 风格词项相关度；索引里保存每条摘要的高频词和主题。
- 最终分数 = 词项相关 + 时间衰减 + 重要性 + 同玩家/同会话 boost + 精确短语 boost。
- 默认返回 6 条摘要（追问时 8 条）和若干事实，并在 prompt 中明确写「记忆可能不完整或过时」。
- 追问线索（`之前/上次/以前/还记得/发生过/那个事/那次` 等）会扩大检索并提高旧高重要性记忆的权重。

没有 embedding/向量数据库，也不调用外部检索服务；只有本地关键词与时间/重要性排序。

### 5. 写入、容量与保留

- 抽取失败不阻塞聊天，下轮重试（最多 3 次后跳过当前批次）。
- 容量达到上限按重要性/时间淘汰，meta 记录累计淘汰数。
- `memoryRetentionDays > 0` 时按天清理原始消息、摘要、事实和过期画像；0 表示不限。
- 清理每小时最多处理少量 scope，避免一次 tick 做长时间同步扫描。

### 6. 隐私与遗忘

- `/ai forget me`：清空自己的 traits/preferences/facts/notes，删除包含自己的摘要，并设置 `optOut`。
- optOut 后不再记录、不抽取、不回复；`/ai remember me` 可恢复。
- `ignorePlayers` 支持名字或 UUID，逗号分隔；忽略的玩家不记录也不回复。
- 没有服务器管理员概念，因此插件不提供“遗忘其他玩家”的命令，避免任何人借机器人删别人的记忆。

## 联网工具

设置 `webSearch = true` 后，模型可以请求：

```json
{"action":"search","query":"..."}
{"action":"fetch","url":"https://..."}
```

- **默认搜索引擎是 Bing**：`https://www.bing.com/search?q=...`，带正常浏览器 User-Agent；会解析标题、链接和摘要。
- 可在 `searchEngine` 切换到 **DuckDuckGo**（`html.duckduckgo.com`）。DuckDuckGo 可能临时封 IP，所以默认用 Bing。
- Bing 的重定向链接（`bing.com/ck/a?...u=a1...`）会解码成真实 URL；DuckDuckGo 的 `uddg` 参数同样解码。
- 网页抓取统一走 `https://r.jina.ai/<url>`，不直接抓任意 HTML；结果截断 4000 字符并标注来源。
- 拒绝 localhost、内网、链路本地和带用户信息的 URL。
- **Google 搜索结果暂未实现**，设置里只提供 Bing / DuckDuckGo，不会假装支持。
- `maxToolSteps`：默认 **0 = 不限**，范围 0–50。0 时没有固定调用次数上限；设置 >0 时才按该数字限制。
- 防死循环：相同 query/url 重复时不会再次执行，会收到“不要重复”的提示；连续重复两次后直接发送一条兜底回复。该保护不是调用次数限制。

工具协议：

```json
{"action":"reply","text":"..."}
{"action":"search","query":"..."}
{"action":"fetch","url":"..."}
{"action":"memory","query":"..."}
```

工具结果会回填给模型继续推理，最终必须给出 `reply`。JSON 解析失败会纠正一次；再失败时，如果模型给的是纯文本就按纯文本兜底。

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
| `replyMode` | select | `mention` | off / mention / smart / always |
| `smartChance` | slider | 15% | smart 模式对非问题消息的抽样概率 |
| `botName` | text | `AI` | 机器人名字；空则用账号名 |
| `aliases` | text | 空 | 逗号分隔 |
| `stylePrompt` | textarea | 空 | 回复风格提示词 |
| `replyPrefix` | text | 空 | 回复前缀 |
| `temperature` | slider | 0.7 | 0–1.5 |
| `maxTokens` | slider | 600 | 128–4096 |
| `contextMessages` | slider | 12 | 0–50 |
| `cooldownSec` | slider | 30 | 5–600 |
| `maxRepliesPerMin` | slider | 4 | 1–20 |
| `webSearch` | switch | false | 允许搜索/抓取 |
| `searchEngine` | select | `bing` | `bing` / `duckduckgo` |
| `maxToolSteps` | slider | **0（不限）** | 0–50；0 表示不限 |
| `memoryEnabled` | switch | true | 本地记忆总开关 |
| `memoryScope` | select | `server` | server / global |
| `memoryExtractEvery` | slider | 10 | 2–50 条 |
| `memoryMaxEpisodes` | slider | 400 | 50–2000 |
| `memoryMaxFactsPerPlayer` | slider | 60 | 10–200 |
| `memoryMaxMessages` | slider | 300 | 50–2000 |
| `memoryRetentionDays` | slider | 0 | 0–3650，0=不限 |
| `ignorePlayers` | text | 空 | 名字或 UUID，逗号分隔 |
| `debug` | switch | false | 只输出长度/状态码等脱敏信息 |

## 隐私与成本

启用插件即意味着：

- 当前消息、最近上下文、玩家画像摘要和检索到的记忆会发送给你配置的模型服务商。
- 开启联网时，搜索关键词会发送给 Bing/DuckDuckGo，抓取目标的 URL 和页面文本会经过 `r.jina.ai`。
- 每次回复、每次记忆抽取都会消耗模型 tokens；`memoryExtractEvery` 越小，抽取越频繁、成本越高。
- 记忆、设置和 API Key 只保存在本机插件目录；卸载时如需彻底删除，必须在市场卸载流程中确认删除数据。
- 模型输出被限制为聊天文本，插件不提供执行命令、移动、攻击、破坏方块或读取世界的权限。

## 已知限制

- 记忆检索是**关键词 + BM25 + 时间/重要性**，不是语义向量检索；同义改写可能搜不到。
- `chat.message` 事件没有“回复了哪条消息”的字段，因此无法用“引用回复机器人”作为触发条件；支持 `@名字`、名字、别名和 `/ai`。
- 抽取质量取决于模型；插件只接受聊天里真实出现过的玩家名字对应的 UUID，拒绝模型编造的参与者。
- 单条回复受宿主 256 字符限制。
- Google 搜索未实现。
- 市场/宿主版本升级后请重新安装以获取新 wasm。

## 开发与测试

```powershell
# 纯逻辑单元测试（分词、评分、去重、容量、retention、optOut、profile/episode 合并、chunk、损坏 JSON、Bing/DDG 解析）
cargo test --manifest-path plugins\ai-chat\Cargo.toml

# wasm 构建
cargo build --manifest-path plugins\ai-chat\Cargo.toml --target wasm32-unknown-unknown --release

# 或一次构建所有官方插件
powershell -ExecutionPolicy Bypass -File scripts\build-plugins.ps1
```

源码结构：

```text
src/abi.rs       wasm 导出与宿主 KV/net/chat 适配
src/agent.rs     回复判定、LLM 请求、工具循环、抽取调度
src/memory.rs    消息环、episodes、profiles、容量/保留/遗忘
src/search.rs    分词、BM25、时间/重要性/玩家/会话 boost
src/llm.rs       OpenAI / Anthropic / Gemini 请求与响应
src/html.rs      Bing / DuckDuckGo 解析、重定向解码、URL 安全
src/prompt.rs    系统提示、记忆注入、工具协议、不可信数据包裹
src/settings.rs  设置解析与脱敏摘要
```
