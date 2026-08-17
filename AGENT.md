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

- **No build system, no bundler, no npm dependencies** for the app itself.
- The app is plain HTML + CSS + JavaScript loaded via `<script>` tags in `index.html`.
- All JS modules attach themselves to `globalThis`/`window` (e.g. `ChessEngine`, `AISearch`, `Game`, `Chat`, `TTS`). Do not introduce ES module `import`/`export` unless the whole architecture is migrated deliberately.
- `serve.js` is a zero-dependency Node static server; it is the only server-side file.
- The project intentionally uses only Node.js built-ins for tests. Do not add a package.json for the app.
- API keys are stored only in browser `localStorage`; there is no backend proxy.

## Project structure

```
.
├── index.html              Page skeleton: board, chat, modals, script load order
├── 启动游戏.bat             Windows one-click launcher (node serve.js + browser)
├── serve.js                Zero-dependency static server (node serve.js, port 8800)
├── README.md               User-facing Chinese documentation
├── AGENT.md                This agent guide
├── css/
│   └── style.css           All styles
├── js/
│   ├── engine.js           Xiangqi rules: moves, checkmate, notation, evaluation
│   ├── ai.js               Local search: negamax alpha-beta, iterative deepening
│   ├── personas.js         Persona presets + custom personas (localStorage)
│   ├── llm.js              OpenAI-compatible client: SSE streaming, JSON extraction
│   ├── game.js             Game state machine: moves, undo, game over, export
│   ├── sound.js            Move/capture sound effects (Web Audio, no assets)
│   ├── tts.js              TTS: browser speechSynthesis + cloud OpenAI-compatible audio
│   ├── chat.js             Chat panel: streaming render, quick actions, commentary
│   └── main.js             Main program: rendering, interaction, modes, settings
├── tests/
│   ├── test_engine.js      Rule engine unit tests (node tests/test_engine.js)
│   ├── smoke_dom.js        DOM-stub smoke tests (node tests/smoke_dom.js)
│   └── cdp_check.js        CDP browser debugging helper
└── ai-chinese-chess.html   Older single-file build (may be stale; source of truth is index.html + js/)
```

## Run

```bash
node serve.js
# or double-click 启动游戏.bat
# then open http://localhost:8800
```

`index.html` can be opened directly, but some browsers block `file://` requests to
local files (especially paths containing Chinese characters); the local server avoids this.

## Test

```bash
node tests/test_engine.js   # rule engine tests
node tests/smoke_dom.js     # DOM smoke tests (simulates main flow)
```

Both should exit 0 before pushing changes.

## Common agent tasks

- **Add a UI feature**: edit `index.html` for markup, `css/style.css` for style,
  the relevant `js/*.js` module for logic, and add smoke coverage in `tests/smoke_dom.js`
  when feasible.
- **Add a JS module**: create `js/xxx.js` as an IIFE attaching to `globalThis`,
  add the `<script>` tag in `index.html` **before** modules that depend on it,
  and `require('../js/xxx.js')` in `tests/smoke_dom.js` if it must be present during smoke tests.
- **Change game rules**: work in `js/engine.js` and `js/game.js`; keep the public
  globals and event callbacks stable (`Game.onEvent('state'|'move')`).
- **Change LLM behavior**: work in `js/llm.js`, `js/chat.js`, `js/main.js`, and persona prompts.
- **Run the browser**: `node tests/cdp_check.js <url>` is a debugging helper only.

## Conventions

- Keep the app dependency-free and runnable by double-clicking `index.html`.
- Chinese UI text is the norm; comments/code identifiers are mixed Chinese/English.
- Coordinates: `row 0–9` (top→bottom), `col 0–8` (left→right); red is at bottom, black at top.
- Do not commit local caches: `.npm-cache/`, `.pnpm-store/`, `.tools/`, `node_modules/`.
- Update `README.md` and this file when project structure or commands change.
