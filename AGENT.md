# AGENT.md

> This file is the primary guide for AI coding agents working in this repository.
> Read it before modifying code. User-facing documentation is in `README.md` (Chinese).

## Repository

- **GitHub**: https://github.com/zoushuling/ai-chinese-chess
- **Clone**: `git clone https://github.com/zoushuling/ai-chinese-chess.git`
- **Download ZIP**: https://github.com/zoushuling/ai-chinese-chess/archive/refs/heads/main.zip
- **Default branch**: `main`
- **Raw AGENT.md**: https://raw.githubusercontent.com/zoushuling/ai-chinese-chess/main/AGENT.md

## What this project is

**AI 对话象棋 (AI Chinese Chess / Xiangqi)** — a pure front-end, no-build web game:

- Local Xiangqi rule engine + local search engine generate candidate moves.
- An LLM (OpenAI-compatible API) picks moves according to a configurable persona.
- The player can chat with the AI: analysis, hints, taunts, commentary, review.
- Works without any API key: falls back to the local engine.
- Supports human-vs-AI and AI-vs-AI spectate mode.
- Added recently: **TTS voice playback** for AI messages (browser `speechSynthesis` or cloud OpenAI-compatible `/audio/speech`).

## Tech constraints (important)

- **No runtime build system, no bundler, no npm dependencies** for the app itself.
  `scripts/build-single-file.js` is only an optional zero-dependency generator for the single-file distribution.
- The app is plain HTML + CSS + JavaScript loaded via `<script>` tags in `index.html`.
- All JS modules attach themselves to `globalThis`/`window` (e.g. `ChessEngine`, `AISearch`, `Game`, `Chat`, `TTS`). Do not introduce ES module `import`/`export` unless the whole architecture is migrated deliberately.
- `scripts/serve.js` is a zero-dependency Node static server; it is the only server-side file.
- The project intentionally uses only Node.js built-ins for tests. Do not add a package.json for the app.
- API keys are stored only in browser `localStorage`; there is no backend proxy.

## Project structure

```
.
├── index.html              Page skeleton: board, chat, modals, script load order
├── ai-chinese-chess.html   Generated single-file build (do NOT hand-edit; run node scripts/build-single-file.js)
├── 启动游戏.bat             Windows one-click launcher (node scripts/serve.js + browser)
├── README.md               User-facing Chinese documentation
├── CHANGELOG.md            Release changelog
├── LICENSE                 MIT license
├── AGENT.md                This agent guide
├── css/
│   └── style.css           All styles
├── js/
│   ├── engine.js           Xiangqi rules: moves, checkmate, notation, evaluation (dual-speed), Zobrist hashing
│   ├── logger.js           Runtime log: ring buffer 1000 + localStorage persist 300, sanitization, export
│   ├── book.js             Opening book: hand-crafted lines expanded via engine into FEN→move map
│   ├── ai.js               Local search: negamax α-β + TT + PVS + killer/history + null-move + LMR + check extension
│   ├── personas.js         Persona presets + custom personas (localStorage)
│   ├── affinity.js         Affinity system: values/tiers, hint cost, local deltas, [♥±n] markers (localStorage)
│   ├── llm.js              OpenAI-compatible client: SSE streaming, JSON extraction, Function Calling (requestFull); two independent deep-thinking modes — CoT guide (buildCoTGuide, prompt scaffolding) and reasoning-model param dispatch (inferReasoning)
│   ├── fc.js               FC tool schemas (play_move/answer_undo/adjust_affinity) + fallback state
│   ├── game.js             Game state machine: moves, undo, game over, export
│   ├── sound.js            Move/capture sound effects (Web Audio, no assets)
│   ├── tts.js              TTS: browser speechSynthesis + cloud OpenAI-compatible audio
│   ├── chat.js             Chat panel: streaming render, quick actions, commentary
│   └── main.js             Main program: rendering, interaction, modes, settings
├── scripts/
│   ├── serve.js            Zero-dependency static server (node scripts/serve.js, port 8800)
│   ├── build-single-file.js  Regenerates ai-chinese-chess.html from index.html + css/ + js/
│   └── probe_*.js          Read-only probes (tuning only, never run by the app):
│                             swing distribution, prompt reproduction, verdict verification
├── docs/
│   ├── assets/game-preview.png  README preview screenshot
│   ├── engine-upgrade-feasibility.md  Engine upgrade feasibility analysis (Chinese)
│   └── llm-reasoning-support.md       Reasoning-model integration design — covers mode 2 of deep thinking only
├── .gitattributes          Line-ending rules; pins ai-chinese-chess.html to LF
└── .gitignore              Local caches, outputs/, secrets, editor scratch — never commit
├── .github/workflows/
│   ├── ci.yml              Tests + single-file build check (push / PR)
│   └── pages.yml           Auto-enable + deploy to GitHub Pages on push to main
├── tests/
│   ├── test_engine.js      Rule engine + opening book unit tests (node tests/test_engine.js)
│   ├── test_affinity.js    Affinity system tests (node tests/test_affinity.js)
│   ├── test_fc.js          Function Calling tests (node tests/test_fc.js)
│   ├── test_llm_reasoning.js  Reasoning-model param dispatch tests (node tests/test_llm_reasoning.js)
│   ├── test_cot_guide.js   CoT-guide scaffolding tests (node tests/test_cot_guide.js)
│   ├── test_logger.js      Runtime-log module tests (node tests/test_logger.js)
│   ├── test_react_judge.js Good/blunder move verdict tests (node tests/test_react_judge.js)
│   ├── smoke_dom.js        DOM-stub smoke tests (node tests/smoke_dom.js)
│   ├── bench_engine.js     Engine benchmark: perf/tactics/self-play (manual, not in CI)
│   ├── ablation_eval.js    Per-component evaluation ablation via self-play (manual)
│   ├── eval_match.js       Paired-position strength test, continuous signal (manual)
│   ├── fixtures/           legacy-engine.js / legacy-ai.js baselines (from git HEAD)
│   └── cdp_check.js        CDP browser debugging helper
```

## Run

```bash
node scripts/serve.js
# or double-click 启动游戏.bat
# then open http://localhost:8800
```

`index.html` can be opened directly, but some browsers block `file://` requests to
local files (especially paths containing Chinese characters); the local server avoids this.

## Test

```bash
node tests/test_engine.js    # rule engine tests
node tests/test_affinity.js  # affinity system tests (values/tiers/hint cost/markers)
node tests/test_fc.js        # Function Calling tests (requestFull/tool_calls/fallback state)
node tests/test_logger.js    # runtime log module tests (ring buffer/persist/redact/export)
node tests/test_react_judge.js  # good/blunder verdict tests (moveLoss/classifyLoss)
node tests/test_llm_reasoning.js  # reasoning-model param dispatch (inferReasoning)
node tests/test_cot_guide.js # CoT-guide scaffolding (buildCoTGuide / two-mode independence)
node tests/smoke_dom.js      # DOM smoke tests (simulates main flow)
```

All eight suites must exit 0 before pushing. Current totals (**396 passing**):

| Suite | Items | Suite | Items |
| --- | --- | --- | --- |
| `test_engine.js` | 47 | `test_cot_guide.js` | 39 |
| `test_affinity.js` | 59 | `test_logger.js` | 19 |
| `test_fc.js` | 37 | `test_react_judge.js` | 23 |
| `test_llm_reasoning.js` | 30 | `smoke_dom.js` | 142 |

When you add or change assertions, update the count here, in `README.md` (badge + test list), and in `CHANGELOG.md`.

## Single-file build

`ai-chinese-chess.html` is generated by:

```bash
node scripts/build-single-file.js
```

It inlines `css/style.css` and all `<script src="js/*.js">` files from `index.html`,
then adds a single-file-only "📖 说明" help modal/button.

- **Do not hand-edit `ai-chinese-chess.html`** — it is a generated artifact.
- After changing `index.html`, `css/`, or `js/`, regenerate it and commit the updated file.
- The multi-file `index.html` remains the source of truth.

## Release & versioning

- **Single source of truth**: the topmost `## [V0.x.y] - YYYY-MM-DD` heading in `CHANGELOG.md`.
  Everything else (git tag, README badge, test counts) must match it.
- **Tag format**: `v0.x.y` (lowercase `v`) ↔ CHANGELOG `V0.x.y`.
- **Before tagging, all of these must hold**:
  1. All 8 test suites exit 0.
  2. `node scripts/build-single-file.js` has been run and
     `git diff --exit-code -- ai-chinese-chess.html` passes (CI enforces this).
  3. `CHANGELOG.md` got a new entry, the `README.md` badge + test list counts are current,
     and the table in the Test section above is current.
- **Do not resurrect `v1.0.0`**: it was tagged on 2026-08-18 against an early commit and
  contradicts the current V0.5.x series. It has been deleted on purpose.
- **Never commit**: `outputs/`, `.workbuddy/`, `.npm-cache/`, `.pnpm-store/`, `.tools/`,
  `node_modules/`, `*.log`, or anything matching the secrets block in `.gitignore`.
  The project has no backend, so there should never be a key file — if one appears, it is a bug.

## Common agent tasks

- **Add a UI feature**: edit `index.html` for markup, `css/style.css` for style,
  the relevant `js/*.js` module for logic, and add smoke coverage in `tests/smoke_dom.js`
  when feasible. Then regenerate the single-file build (`node scripts/build-single-file.js`).
- **Add a JS module**: create `js/xxx.js` as an IIFE attaching to `globalThis`,
  add the `<script>` tag in `index.html` **before** modules that depend on it,
  and `require('../js/xxx.js')` in `tests/smoke_dom.js` if it must be present during smoke tests.
  Then regenerate the single-file build (`node scripts/build-single-file.js`).
- **Change game rules**: work in `js/engine.js` and `js/game.js`; keep the public
  globals and event callbacks stable (`Game.onEvent('state'|'move')`).
- **Change LLM behavior**: work in `js/llm.js`, `js/chat.js`, `js/main.js`, and persona prompts.
- **Change affinity/好感度 behavior**: work in `js/affinity.js` (values, tiers, hint cost, local deltas, [♥±n] markers),
  `js/chat.js` (undo verdict tiers, hint gating/cost, review tiers, streaming marker stripping),
  and `js/main.js` (topbar badge, settings modal list/reset, difficulty-0 move prompts).
- **Change Function Calling behavior**: tool schemas live in `js/fc.js`; `LLMClient.requestFull` (in `js/llm.js`)
  sends non-streaming requests with `tools` and parses `tool_calls` into `{content, toolCalls, raw}`.
  Move picking (`play_move`, main.js), undo verdict (`answer_undo`, chat.js), chat affinity preflight
  (`adjust_affinity`, chat.js twoPhaseChat). Fallback to JSON/[♥±n] when a provider rejects tools (400):
  `FCTools.fallback.active` marks the session; settings `useFunctionCalling` toggles it.
  Note: streaming chat still strips [♥±n] markers as a fallback path; keep `createDeltaTracker` working.
- **Run the browser**: `node tests/cdp_check.js <url>` is a debugging helper only.

## Conventions

- Keep the app dependency-free and runnable by double-clicking `index.html`.
- Chinese UI text is the norm; comments/code identifiers are mixed Chinese/English.
- Coordinates: `row 0–9` (top→bottom), `col 0–8` (left→right); red is at bottom, black at top.
- Do not commit local caches: `.npm-cache/`, `.pnpm-store/`, `.tools/`, `node_modules/`.
- Do not hand-edit `ai-chinese-chess.html`; always regenerate via `node scripts/build-single-file.js`.
- Update `README.md` and this file when project structure or commands change.
