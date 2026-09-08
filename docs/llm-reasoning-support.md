# LLM 深度思考（推理模式）支持方案

> **⚠️ 本文档已被 V0.5.3 拆分（2026-09-08）**
>
> 当时「深度思考」只有一种语义。V0.5.3 起拆为**两种彼此独立的模式**，本文档只描述其中一种：
>
> | 模式 | 设置项 | 本质 | 本文档是否覆盖 |
> | --- | --- | --- | --- |
> | 模式一 **CoT 引导** | `cotGuide`（关闭/简/标准/深入） | 本地提示词工程：给模型一段思考脚手架，规定按几步想、每步多长、思考要不要写进正文 | ❌ 不覆盖，见 `js/llm.js` 的 `buildCoTGuide()` 与 CHANGELOG V0.5.3 |
> | 模式二 **推理模型** | `reasoning`（关闭/低/中/高） | 调用服务商原生思考通道（`reasoning_content`），结构与时长由供应商决定 | ✅ 本文档描述的就是它 |
>
> 阅读本文档时，请把文中的「深度思考」理解为**模式二**。以下原文保留作为历史决策记录。

- 版本：v1.0（待评审）
- 日期：2026-09-06
- 目标：在 LLM 设置面板为 human/red/black 三组分别提供「深度思考」开关（含强度档）；开启后按服务商形态下发推理参数；思考过程以**默认折叠**的气泡展示，可点开查看；思考内容不进对话历史。
- 现状基线：项目对推理模型零支持（请求体无推理参数、`temperature`/`max_tokens` 硬编码、`reasoning_content` 被丢弃、30s 超时），详见下方「现状约束」。

---

## 一、现状约束（改动必须遵守）

| # | 约束 | 位置 | 影响 |
|---|---|---|---|
| C1 | LLM 三组配置由 `normalizeLlm` **整组白名单规整**，未列入的字段一律丢弃 | main.js:63-76 | 新增字段必须在 normalizeLlm + DEFAULT_LLM_GROUP 同时登记，否则写了也白写 |
| C2 | 请求体只含 model/messages/stream/temperature/max_tokens；temperature/max_tokens **恒下发、无省略路径** | llm.js:126-134 | o1/o3/gpt-5 会 400（不支持这两个参数） |
| C3 | 流式解析只读 `delta.content`，`delta.reasoning_content` 静默丢弃 | llm.js:51-82 | 思考过程不可见；部分实现会出现"长时间空白" |
| C4 | 超时硬编码 30s（DEFAULT_TIMEOUT），调用点均未覆盖 | llm.js:84 | 推理模型常超时 |
| C5 | 服务商预设 6 家（openai/deepseek/glm/qwen/kimi/custom），表单行模式 `label + input/select`，收集/回填/autofill/测试四处接线 | index.html:257-291 等；main.js:952-1006, 1295, 1330 | UI 新增行必须同步四处接线 |
| C6 | 气泡渲染为 `div.msg.ai > div.bubble`（textContent），无 Markdown 渲染；点击气泡 = 重听 TTS | chat.js:160-180 | 思考展示不能依赖 Markdown 解析，用原生 `<details>` |
| C7 | 对话历史只存 `{role, content}` 纯文本，回灌模型；保留 20 条 | chat.js:361-362, 408-412 | 思考内容**不得**进 history（防污染上下文与缓存前缀） |
| C8 | 流式正文通过 `onDelta(piece)` 回调累积，TTS 分句朗读 content | chat.js:367-380 | 思考与正文必须分流：TTS 只读正文 |

---

## 二、设计

### 2.1 配置层：三组各自独立，字段互不牵连

`llm.{human,red,black}` 每组新增一个字段（默认值如右）：

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `reasoning` | string | `'off'` | `off` 关闭推理（零行为变化，不省略任何参数）；`low / medium / high` 三档强度，映射各家服务商的强度参数 |

决策记录（2026-09-06 评审拍板）：**强度取三档制（off/low/medium/high）**，不做 token 预算数字输入；**全部默认 off**，不引入 auto 嗅探档——推理由用户显式开启。模型名嗅探仍存在，但职责收窄为「决定该模型适用哪种参数形态」（见 2.2），不再作为开关语义。

理由：三组独立是项目既有架构（人机/红/黑各一套 key 与模型），推理开关理应跟随。默认 off 保证存量用户零行为变化（temperature/max_tokens 仍照旧发送）。

### 2.2 请求层：参数形态按服务商分派（llm.js）

`baseBody` 重构为：带推理时**不发送 temperature**（OpenAI 系推理模型只接受默认/1；DeepSeek/Qwen 若带 temperature 亦安全），并按下表追加字段（强度映射：low/medium/high → 各家对应档位）：

| 服务商 / 形态 | 触发条件（模型名嗅探） | 追加参数 |
|---|---|---|
| OpenAI o1/o3/gpt-5 系 | model 匹配 /o[13]-|o3|gpt-5/ | `reasoning_effort: low/medium/high`；token 上限改发 `max_completion_tokens`（删 `max_tokens`） |
| DeepSeek reasoner | model 含 `reasoner` | 无附加参数（思考内建）；token 上限**放大**（思考可能吃满 max_tokens） |
| 通义 Qwen3 系 | model 含 `qwen3` | `enable_thinking: true`（关=不发送，但开启时嗅探不命中会回落到通用 effort 参数） |
| 智谱 GLM-4.5/4.6 | model 含 `glm-4.5/4.6` | `thinking: {type:"enabled"}`（budget 交服务商默认，不做数字输入） |
| 其它 / 自定义 | 兜底（嗅探不命中） | `reasoning_effort: low/medium/high`（多数 OpenAI 兼容网关可容忍；不可容忍者连接测试会暴露 400，此时应关掉该组推理） |

嗅探函数 `reasoningParams(profile, opts)` 集中实现、纯函数可单测：**推理=off 时返回空**（一行参数都不加，行为与现状完全一致）；`max_tokens → max_completion_tokens` 仅在确认支持该字段的模型上切换，避免破坏存量兼容。

### 2.3 流式：reasoning_content 不展示（llm.js parseSSE）

思考内容**不上抛、不渲染**（见 2.5 已移除说明）。`parseSSE` 维持单通道（只读 `delta.content`，`reasoning_content` 静默忽略），`requestFull` 返回对象不含 thinking 字段——所有调用点零改动。

### 2.4 UI：设置面板每行加「深度思考」

每个 LLM 组（human/red/black）的 fieldset 内、`函数调用` 行之后追加一行：

```
深度思考  [单选：关闭 / 低 / 中 / 高]   hint: 开启后按服务商形态下发推理参数（如 OpenAI reasoning_effort）
```

接线点（对 C5 的四处）：
- IDS 收集：main.js:165 附近数组加 `setHumanReasoning` 等 3 个 id
- 回填：main.js:952-954 同区段读取 `llm.X.reasoning`
- 收集保存：main.js:1006-1008 同函数补一字段
- 联动：开启推理且当前模型名嗅探为 reasoner 时，useFc 行给出警示文案「该模型不支持函数调用，将自动走 JSON 降级」

### 2.5 思考展示：已移除（2026-09-06 实测后否决）

曾实现「💭 思考过程」折叠区（`<details>` 默认折叠、点开查看），实测后认为**把模型思维链亮给玩家会破坏沉浸感、容易出戏**，已整体移除展示层：

- chat.js 的 ensureThinkBox/details 渲染、llm.js 的 onThinking 双通道与 requestFull.thinking 字段全部删除；
- `reasoning_content` 在 parseSSE 流式解析层静默忽略（留注释说明）；
- 深度思考的**参数下发照常**（模型确实在思考、等待时间变长），玩家视角仅多等一会儿，不显示任何思维链内容；
- 对话历史天然不含思考内容（从未写入）；TTS 只朗读正文（无需特判）。

结论：**「推理参数下发」与「思考内容展示」彻底解耦**——前者保留为 V0.5.1 功能，后者永不实现。

### 2.6 超时

- 新增全局设置 `llmTimeout`（秒，默认 60，范围 15~300），`postChat` 的 timeoutMs 改读它；推理开启时建议翻倍或按 `max(当前值, 90)`。
- 不新增每调用点参数，改动面最小。（此项未在本次评审拍板范围内，实施前如需一并做请确认）

---

## 三、实施步骤（已执行完毕；展示相关步骤已回滚）

| 阶段 | 内容 | 验证 | 状态 |
|---|---|---|---|
| P0 | llm.js：`reasoningParams` 嗅探 + baseBody 参数分派 + max_completion_tokens 分支 + 超时读设置 | 新增 llm 纯函数单测（参数构造断言，mock fetch） | ✅ 完成（test_llm_reasoning 30 项） |
| P1 | main.js：DEFAULT_LLM_GROUP + normalizeLlm 白名单加字段 + 表单接线 + useFc 联动警示 | 设置保存/回填冒烟 | ✅ 完成 |
| P1 | ~~chat.js 思考折叠渲染~~ | — | ↩️ 已随展示移除回滚（见 2.5） |
| P2 | index.html：三组深度思考单选组 + 超时单选组 + CSS | 视觉冒烟 | ✅ 完成 |
| P2 | 观战联动：spectateInterval 提示（开推理后建议调大间隔） | 手动 | ✅ 完成 |
| P3 | 收尾：单文件重建、CHANGELOG V0.5.1、memory 日志 | 全量 303 项 | ✅ 完成 |

## 四、风险与开放问题

1. **各家参数不兼容是常态**：方案用「模型名嗅探决定参数形态」收敛，用户乱填模型名时嗅探失败 → 回落到通用 `reasoning_effort`；不可容忍的服务商靠连接测试暴露 400，此时应手动关闭该组推理。
2. **OpenAI 系非流式+FC 不可用**（o1-mini 不支持 tools）：FC 已在 main.js:704-711 有文本二次降级，可兜底。
3. 思考 token 计费按模型厂商规则，UI 无法干预（仅 DeepSeek/Qwen 等已含思考费）。
4. **已拍板决策**（2026-09-06）：三档强度 off/low/medium/high；默认全 off；思考仅查看、默认折叠、无附加按钮；不做 token 预算数字输入、不做 auto 档。**待实施前确认**：超时设置 llmTimeout 是否随本批一并做。
