# 更新日志 Changelog

## [V0.5.3] - 2026-09-08

### 🧩 深度思考拆成两种独立模式：CoT 引导 / 推理模型

**背景**：V0.5.1 的「深度思考」只有一个语义——下发服务商推理参数，思考结构与时长完全由供应商决定，等待动辄几十秒且本地无法约束。本版把「深度思考」拆成两条互不干涉的路径，让"想多久、按什么步骤想"这件事回到本地手里。

| | 模式一 **CoT 引导** | 模式二 **推理模型** |
| --- | --- | --- |
| 本质 | 本地提示词工程：给模型一段思考脚手架 | 调用服务商原生思考通道（`reasoning_content`） |
| 谁在想 | 模型（按本地给定的步骤与字数上限想） | 模型（在供应商侧想，本地管不着） |
| 本地能控什么 | 步数、每步字数、是否写进正文、思考要点去哪 | 只有强度档位 |
| 模型要求 | 任何模型 | 需模型本身支持推理 |
| 等待代价 | 几乎不增加 | 明显变长 |
| 超时放大 | +10 秒 | 抬到 ≥90 秒 |

- **模式一实现**（`js/llm.js` 新增纯函数 `buildCoTGuide(level, kind)`）：按档位（off/brief/standard/deep → 2/3/4 步，每步 ≤12/20/30 字）与任务类型（move/analyze/taunt/good/review/undo/comment/chat）生成脚手架指令。`move` 场景要求把推演要点写进 FC 的 `thought` 字段，其余场景要求"只是内部依据，不要写进回答正文"。`off` 时返回 `null`，保证 prompt 与改动前**逐字节一致**。
- **注入点**：`js/main.js` `aiPick` 的 `sysHead`（放在好感度段**之前**，内容跨回合恒定，保住 Prompt Cache 前缀命中）；`js/chat.js` 的统一出口 `withCoT()` —— 供 `kindInstruction`、自由聊天、悔棋裁决复用。走子链路在 CoT 开启时给 `thought` 追加 token 预算（brief/standard/deep = +70/+110/+160），避免思考挤掉最终选择。
- **模式二保持不变**：`inferReasoning()` 语义收窄为"推理模型参数下发"，注释中明确与模式一互斥独立，两者可各自开关也可同时开。
- **超时语义分离**（`effectiveTimeout`）：仅开 CoT = 设置值 +10 秒；仅开推理模型 = 抬到 ≥90 秒；两者同开按更严格的推理模型处理。
- **设置面板**（`index.html`）：三组 LLM 页签的「深度思考」一行拆为两行独立单选组——「CoT 引导」（关闭/简/标准/深入）与「推理模型」（关闭/低/中/高），**均默认关闭**；两组 hint 分别说明语义与等待代价。一般设置的超时 hint 同步改写。
- **配置层**：`DEFAULT_LLM_GROUP` 与 `normalizeLlm` 白名单新增 `cotGuide` 字段（非法值回落 off）；main.js 单选组读写重构为通用 `radioId/radioValue/setRadio`，`cotValue/setCotRadio` 与 `reasoningValue/setReasoningRadio` 共用。
- **测试**：新增 `tests/test_cot_guide.js`（39 项：off 零文本、档位步数与字数、move 走 thought 字段、模板步数不足时截断、两种模式互不干涉、超时三种组合）；smoke_dom 补 8 项断言——DOM id 契约加三组各 5 个 CoT id，并验证**关闭时指令与改动前逐字节一致**（off 不追加任何字符、事实段原样保留、切回 off 可完全还原）、开启时事实段仍在脚手架之前；CI 顺带补入此前漏挂的 `test_llm_reasoning` 与 `test_logger` → 全量 **396 项通过**（engine 47 / affinity 59 / fc 37 / llm_reasoning 30 / logger 19 / react_judge 23 / cot_guide 39 / smoke 142）；单文件版已重建。
- **单文件产物规范化**：仓库里的 `ai-chinese-chess.html` 此前带 365 处 `data-page-node-id` 属性（外部编辑器注入，源码 `index.html` 从未有过），导致 CI 的「校验构建产物最新」步骤在 V0.5.2 就已失败（非本次引入）。本版重新构建后该属性被剥离，检查恢复通过；构建脚本本身已验证幂等（连续两次构建零差异）。

## [V0.5.2] - 2026-09-08

### 🎯 好棋/臭棋判定重写：不再把"吃子后被反吃"当成好棋

**问题**：玩家走坏棋（尤其是"吃子后被反吃"）时，AI 仍按好棋夸奖。根因在判定层而非 LLM——旧逻辑只比较走子前后的静态评估之差（`|swing| ≥ 150` 即定性），静态评估看不到对手应手，于是"吃到子"必然是巨大正分。

- **实测误判数据**（`scripts/probe_swing.js` / `probe_swing_dist.js`）：开局 44 个走法中判好棋 2 个（全是"炮打底马"这类公认坏棋）、判臭棋 **0** 个（最低仅 -89，因悬子惩罚只有子力/8，车仅 -113）、其余 42 个不反应——正着（中炮、马八进七）一个都认不出来。
- **两级判定**（`js/main.js` `maybeReact`）：① 静态闸门 `|swing| ≥ 150` 过滤平淡着法（省性能）→ ② 搜索复核 `AI.moveLoss` 量化"这一步相对引擎最优着法的亏损"。
- **新增 `AI.moveLoss` / `AI.classifyLoss`**（`js/ai.js`）：`loss = (-search(走后, 对手).score) - search(走前, 走子方).score`（换算到走子方视角，搜索分是「当前搜索方」视角，取负号别漏）；分档 `good ≥ -30 → +3`、`blunder ≤ -120 → -3`、`terrible ≤ -350 → -5`，中间区间不反应；搜索不可用时回退旧静态判定。
- **提示词中性化**（`js/chat.js`）：good/taunt 指令不再写死"这是一步好棋/臭棋"，改为"对手刚走了一步棋，走法与引擎评估见后，请你自己判断"；extra 只给事实（走法 + 与最优着法的分差 + 更优着法），语气交还人设与模型。
- **效果**（`scripts/probe_prompt.js`）："车吃马被黑车反吃"静态 +492（旧：夸）→ 复核 -514（新：严重臭棋 -5 + 中性提示词）；"安全吃马"→ 好棋 +3；"炮打底马"（净亏约 50）→ 不反应，不再误夸。
- **测试**：新增 `tests/test_react_judge.js`（23 项：分档边界、安全吃马/被反吃/炮打底马三类场景、红黑双方视角对称）→ 全量 **349 项通过**（engine 47 / affinity 59 / fc 37 / llm_reasoning 30 / logger 19 / react_judge 23 / smoke 134）；单文件版已重建。

## [V0.5.1] - 2026-09-06

### 🧠 LLM 深度思考（推理模式）支持
按 `docs/llm-reasoning-support.md` 方案落地，评审拍板：三档强度（off/low/medium/high）、默认全 off、思考仅查看默认折叠、不做 token 预算输入。

- **配置**（`llm.{human,red,black}` 各加 `reasoning` 字段，main.js `DEFAULT_LLM_GROUP` + `normalizeLlm` 白名单，非法档位回落 off）：默认 off = 请求体与 V0.5.0 逐字节一致，存量行为零变化；另加全局 `llmTimeout`（秒，15~300，默认 60）。
- **请求层**（`js/llm.js`）：新增纯函数 `inferReasoning`（模型名嗅探→参数形态分派）——OpenAI o1/o3/gpt-5 系发 `reasoning_effort` + 改 `max_completion_tokens`（4096 下限，省略 temperature）；DeepSeek reasoner 无附加参数但回答上限放大到 2048；通义 Qwen3 发 `enable_thinking:true`；智谱 GLM-4.5/4.6 发 `thinking:{type:"enabled"}`；未命中兜底发 `reasoning_effort` 并省略 temperature。超时：llmTimeout 生效，深度思考开启时自动 ≥90s。
- **流式双通道**（`parseSSE`）：`delta.reasoning_content` 经新 `onThinking` 回调送出；现有 `onDelta` 语义不变（所有调用点免改）。`request` 非流式也支持 onThinking 传出；`requestFull` 返回对象新增 `thinking` 字段。
- **思考过程不展示**：模型真实深度思考照常进行（推理参数照发、耗时照常），但 `reasoning_content` 在流式解析层即被静默忽略、不上抛——曾实现"💭 思考过程"折叠展示（details 默认折叠），实测后认为把模型思维链亮给玩家会破坏沉浸感，故整体移除展示层（chat.js 渲染、llm.js onThinking 双通道、think CSS、相关断言）；开思考的玩家视角只是回复前多等一会，与人设/角色氛围不冲突。
- **设置面板**：三组 LLM 页签各加「深度思考」单选组（关闭/低/中/高）；一般设置页加「LLM 请求超时」单选组（30/60/90/120/180 秒，默认 60，存量值就近取档；开深度思考自动 ≥90 秒）；reasoning 开启且模型为 o 系列/reasoner 时，函数调用行联动警示「不支持 FC，走 JSON 降级」（main.js updateFcWarnings）。
- **测试**：新增 `tests/test_llm_reasoning.js`（30 项：inferReasoning 各家嗅探/off 零参数/请求体抓包/max_completion_tokens/白名单），smoke_dom（思考折叠渲染相关断言已随展示移除，DOM 桩曾补 insertBefore 现保留为通用能力）→ 全量 **303 项通过**（engine 47 / affinity 59 / fc 37 / llm_reasoning 30 / smoke 130）；单文件版已重建。
- **备忘**：o1-mini 等不支持 FC 的模型走文本二次降级（main.js 既有路径）；所有路径均不展示思考过程（走子/聊天/复盘统一表现为"思考中"状态 + 正常延迟）。
- **复盘棋谱回合标注**：注入复盘 prompt 的完整棋谱序号由"每半手 +1"改为"回合制"（`1.红炮二平五 1.黑马8进7 2.红马二进三 2.黑车9平8`），review 指令示例同步改为按回合引用；`Chat.movesRecordText` 导出供测试（smoke +1，共 310 项通过）。
- **设置 UI 优化**：「深度思考」由下拉改为四档单选按钮（关闭/低/中/高，radio 组冒泡监听）；「请求超时」由输入框改为**五档单选**（30/60/90/120/180 秒，默认 60，存量配置值就近取档如 45→60；开深度思考仍自动 ≥90 秒）。相关 main.js 单选组读写 helper（reasoningValue/setReasoningRadio、timeoutValue/setTimeoutRadio）替代原 select/input 的 .value 契约。
- **运行日志系统**（`js/logger.js` 新建，V0.5.1）：环形缓冲内存 1000 条 + localStorage 持久最近 300 条（防抖写盘、跨刷新可追溯）；类别 llm/engine/settings/app/error × 级别 info/warn/error；**脱敏**（apiKey/token/secret 类字段丢弃、sk-…/Bearer 打码、字段值截断 300）；设置弹窗新增第 4 页签「📜 日志」（类别/级别筛选、列表、清空、导出 JSON）。
  - 插桩：llm.js `postChat` 统一记每次请求成功/失败/耗时（覆盖走子/聊天/复盘/连接测试全部路径，用户主动取消不记）；fc.js `markFallback` 记 FC 降级；ai.js 搜索 >200ms 记慢搜索；main.js `AppSettings.set` 记设置变更、全局 error/unhandledrejection 记未捕获错误。
  - settings-tabs.js `VALID_KEYS` 硬编码三键改为从 `.stab[data-pane]` 动态推导（支持任意页签数）。
  - 新增「LLM 诊断」开关（`showDiagnostics`，一般设置页，默认关）：开启后 aiPick 走子兜底（LLM 异常/JSON 无效）时用系统行轻提示原因，默认关保持沉浸感——解决此前"静默降级无痕迹"问题。
  - 测试：新增 `tests/test_logger.js`（19 项：裁剪/持久化 300+跨重载/脱敏/筛选/clear/export），smoke +4（Logger 挂载、settings.change 记录、日志面板 id 契约）→ 全量 **326 项通过**（engine 47 / affinity 59 / fc 37 / llm_reasoning 30 / logger 19 / smoke 134）；单文件版已重建。

## [V0.5.0] - 2026-09-05

### ♟️ 引擎大升级：搜索增强 + 评估增强 + 开局库（方案 A 纯 JS 强化）

- **背景**：按 `docs/engine-upgrade-feasibility.md` 方案 A 执行——不换引擎、不引依赖，在现有 `engine.js + ai.js` 上补齐缺失项，目标从"业余初级"升到"业余中级"，同时保持 MIT + 单文件 + 零依赖。
- **搜索增强**（`js/ai.js` 重写）：
  - Zobrist 64 位哈希（双 32 位 lo/hi，确定性 xorshift32 生成，跨会话可复现）+ 置换表（30 万条目上限，深度/flag/分数/最佳走法，将杀距离按 ply 归一化存取）
  - PVS 主变搜索、杀手启发（每层 2 个）、历史启发（按棋子×目标格累计，溢出右移保护）
  - 空步剪枝（depth≥3 且有车马炮时启用，残局安全）、LMR 延迟削减、将军延伸
  - 新增 `ChessAI.reset()`：清空 TT 与启发式表，供基准测试隔离局间污染（正常对局不清，TT 跨步复用是特性）
- **评估增强**（`js/engine.js`）：
  - 新增 3 张位置表：兵表 P_TABLE 改为过河深入递增（旧表过河后全 0、且红黑不镜像导致黑兵"未过河先得分"）、车表 R_TABLE（鼓励过河控线）、士表 A_TABLE + 象表 B_TABLE（首次让引擎懂防守阵型）
  - 新增动态项：机动性（按棋子类型加权）、悬子威胁（被攻无保按子力 1/8 扣分）、九宫受攻、士象齐全防线奖励
  - **双速评估**：搜索只认 `evaluateFast`（子力+位置表，~0.5µs）——完整 `evaluate`（含动态项）比快速版慢 13 倍，直接进内循环会让深度掉 3 层。曾尝试"root 候选校正增量"（把完整评估与快速评估的差值补进候选分）并加 `!aborted` 守卫，两级实测证伪后**整体移除**：超时打断下自对弈得分率 100% → 5%（校正加在"本层精确分/上层陈旧分"异质混合上）；加守卫后仍 15% vs 无校正 67%——本质是用"1 层深度的动态判断"覆盖"6 层深度的搜索判断"，方向性错误。`evaluate()` 完整版保留给 evalSummary/UI 展示，不进搜索决策
- **开局库**（`js/book.js` 新建）：15 条手工编制主流开局线（中炮屏风马/顺炮/列炮/反宫马/飞相/起马/仙人指路等，前 4-8 手），坐标串书写、引擎自动展开为 FEN→走法映射（出现频次即权重），`legalMoves` 逐手校验、编错的线自动截断不崩库；命中时库走法提到候选首位（LLM 仍有完整候选可选，降级引擎 top1 即谱着）
- **棋力验证**（整局自对弈 `tests/bench_engine.js`：200ms/步、depth 6、每局前 `reset()` 隔离 TT、开局随机 4 手、20 局/组换先后手）：
  - **全量（新搜索+新静态表）vs 旧版：92.5% 得分率**（17 胜 0 负 3 和）
  - 消融归因：搜索改造单独贡献 95.0%（vs 旧版）；新静态表 vs 旧评估（同搜索 head-to-head）62.5%——两者都是真实增益
  - 诊断历程三段教训：① 最初"-6.3% 评估负增益"是消融脚本缺 `reset()` 的 TT 跨局污染 + 80ms 时间截断不确定性制造的假象；② 配对位置分测试（eval_match）曾显示动态校正 +164/+320，后判定为**代理信号失真**——旧评估裁判被"机动性优化"系统性欺骗（goodhart），引擎改动的最终裁判只能是整局自对弈；③ root 动态校正经两级证伪（无守卫 5%、有守卫 15% vs 无校正 67%）后移除
- **测试基础设施**：
  - `tests/bench_engine.js`：性能（节点/耗时/固定预算可达深度）+ 一步杀题库（规则保证 ground truth）+ 新旧引擎自对弈
  - `tests/eval_match.js`：配对局面棋力测试（连续位置分信号，噪声约为整局对弈 1/5）；固定深度 + 时间仅作安全网（5000ms），否则截断引入不确定性（自检实测漂移 ±64 分）
  - `tests/ablation_eval.js`：逐项消融（每局前双方 `reset()`，前向选择变体）
  - `tests/fixtures/legacy-{engine,ai}.js`：git HEAD 基线快照
- **测试**：engine 47（+6 开局库）/ affinity 59 / fc 37 / smoke 126 → **269 项全过**；单文件版已重建
- **备忘（方案 A 剩余项）**：Web Worker 化（单步 80-200ms 暂未卡 UI，>500ms 再做）、难度档位重新标定（配合新引擎强度，后续版本处理）

## [V0.4.2] - 2026-09-05

### 🚀 优化：AI 对战提示词结构提升 LLM 前缀缓存命中率
- **背景**：`aiPick` 给 LLM 的 system prompt 原本把人设头/任务/输出格式/好感度提示和 FEN/候选列表/轮次颜色交叉穿插——每步走子都换，导致大部分稳定内容根本进不了前缀缓存（前缀缓存按 byte 严格匹配，中间一字符不同就全废）。
- **P1 sys 重排 + user 拆分**（main.js `aiPick`）：稳定段（人设头 / 任务 / 输出格式 / 好感度）全部置顶为 `sysHead`；易变段（轮次 + FEN + 候选列表 + 选子规则）后置到 `userHead + userTail`；"现在轮到你走子"也从 system 移到 user，user message 不参与 prefix cache、无须顾虑长度稳定。
- **P2 好感度三合一**：三档（≥80 / 中 / <30）文案从三种不同长度合并为统一模板 `【好感度】{3 位数字}/100（单字）。{固定 tip}。`；跨档切换时字符差异从 ~80 字节降到 ~5 字节，缓存 key 不再因为好感度档位跨档而失效。观战/固定档时插固定占位 `【好感度】 n/a 。            （观战/固定档不启用）。`。
- **P3 候选列表定长**：每条候选字符串改为 `NN. {notation 占 4}({coord 4} 评分{± + 4 位})\n`（评分始终 5 字符：符号 1 + 绝对值 4 位空格填充），吃子行尾追加 ` 可吃{方}{名}`；同局面下整个 list 字符串字节级一致，下次走子回到同局面（FEN + 候选皆不变）→ list 字符级命中 100%。
- **P4 系统指令并入 persona 文件**（personas.js）：把 `【任务】+【输出格式】` 从 main.js 字符串模板抽出，新增 `Personas.SYSTEM_PROMPT_COMMON` 常量与 `Personas.systemHead(persona)` 工厂；每个 persona 新增 `systemPrompt` 字段（默认空字符串，0 行为变化），per-persona 增量可挂在【本对手专属指令】段；`add/update` 兼容缺字段的自定义人设。好处：(1) 修改 AI 提示词不必动 main.js；(2) cache key 粒度细化到 per-persona × profile，同 persona 跨回合字符级命中。
- **回归覆盖**（smoke_dom 新增 5 条）：P1+P4 sys head 含【任务】+【输出格式】、P1 user 段含 FEN 与"候选走法（编号"、P2 sys 含【好感度】统一标签、P3 候选字符串匹配定长评分正则、P4 `Personas.systemHead` 函数与 `SYSTEM_PROMPT_COMMON` 常量存在。
- 测试：共 **263 项**全部通过（engine 41 + affinity 59 + fc 37 + smoke 126）；单文件版（`ai-chinese-chess.html`，约 225KB）已重建。
- **不破坏观战缓存残废的根因**（备忘）：观战模式下 sys 起点每手在"红""黑"之间切换（两个不同 persona），prefix cache 无法跨 persona 命中；唯一补救是让红黑两侧各自接独立 provider（已在 V0.4.0 完成），每方各自吃自己的 sys head 缓存。

## [V0.4.1] - 2026-09-05

### 🎛️ 新增：设置弹窗页签化（一般设置 / 对弈LLM / 观战LLM 三页签硬切换）
- **背景**：V0.4 已把 LLM 配置拆为三组（`settings.llm.{human,red,black}`），但 UI 层仍是一整列 fieldset，红/黑两组没有入口。本版本把设置弹窗重构为页签 UI，让三组 LLM 配置真正"按需展开、各自独立"。
- **组件**（`js/settings-tabs.js` 新建）：`SettingsTabs.init(opts) / switchTo(key) / active()`——硬切换（classList 切 `.hidden`、`.stab.active`），无 transition / animation / setTimeout。`onChange` 仅在用户点击时触发（init 的 initial 不触发）；`switchTo` 与点击走同一路径；非法 key 静默忽略；init 可重复调用（只重绑一次不叠加）。
- **UI**（`index.html` + `css/style.css`）：弹窗顶部加 `.settings-tabs` 横排页签，下方三个 pane——`#paneGeneral`（原 6 大非 LLM 字段集：人机对战/AI 观战/音效/TTS/聊天解说/好感度）、`#paneHuman`（人机 LLM）、`#paneSpectate`（红方+黑方 LLM 两组）。三组 LLM 前缀分别为 `setHuman*/setRed*/setBlack*`，每组独立 provider/baseUrl/model/apiKey/useFc + 测试连接按钮 + 结果展示。旧 7 个 id（`setProvider / setBaseUrl / setModel / setApiKey / setUseFc / btnTestApi / apiTestResult`）已彻底废弃。
- **接线**（`main.js`）：`openSettings` 三组独立填充、首次进入弹窗自动 `SettingsTabs.init({initial:'general'})` 回到"一般设置"页签；`saveSettingsFromModal` 三组独立写入并同步每组 FC 状态到 `FCTools.markFallback/resetFallback(profile)`；测试按钮 3 个（人机/红/黑）按 profile 调 `LLM.testConnection(profile)`，结果展示到各自独立 span。
- **CSS**：`.settings-tabs`、`.stab`、`.stab.active`、`.stab:focus-visible`、`.settings-pane` 复用 `--panel/--accent/--text/--muted` 主题变量，独立类名不与顶栏 `.tab` 耦合；`.settings-pane` 不写任何 transition，pane 切换完全靠全局 `.hidden` 类控制（`!important`，特意走 `classList`，避免 `style.display` 失效）。
- **顺手**：DOM 桩 `tests/smoke_dom.js` 增强 `querySelectorAll`（支持 `.class`）、`closest`（向上找祖先）、`addEventListener`/`removeEventListener`、`dispatch` 沿 parent 链冒泡——为页签测试铺路。
- 测试：smoke_dom 新增 22 项（页签切换/init 重入/非法 key/DOM 契约/三组配置独立/apiKey 不互污染/测试按钮按 profile 调用），共 **258 项**全部通过（engine 41 + affinity 59 + fc 37 + smoke 121）；单文件版（`ai-chinese-chess.html`）已重建。

## [V0.4.0] - 2026-09-03

### 🤖 重构：观战红黑 AI 双 LLM 独立配置与会话隔离
- **背景**：原先对弈双方共用同一条对话历史与同一套 LLM 配置，观战模式下每次走子都要换人设重注入 system prompt（前缀缓存命中率低），且同一历史里混着两方发言，模型容易搞混自己执红还是执黑。
- **配置层**：`settings.llm` 拆为 `human / red / black` 三组（各含 provider、baseUrl、model、apiKey、useFc）——人机=对手组，观战=红/黑 AI 各一组，可分别接不同服务商/模型；旧版平铺键（apiBaseUrl 等）启动时自动迁移到三组，运行时经 `AppSettings.set` 写入旧键亦会归一到 human 组，升级零感知。
- **客户端**：`LLMClient.request / requestFull / testConnection` 支持 `opts.profile`（human/red/black，缺省 human），按组取配置；新增 `getConfig(profile)`、`fcEnabled(profile)`。
- **会话层**：`Chat` 引入三会话槽 `sessions.{human,red,black}`，各槽独立对话历史；新增 `Chat.use(slot)` 切换活跃槽，`Chat.currentPersona() / currentPersonaColor()` 由槽直接派生说话人身份，彻底移除「按轮到谁反推执子」的兜底歧义；`Chat.history` 改为当前槽的读写访问器，旧调用方无感。
- **调用层**：`aiPick` 按模式+轮次自动选 profile（人机=human；观战=走子方红/黑组）；观战解说跟随走子方会话；FC 降级状态（`FCTools`）按组隔离——红方服务商不支持 FC 不再连累黑方与人机。
- **设置面板（阶段一兼容）**：现有 LLM 表单暂时映射到 human 组；三页签（一般设置/对弈LLM/观战LLM）UI 组件规格已定稿（docs/settings-tabs-spec.md），由山云实现、后续接线。
- 测试：test_fc 新增 14 项（profile 隔离/组配置读取）、smoke_dom 新增 16 项（旧键迁移、三槽历史隔离、槽派生身份、profile 携带与身份注入），共 **237 项**全部通过。

## [V0.3.1] - 2026-08-27

### 🐛 修复：MiMo 云端 TTS 配置后仍无声
- **根因**：MiMo 分支此前优先使用 `state.voiceName`（人设绑定的浏览器音色名，如 `yunyang`/`xiaoxiao`），而 MiMo 只认自己的预置音色 ID（`mimo_default`/冰糖/Mia…），收到非法音色即被接口拒绝；同时 `speakCloud` 把所有云端失败静默吞掉，导致"配置好了却没声音、且无任何提示"。
- **修复**：`tts.js` 的 `fetchMiMoAudio` 改为只取设置里的 MiMo 音色（`c.voice`），缺省兜底 `mimo_default`，彻底忽略人设绑定音色。
- **可观测性**：新增 `reportTtsError`——云端 TTS 失败时输出 `console.warn` 并触发 `global.onTtsError` 钩子；设置弹窗的「▶ 播放」试听会显示具体错误（如 `❌ TTS API 400`），不再无声无息。
- 测试：smoke_dom.js 新增 1 项回归断言（人设绑定浏览器音色时 MiMo 仍用设置音色），共 85 项全部通过。

## [V0.3] - 2026-08-27

### 🗣️ 新增：云端 TTS 支持小米 MiMo
- 服务商预设新增「小米 MiMo」（`https://api.xiaomimimo.com/v1`，模型 `mimo-v2.5-tts`，预置音色 `mimo_default`/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean）
- MiMo 官方走 **OpenAI 兼容 `/chat/completions`** 而非 `/audio/speech`：`tts.js` 新增适配分支——合成文本放 `assistant` 消息、音色传 `audio.voice`、响应解析 `choices[0].message.audio.data` 的 base64 并解码为 Blob 播放
- 鉴权兼容：先 `Authorization: Bearer`，收到 401/403 自动改用 `api-key` 请求头重试
- MiMo 无 `speed` 字段：人设棋风的语速/音调自动转成可选的 `user` 风格指令消息
- 判定方式：选中 MiMo 预设，或 Base URL 指向 `xiaomimimo.com` 域名（自定义反代可继续走 `/audio/speech` 格式）
- 测试：smoke_dom.js 新增 4 项 MiMo 断言（预设注册/端点/消息结构/鉴权头），共 84 项全部通过

## [V0.2] - 2026-08-23

### 💗 新增：好感度系统
- 每个对手有独立好感度（0~100，初始 50），按人设 id 持久化到 localStorage，跨对局保留
- **本地量化标准**：好感度分档（低<40 / 中40~69 / 高≥70）作为悔棋审批的兜底标准；LLM 在线时把档位写入裁决 prompt（参考不硬拒），离线/失败时按档位判定（低档驳回、中档按次数≤2、高档直接同意）
- **LLM 调分工具**：悔棋审批 JSON 扩展可选 `affinityDelta` 字段；所有流式回复支持隐藏行尾标记 `[♥+n]`/`[♥-n]`，渲染/朗读/历史自动剥离
- **本地自动调分**：辱骂 -8、礼貌 +2、明显好棋 +3、明显臭棋 -3、每次悔棋请求 -1
- **悔棋惩罚窗口（修复）**：悔棋请求后 4 步内该对手好感度只减不加（好棋/礼貌/LLM 加分全部抑制，减分照常），防止悔棋 -1 被紧接着的加分立即抵消；新开对局自动清零
- **「提示」联动**：好感度低于 35 时 AI 拒绝提示（在线生成拒绝台词，离线本地文案，拒绝不扣分）；成功使用按 `max(1, 5 - floor(好感/25))` 消耗
- **认输/复盘联动**：好感度分档叠加原有局面分档（3×3 组合）改变语气——低好感冷嘲热讽/敷衍复盘，高好感惋惜/认真教学
- **AI 走子联动**：难度 0（LLM 自由选择）档下，好感度≥80 可适当放水留情、<30 下狠手
- **UI**：顶栏对手名旁实时显示 ♥ 数值；好感度变化在聊天区出系统提示；设置弹窗新增「好感度」区块可查看/重置
- 观战模式不启用好感度（保持原有体验）

### 🧩 Function Calling 重构
- **AI 走子**：由 prompt 约束 JSON 改为 `play_move` 工具调用；非法走法把校验错误作为工具结果回传 LLM 重试（最多 3 轮），仍失败回退引擎 top1
- **悔棋裁决**：由 JSON 字段改为 `answer_undo` 工具（allow/reply/affinity_delta 一次调用完成）
- **好感度调分**：聊天改为两阶段——先非流式预判请求调用 `adjust_affinity` 执行调分，再流式正文打字机；彻底移除流式 `[♥±n]` 隐藏标记的主路径依赖（保留为降级兜底）
- **llm.js 重构**：提取公共请求层，新增 `LLMClient.requestFull`（非流式结构化响应，解析 `tool_calls` 与容错参数）
- **降级策略**：服务商不支持 tools（400）时自动回退 JSON/[♥±n] 机制并提示一次（会话内记忆）；设置弹窗新增「函数调用」开关（默认开，custom 服务商可手动关闭）
- 修复 aiPick prompt 中炮二平五坐标示例错误（h9e9 → h7e7）

### 😤 修复：LLM 对辱骂/挑衅更敏感（被骂必掉好感度）
- 辱骂词表从 26 词扩充至 70+（新增 大傻子/蠢蛋/变态/人渣/废柴/傻叉/二百五/闭嘴/弄死/虐死/略死 等），并分级：重度辱骂 -8、轻度挑衅（菜鸟/臭棋/傻瓜等）-3
- FC 模式下辱骂检测改为硬性底线：即使默认开启函数调用，命中辱骂词也必定先扣分（礼貌加分仍交给 LLM 预判，避免双重加分）
- 聊天两阶段预判指令增强：明确「辱骂/人身攻击必须调用 adjust_affinity 且 delta 为负」，附示例，maxTokens 12→24
- 「杂鱼」保留为「小魅」人设口头禅，不计入辱骂

### 🧪 测试
- 共 **203 项**自动化测试（引擎 41 + 好感度 59 + FC 23 + 冒烟 80），CI 自动校验单文件版构建产物一致性

## [V0.1] - 2026-08-18

首个正式发布版本：**LLM 象棋 V0.1**（AI 对话象棋）。

### 🎮 核心玩法
- 人机对战：玩家执红/黑自选，AI 由大模型（LLM）按人设驱动走子
- AI 观战：两个不同人设的 AI 互相对弈，实时解说
- 本地象棋规则引擎 + 搜索引擎（negamax α-β + 迭代加深 + 静态搜索），**无 API Key 自动降级本地引擎**，离线可玩
- 中文记谱（进/退/平、前/中/后）、棋谱导出（记谱 + FEN 序列）、禁止长将（同一局面重复 3 次）

### 💬 对话与个性
- 7 套内置人设：嚣张街头棋王 / 温文尔雅老先生 / 毒舌解说员 / 沉默寡言的剑客 / 可爱的学棋妹妹 / 小魅 / 暴躁老哥
- 可视化人设编辑器：语气、棋风、音色、嘲讽度、话痨度、附加指令
- 聊天面板：自由闲聊、局面分析、走子提示（棋盘高亮）、嘲讽、复盘，全部流式打字机输出
- 自动反应：明显好棋/坏棋时 AI 按人设称赞或嘲讽
- 悔棋审批：LLM 在线时 AI 裁决（态度差可被驳回），离线直接悔棋

### 🗣️ 语音（TTS）
- 浏览器离线语音：只列中文音色、全局默认音色可选、**人设可绑定专属音色**（内置人设已预置晓晓/云希/晓伊等）
- 云端 TTS：内置 **OpenAI / 火山方舟（豆包）/ 阿里云百炼** 服务商预设，音色候选自动匹配
- 棋风映射音调/语速、流式分句朗读、点击气泡重听、设置内试听

### 🔌 接入
- 多模型：OpenAI / DeepSeek / 智谱 GLM / 通义千问 / Moonshot Kimi / 自定义
- API Key 仅存浏览器 localStorage，纯前端直连

### 🛡️ 工程与安全
- 纯前端零依赖，双击即玩；单文件版 + GitHub Pages 在线试玩
- 93 项自动化测试（41 引擎 + 52 主流程/TTS），CI 自动校验构建产物一致性
- 安全加固：XSS 全链路 textContent、路径穿越/空字节防护、CSP、隐藏目录屏蔽
- 首次启动玩法说明弹窗 + 设置/人设保存重开确认框
- **MIT 开源协议**，详见 LICENSE
