# 象棋引擎升级可行性分析

调研日期：2026-09-05
调研目标：为「AI 对话象棋」寻找比当前架构更强的开源引擎方案

---

## 一、先明确一件事：引擎在本项目里的真实角色

很多人看到"引擎棋力差"就想换最强引擎，但本项目有个特殊定位必须先厘清：

| 传统象棋软件 | 本项目 |
|---|---|
| 引擎直接跟人下棋 | 引擎**给 LLM 出候选走法**，由 LLM 按人设挑选 |
| 棋力 = 体验 | 棋力 = **候选走法的质量上限** |
| 越强越好 | 够用就好，但要"懂棋理" |

当前 `aiPick` 的流程是：引擎出 topN 候选 → LLM 从里面挑一步 → 输出心理活动。

**这意味着引擎的真实价值不是"赢"，而是"别推荐蠢棋"。** 当前引擎之所以让人觉得"棋力差"，根因不是赢不了，而是：

1. 候选列表里混着明显送子的走法（LLM 有时会挑中，就变成"AI 下臭棋"）
2. 不懂防守（士象无位置分），被将军时反应很差
3. 开局乱走（无开局库），前几手就很离谱

所以升级目标应该是：**提升候选走法的"棋理正确率"，而不是单纯堆搜索深度。**

---

## 二、当前引擎诊断

### 2.1 架构现状

| 层 | 文件 | 实现 |
|---|---|---|
| 规则引擎 | `js/engine.js` (16.5KB) | 走法生成、将军检测、FEN、中文记谱、局面评估 |
| 搜索引擎 | `js/ai.js` (5.3KB) | negamax + alpha-beta + 迭代加深 + MVV-LVA 排序 + 静态搜索 |

`ai.js` 的搜索主循环（`search`）：迭代加深 1→maxDepth，每层按上一层分数排序走法，`negamax` 带 alpha-beta 剪枝，叶节点走 `quiesce` 静态搜索（只看吃子）。

### 2.2 评估函数短板（engine.js:333-358）

```
评估 = Σ(子力价值 + 位置分)
子力价值：K:100000 A:200 B:200 N:400 C:450 R:900 P:100
位置分表：M_TABLE(马) / C_TABLE(炮) / P_TABLE(兵) / K_TABLE_RED(将)
车(R)：只有简单底线判断（r>=7 加12，r=0/9 减6）
```

**致命缺口（按影响排序）：**

| # | 缺失项 | 后果 |
|---|---|---|
| 1 | **士(A)、象(B) 完全没有位置分** | 引擎不懂防守阵型，会主动走散士象、该补士时不补 |
| 2 | **无机动性（Mobility）评估** | 不会判断"这匹马被憋死了"、"这个车被堵住了" |
| 3 | **无将帅安全评估** | 被攻击时不知道危险，不会提前防守 |
| 4 | **无子力配合/威胁评估** | 看不出"车马炮组合杀"、"双重威胁" |
| 5 | 车的通路、马的蹩腿、炮架未建模 | 位置分是静态的，不随局面变化 |
| 6 | 车的位置分过于简陋（仅底线判断） | 车是象棋最强子力，却只有 2 条规则 |

### 2.3 搜索算法短板（ai.js）

| 缺失技术 | 作用 | 缺失后果 |
|---|---|---|
| **置换表（TT + Zobrist）** | 缓存已搜索局面 | 同一局面反复计算，节点数浪费 3-10 倍 |
| **杀手启发（Killer）** | 记住同层引发剪枝的走法 | 走法排序差，剪枝效率低 |
| **历史启发（History）** | 统计全局优质走法 | 同上 |
| **PVS（主要变例搜索）** | 用零窗口快速验证 | 搜索树冗余 |
| **空步剪枝（Null Move）** | 让对手连走两步测试威胁 | 深度上不去 |
| **LMR（晚走削减）** | 对排序靠后的走法减少深度 | 深度上不去 |
| **开局库** | 前若干手直接查表 | 开局乱走，前几手就很离谱 |
| **将军延伸（Check Extension）** | 被将军时加深搜索 | 看不透杀棋 |

### 2.4 性能天花板

- JS 单线程，无 Web Worker（搜索会卡 UI）
- 实际深度 1-4 层（难度档），上限 6 层
- 象棋平均分支因子约 40，无置换表时 6 层已是 JS 极限

**棋力估计：业余初级**（能看出一步吃子，不懂战术组合、不懂防守、开局乱走）

---

## 三、GitHub 候选方案调研

### 方案 A：纯 JS 算法升级（不引入外部依赖）

不换引擎，在现有 `ai.js` + `engine.js` 上补上第二节列的所有缺失项。

- **代表参考**：`maksimKorzh/wukong-xiangqi`（纯 JS 教学引擎，有置换表 + Zobrist + PST，2021 年停更，但架构可借鉴）
- **棋力预期**：补完 TT + 启发式后深度可到 6-8 层，评估改进后棋理明显正确 → **业余中级**
- **体积**：+10~20KB（纯 JS）
- **License**：不变（仍是 MIT）
- **集成成本**：低（2-3 天，全是自己代码）
- **单文件兼容**：✅ 完全兼容

### 方案 B：Fairy-Stockfish WASM（现成 npm 包）

- **仓库**：`fairy-stockfish/fairy-stockfish.wasm` → npm 包 `fairy-stockfish-nnue.wasm`
- **棋力**：Stockfish 血统，支持 xiangqi 变体，有专用 xiangqi NNUE 网络（`ianfab/Fairy-Stockfish-NNUE`）
- **生产验证**：pychess.org 用它做客户端分析
- **体积**：WASM + NNUE，预计 10~30MB（需实测）
- **License**：**GPL-3.0**（传染性，见第四节）
- **集成成本**：中（npm 引入 + Web Worker + UCI 协议对接）
- **单文件兼容**：❌ 破坏单文件（WASM 无法内联进 220KB HTML）

### 方案 C：Pikafish WASM（AlexiaChen/chinese-chess 方案）

- **仓库**：`AlexiaChen/chinese-chess`
- **架构**：C++20 + 内嵌 Pikafish 源码（非 submodule）+ Emscripten → WASM
  - `src/engine/pikafish_search.cpp`：单线程 Pikafish 搜索适配（WASM 下把 job flow 改成同步，不依赖 std::thread）
  - `src/engine/pikafish_nnue.cpp`：NNUE 评估适配
  - `src/engine/opening_book.cpp`：离线开局库
- **棋力**：Pikafish 是当前**最强开源象棋引擎**。高难档 3500ms / 12 层；特级大师档 15000ms / 20 层
- **体积**：NNUE 权重 **51MB**（Chinese-Chess-AI-Pro 实测数据）
- **License**：**GPL-3.0** + NNUE 权重额外限制（禁商用，见第四节）
- **集成成本**：**高**（需 Emscripten 5.0.6 + CMake ≥3.20 + C++20 编译器，构建链重）
- **单文件兼容**：❌ 彻底不可能（51MB）

### 方案 D：Chinese-Chess-AI-Pro（多线程 Pikafish）

- **仓库**：`billzi2016/Chinese-Chess-AI-Pro`
- **架构**：C++17 → WASM + pthread + SharedArrayBuffer 多线程（占 ~90% 逻辑核）+ 256MB 置换表 + SIMD128
- **棋力**：超人级，深度可达 32 层（M2 Ultra 24 核实测）
- **体积**：51MB NNUE
- **License**：GPLv3
- **集成成本**：**很高**
- **致命问题**：SharedArrayBuffer 需要 **COOP/COEP 跨域隔离 HTTP 头**
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
  - 项目里专门写了 `coi-serviceworker.js` 和 `server.py` 来解决
  - **后果：不能再双击 HTML 直接玩（file:// 协议下 SharedArrayBuffer 不可用）**

---

## 四、关键约束分析（决定方案可行性）

### 4.1 License 冲突（最重要）

本项目是 **MIT License**（LICENSE: zoushuling 2026）。所有强引擎（B/C/D）都是 **GPLv3**。

**GPLv3 是强传染性协议**，但有一个业界通行的重要例外：

> **通过进程间通信（IPC）调用的独立程序，不构成衍生作品。**
> 象棋软件社区的通行做法：GUI 用 MIT/闭源，引擎用 GPLv3，双方只通过 **UCI 协议**（文本协议）通信。ChessX、Arena、SCID 等都是这么做的，被广泛接受。

**应用到本项目：**

| 集成方式 | 是否触发传染 | 结论 |
|---|---|---|
| 静态链接进主 bundle / 内联进单文件 | ⚠️ 是 | 整个项目必须 GPLv3 |
| **Web Worker 里独立加载 WASM，通过 UCI 文本协议通信** | ✅ 通常不算 | **主项目可保持 MIT** |

**落地要求（若选 B/C）：**
1. WASM + NNUE 作为**独立文件**分发，不内联、不打包进主 bundle
2. 引擎目录保留完整的 GPLv3 声明 + 源码获取方式（或指向上游仓库）
3. 主项目 README 说明"引擎部分为 GPLv3，通过 UCI 协议独立调用"
4. 主项目 LICENSE 保持 MIT，引擎单独放 LICENSE

### 4.2 NNUE 权重的额外限制（Pikafish）

Pikafish 的 `NNUE-License` 比 GPLv3 更严：

```
1. Only for legal use（禁止用于线上作弊等）
2. No commercial use without permission（未经书面许可不得商用）
   并附有一份"禁止使用名单"（鹏飞象棋、国圣象棋等）
```

**注意：这是权重文件的独立许可，不是 GPLv3 的一部分。** 个人项目/开源项目没问题；要商业化必须单独申请授权。

Fairy-Stockfish 的 xiangqi NNUE 需另行确认其许可条款。

### 4.3 单文件版存亡

本项目有 `ai-chinese-chess.html`（220KB 单文件版），这是"零依赖、双击即玩"体验的基石。

| 方案 | 单文件版 |
|---|---|
| A 纯 JS | ✅ 保留（可能涨到 240KB） |
| B Fairy-Stockfish | ❌ 需改为"HTML + 外链 wasm" |
| C/D Pikafish | ❌ 51MB，单文件彻底不可能 |

**折中做法**：保留两个发行版——
- `ai-chinese-chess.html`（轻量版，内置 JS 引擎，双击即玩）
- `index.html` + `engine/` 目录（完整版，WASM 强引擎，需本地服务器或部署）

### 4.4 "引擎只是给 LLM 出候选"带来的额外考量

如果接入超强引擎（Pikafish 12 层），会出现一个新问题：

**引擎太强 → 候选走法全是"最优解" → LLM 的选择变得没有意义 → 人设差异消失**

当前设计里 `difficulty=0`（LLM 自由选择档）是特意留的口子：候选给 100 条，让 LLM 按心情挑强弱。如果引擎太强太准，候选列表会收敛到少数几个"正确答案"，LLM 的自由度和人设表现反而被压缩。

**所以：引擎升级要"适度"，不是越强越好。** 建议保留难度分档，让强引擎也能"降档"输出带梯度的候选（比如取 topN 时故意包含一些次优但合理的走法）。

---

## 五、方案对比矩阵

| 维度 | A 纯 JS 强化 | B Fairy-Stockfish | C Pikafish WASM | D 多线程 Pikafish |
|---|---|---|---|---|
| 棋力 | 业余中级 | 专业级 | **大师级** | **超人级** |
| 搜索深度 | 6-8 层 | 10-15 层 | 12-20 层 | 20-32 层 |
| 体积增量 | +10~20KB | 10~30MB | **51MB** | **51MB** |
| License | MIT（不变） | GPLv3 | GPLv3 + NNUE 限制 | GPLv3 + NNUE 限制 |
| 主项目能否保 MIT | ✅ | ✅（UCI 隔离） | ✅（UCI 隔离） | ✅（UCI 隔离） |
| 单文件版 | ✅ 保留 | ❌ | ❌ | ❌ |
| 需 COOP/COEP | 否 | 否 | 否 | **是**（破坏双击即玩） |
| 构建链 | 无 | npm 引入 | Emscripten + CMake | Emscripten + pthread |
| 集成成本 | 低（2-3 天） | 中（1 周） | 高（2-3 周） | 很高（1 月+） |
| 懂防守/棋理 | ✅（靠评估改进） | ✅ | ✅ | ✅ |
| 开局库 | 需自己加 | 需确认 | ✅ 内置 | ✅ 内置 |
| Web Worker | 建议加 | 必须 | 必须 | 必须 |

---

## 六、推荐路径

### 推荐：先 A，再按需 B

**第一阶段（立即做）：方案 A 纯 JS 强化**

理由：
1. 项目的核心卖点是 **LLM 对话**，不是引擎棋力，"够用且懂棋理"比"超强"更重要
2. 保持 MIT + 单文件 + 零依赖，这是项目的立身之本
3. 成本最低，风险最小，全是自己代码
4. 补完 TT + 启发式后，棋理正确率会有**肉眼可见的跃升**（从"乱送子"到"像个会下棋的人"）

具体改造清单（按性价比排序）：

| 优先级 | 改造项 | 预期收益 |
|---|---|---|
| ★★★ | **置换表（Zobrist + TT）** | 节点数减少 3-10 倍，深度 +2 层 |
| ★★★ | **评估函数补士象位置分 + 机动性 + 将帅安全** | 从"不懂防守"到"会补士象"，棋理质变 |
| ★★★ | **开局库**（可用 wukong 的 opening_book.txt 或自建小库） | 前 8-10 手不再乱走 |
| ★★ | 杀手启发 + 历史启发 | 剪枝效率 +30% |
| ★★ | PVS + 空步剪枝 | 深度 +1~2 层 |
| ★★ | **Web Worker 化** | 搜索不卡 UI，可以给更长思考时间 |
| ★ | LMR + 将军延伸 | 深度 +1 层 |
| ★ | 难度档位重新标定 | 配合新引擎调整 1-4 档的实际强度 |

**第二阶段（可选）：方案 B Fairy-Stockfish WASM**

触发条件：如果第一阶段做完后，你觉得"还是不够强，想要专业级棋力"，再考虑。

前置工作（做之前必须验证）：
1. 实测 `fairy-stockfish-nnue.wasm` 的体积和 xiangqi NNUE 加载方式
2. 确认 xiangqi NNUE 的许可条款（是否禁商用）
3. 验证 UCI 协议隔离是否满足 GPLv3 的"独立程序"要求（建议咨询或参照 pychess.org 的做法）
4. 设计双发行版方案（轻量单文件版 + 完整 WASM 版）

**不建议**：方案 C/D（51MB NNUE 对本项目是过度投资，且 D 会破坏双击即玩）

---

## 七、风险与注意事项

1. **别为了棋力毁掉项目定位**：51MB 引擎 + 必须起服务器，会让"轻量零依赖"的立身之本消失
2. **引擎太强会削弱 LLM 人设**：见 4.4，升级后要重新标定难度档，保留"次优但合理"的候选
3. **GPLv3 隔离要做得干净**：WASM 独立文件 + UCI 协议通信 + 单独 LICENSE，别嫌麻烦
4. **NNUE 商用限制**：Pikafish 权重明确禁商用，Fairy-Stockfish 需另行确认
5. **Web Worker 化是刚需**：不管选哪个方案，只要搜索时间超过 500ms 就该上 Worker，否则 UI 卡顿会毁掉体验
6. **wukong-xiangqi 已停更（2021）**：只适合借鉴架构和开局库数据，不适合直接用（棋力不会比改造后的 A 强多少）

---

## 八、参考链接

| 项目 | 地址 | 用途 |
|---|---|---|
| AlexiaChen/chinese-chess | https://github.com/AlexiaChen/chinese-chess | Pikafish WASM 集成参考（架构最完整） |
| billzi2016/Chinese-Chess-AI-Pro | https://github.com/billzi2016/Chinese-Chess-AI-Pro | 多线程 Pikafish 参考（性能测试数据） |
| fairy-stockfish.wasm | https://github.com/fairy-stockfish/fairy-stockfish.wasm | 现成 npm 包，支持 xiangqi |
| official-pikafish/Pikafish | https://github.com/official-pikafish/Pikafish | 最强开源象棋引擎（C++） |
| maksimKorzh/wukong-xiangqi | https://github.com/maksimKorzh/wukong-xiangqi | 纯 JS 引擎参考 + 开局库数据（含 43878 局大师棋谱） |
| Fairy-Stockfish-NNUE | https://github.com/ianfab/Fairy-Stockfish-NNUE | xiangqi 专用 NNUE 网络发布页 |
