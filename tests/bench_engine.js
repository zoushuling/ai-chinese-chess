/* ============================================================
 * bench_engine.js — 引擎棋力基准（不进 CI 主流程，手动运行）
 *
 *   node tests/bench_engine.js                # 默认 6 局 + 战术题 + 性能
 *   node tests/bench_engine.js --games 10     # 指定自对弈局数
 *   node tests/bench_engine.js --time 300     # 每步思考毫秒
 *   node tests/bench_engine.js --perf         # 只跑性能基准
 *   node tests/bench_engine.js --tactics      # 只跑一步杀题库
 *
 * 三组指标：
 *   1. 性能：固定局面固定深度下的节点数 / 耗时（越小越强，反映搜索效率）
 *   2. 战术：自动生成的一步杀题库命中率（ground truth 由规则保证，100% 可靠）
 *   3. 战绩：新引擎 vs 旧引擎自对弈（终极指标）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 在独立沙箱里加载一对 engine.js + ai.js，避免新旧版本互相覆盖 global */
function loadPair(enginePath, aiPath, withBook) {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  sandbox.Date = Date;
  sandbox.Math = Math;
  const code = fs.readFileSync(enginePath, 'utf8') + '\n'
    + (withBook ? fs.readFileSync(path.join(ROOT, 'js/book.js'), 'utf8') + '\n' : '')
    + fs.readFileSync(aiPath, 'utf8');
  // eslint-disable-next-line no-new-func
  (new Function('window', 'globalThis', 'global', code))(sandbox, sandbox, sandbox);
  if (!sandbox.ChessEngine || !sandbox.ChessAI) throw new Error('加载失败：' + enginePath);
  return { Eng: sandbox.ChessEngine, AI: sandbox.ChessAI };
}

/**
 * 统计叶子评估次数（≈ 实际搜索节点量，三个版本可直接对比）。
 * 统一钩 evaluateFast：新版用它做搜索内循环，给它兜底（旧版没有，退化为钩 evaluate）。
 */
function instrument(pair) {
  let count = 0;
  const target = pair.Eng.evaluateFast ? 'evaluateFast' : 'evaluate';
  const orig = pair.Eng[target];
  pair.Eng[target] = function (b) { count++; return orig(b); };
  pair.evalCount = () => { const c = count; count = 0; return c; };
  return pair;
}

const NEW = instrument(loadPair(path.join(ROOT, 'js/engine.js'), path.join(ROOT, 'js/ai.js'), true));
const OLD = instrument(loadPair(path.join(ROOT, 'tests/fixtures/legacy-engine.js'), path.join(ROOT, 'tests/fixtures/legacy-ai.js')));
const Eng = NEW.Eng;

// 消融对照组：新搜索 + 旧评估。用于分离"搜索改造"和"评估改造"各自的贡献。
// 旧 evaluate 是自包含闭包（只依赖 legacy-engine.js 内部的表），可直接移植到新引擎沙箱。
const SEARCH_ONLY = instrument(loadPair(path.join(ROOT, 'js/engine.js'), path.join(ROOT, 'js/ai.js'), true));
// 两个入口都要替换：evaluate 供候选校正，evaluateFast 供搜索内循环（后者才是主要调用点）
SEARCH_ONLY.Eng.evaluate = OLD.Eng.evaluate;
SEARCH_ONLY.Eng.evaluateFast = OLD.Eng.evaluate;
SEARCH_ONLY.label = '仅搜索';
// 判别组：新静态内循环 + root 校正归零（evaluate ≡ evaluateFast → 校正增量恒为 0）。
// 与全量的唯一差异是 root 不加动态校正——用于定位"校正"与"静态表"谁是灾难源。
const NOCORR = instrument(loadPair(path.join(ROOT, 'js/engine.js'), path.join(ROOT, 'js/ai.js'), true));
NOCORR.Eng.evaluate = NOCORR.Eng.evaluateFast;
NOCORR.label = '全量无校正';
NEW.label = '全量';
OLD.label = '旧版';
const RED = Eng.RED, BLACK = Eng.BLACK;

const argv = process.argv.slice(2);
const arg = (k, def) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const GAMES = +arg('games', 6);
const TIME_MS = +arg('time', 200);
const ONLY = argv.find(a => a === '--perf' || a === '--tactics' || a === '--play') || null;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (detail ? ' → ' + detail : '')); }
}

/* ============================================================
 * 1. 性能基准
 * ============================================================ */
function benchPerf() {
  console.log('\n===== 1. 搜索性能（固定局面，depth 递增） =====');
  const positions = [
    ['开局', Eng.START_FEN],
    ['中局', 'r1ba1a3/4kn3/2n1b4/p1p1p1p1p/9/2P6/P3P1P1P/1C2C1N2/9/RNBAKAB1R w - - 0 1'],
    ['残局', '3aka3/9/9/9/9/9/9/4C4/4A4/3K1AB2 w - - 0 1'],
  ];
  console.log('  局面     深度   旧:叶子数   旧:耗时     仅搜索:叶子  仅搜索:耗时  全量:叶子   全量:耗时');
  for (const [label, fen] of positions) {
    const { board, turn } = Eng.parseFEN(fen);
    for (const depth of [3, 4, 5]) {
      const rows = [OLD, SEARCH_ONLY, NEW].map(p => {
        p.AI.search(board, turn, { depth, timeLimit: 60000 }); // 预热（新引擎需建 TT）
        p.evalCount();
        const t0 = Date.now();
        p.AI.search(board, turn, { depth, timeLimit: 60000 });
        return { n: p.evalCount(), t: Date.now() - t0 };
      });
      console.log('  ' + label.padEnd(8) + String(depth).padEnd(6) +
        String(rows[0].n).padEnd(11) + (rows[0].t + 'ms').padEnd(11) +
        String(rows[1].n).padEnd(12) + (rows[1].t + 'ms').padEnd(13) +
        String(rows[2].n).padEnd(11) + (rows[2].t + 'ms'));
    }
  }

  // 真实场景更关心"同样时间能搜多深"：这里测固定时间预算下的可达深度
  console.log('\n  —— 固定时间预算下的可达深度（越深越强）——');
  console.log('  局面        预算      旧版   仅搜索   全量');
  for (const [label, fen] of positions) {
    const { board, turn } = Eng.parseFEN(fen);
    for (const budget of [200, 1000]) {
      console.log('  ' + label.padEnd(10) + (budget + 'ms').padEnd(9) +
        String(maxDepthIn(OLD, board, turn, budget)).padEnd(7) +
        String(maxDepthIn(SEARCH_ONLY, board, turn, budget)).padEnd(8) +
        String(maxDepthIn(NEW, board, turn, budget)));
    }
  }
}

/** 在给定时间预算内，引擎单步最多能完成到多少层（含超时打断则取上一层） */
function maxDepthIn(pair, board, turn, budget) {
  let best = 0;
  for (let d = 1; d <= 8; d++) {
    const t0 = Date.now();
    pair.AI.search(board, turn, { depth: d, timeLimit: budget });
    if (Date.now() - t0 > budget) break;
    best = d;
  }
  return best;
}

/* ============================================================
 * 2. 一步杀题库（自动生成，ground truth 由规则保证）
 * ============================================================ */
/**
 * 生成题库：从起始局面随机合法对弈，遇到将死就把"杀前一手局面 + 杀棋着法"收为题。
 * 因为收的是"实际导致将死的那一手"，所以答案 100% 正确，不存在人工标注误差。
 */
function genMatePuzzles(count, seed) {
  let s = seed || 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const puzzles = [];
  let guard = 0;
  while (puzzles.length < count && guard < 4000) {
    guard++;
    let board = Eng.parseFEN(Eng.START_FEN).board;
    let turn = RED;
    let last = null; // 杀前一手的 {board, turn, move}
    for (let i = 0; i < 160; i++) {
      const st = Eng.gameStatus(board, turn);
      if (st.status !== 'playing') {
        if (st.status === 'checkmate' && last) puzzles.push(last);
        break;
      }
      const moves = st.moves;
      const m = moves[Math.floor(rnd() * moves.length)];
      last = { board: Eng.cloneBoard(board), turn, move: m };
      board = Eng.makeMove(board, m);
      turn = turn === RED ? BLACK : RED;
    }
  }
  return puzzles;
}

function benchTactics() {
  console.log('\n===== 2. 一步杀题库（自动生成 ' + 40 + ' 题） =====');
  const puzzles = genMatePuzzles(40, 20260905);
  if (!puzzles.length) { console.log('  （未生成题目，跳过）'); return; }
  let hitNew = 0, hitOld = 0;
  for (const p of puzzles) {
    // 判定"走完后对方是否被将死"，而不是"是否等于记录的那步"——
    // 一步杀常有多个解法，锁定单一着法会把正确的杀棋误判为失败。
    const rn = NEW.AI.search(p.board, p.turn, { depth: 3, timeLimit: 2000, topN: 1 });
    const ro = OLD.AI.search(p.board, p.turn, { depth: 3, timeLimit: 2000, topN: 1 });
    const opp = p.turn === RED ? BLACK : RED;
    if (rn.move && Eng.gameStatus(Eng.makeMove(p.board, rn.move), opp).status === 'checkmate') hitNew++;
    if (ro.move && Eng.gameStatus(Eng.makeMove(p.board, ro.move), opp).status === 'checkmate') hitOld++;
  }
  const n = puzzles.length;
  console.log('  题目数：' + n);
  console.log('  新引擎命中：' + hitNew + ' (' + (hitNew / n * 100).toFixed(1) + '%)');
  console.log('  旧引擎命中：' + hitOld + ' (' + (hitOld / n * 100).toFixed(1) + '%)');
  check('一步杀命中率：新引擎 ≥ 旧引擎', hitNew >= hitOld, hitNew + ' vs ' + hitOld);
  check('一步杀命中率：新引擎 ≥ 80%', hitNew / n >= 0.8, (hitNew / n * 100).toFixed(1) + '%');
}

/* ============================================================
 * 3. 自对弈：新引擎 vs 旧引擎
 * ============================================================ */
function playGame(aiRed, aiBlack, opts) {
  // 每局前清 TT 与启发式：跨局残留会让后跑的局获得"预热"优势，污染 A/B 对比
  if (aiRed.reset) aiRed.reset();
  if (aiBlack.reset) aiBlack.reset();
  let board = Eng.parseFEN(Eng.START_FEN).board;
  let turn = RED;
  const seen = new Map();
  // 开局随机 4 手（双方各 2 步），保证每局局面不同、结果有统计意义
  for (let i = 0; i < 4; i++) {
    const moves = Eng.legalMoves(board, turn);
    if (!moves.length) break;
    board = Eng.makeMove(board, moves[Math.floor(Math.random() * moves.length)]);
    turn = turn === RED ? BLACK : RED;
  }
  for (let i = 0; i < opts.maxMoves; i++) {
    const st = Eng.gameStatus(board, turn);
    if (st.status !== 'playing') {
      return { winner: turn === RED ? BLACK : RED, reason: st.status === 'checkmate' ? '将死' : '困毙', plies: i };
    }
    const key = Eng.toFEN(board, turn).split(' ')[0];
    const cnt = (seen.get(key) || 0) + 1;
    seen.set(key, cnt);
    if (cnt >= 3) return { winner: null, reason: '重复局面', plies: i };
    const ai = turn === RED ? aiRed : aiBlack;
    const r = ai.search(board, turn, { depth: opts.depth, timeLimit: opts.timeLimit, topN: 1 });
    if (!r.move) return { winner: turn === RED ? BLACK : RED, reason: '无着可走', plies: i };
    board = Eng.makeMove(board, r.move);
    turn = turn === RED ? BLACK : RED;
  }
  return { winner: null, reason: '达到步数上限', plies: opts.maxMoves };
}

/** A（先手方候选）与 B 对弈 GAMES 局，A 轮流执红/黑，返回 A 的得分率 */
function matchup(a, b, aLabel, bLabel, games) {
  let winA = 0, winB = 0, draw = 0;
  const details = [];
  for (let g = 0; g < games; g++) {
    const aIsRed = g % 2 === 0;
    const r = playGame(aIsRed ? a.AI : b.AI, aIsRed ? b.AI : a.AI, { timeLimit: TIME_MS, maxMoves: 120, depth: 6 });
    let tag;
    if (!r.winner) { draw++; tag = '和'; }
    else if ((r.winner === RED) === aIsRed) { winA++; tag = aLabel + '胜'; }
    else { winB++; tag = bLabel + '胜'; }
    details.push('第' + (g + 1) + '局 ' + aLabel + '执' + (aIsRed ? '红' : '黑') + ' → ' + tag + '（' + r.reason + '，' + r.plies + '步）');
    process.stdout.write('  ' + tag + '          \r');
  }
  console.log('  ' + ' '.repeat(30) + '\r');
  details.forEach(d => console.log('  ' + d));
  const score = (winA + draw * 0.5) / Math.max(1, games);
  console.log('  ' + aLabel + ' ' + winA + ' 胜 / ' + bLabel + ' ' + winB + ' 胜 / ' + draw + ' 和  →  ' +
    aLabel + '得分率 ' + (score * 100).toFixed(1) + '%');
  return score;
}

function benchPlay() {
  console.log('\n===== 3. 自对弈战绩（每步 ' + TIME_MS + 'ms，最多 120 步，每组 ' + GAMES + ' 局）=====');
  const results = {};
  console.log('\n  【主对比】全量（新搜索+新评估） vs 旧版');
  results.full = matchup(NEW, OLD, '全量', '旧版', GAMES);
  if (argv.includes('--ablation')) {
    console.log('\n  【消融 1】仅搜索（新搜索+旧评估） vs 旧版 —— 衡量搜索改造单独的贡献');
    results.searchOnly = matchup(SEARCH_ONLY, OLD, '仅搜索', '旧版', GAMES);
    console.log('\n  【消融 2】全量 vs 仅搜索 —— 衡量评估改造单独的贡献');
    results.evalOnly = matchup(NEW, SEARCH_ONLY, '全量', '仅搜索', GAMES);
    console.log('\n  ── 增益归因 ──');
    console.log('  搜索改造贡献（仅搜索 vs 旧版）：' + (results.searchOnly * 100).toFixed(1) + '% 得分率');
    console.log('  评估改造贡献（全量 vs 仅搜索）：' + (results.evalOnly * 100).toFixed(1) + '% 得分率');
  }
  if (argv.includes('--nocorr')) {
    console.log('\n  【判别 1】全量无校正（新静态内循环，校正=0） vs 旧版 —— 静态表本身的真实棋力');
    results.nocorr = matchup(NOCORR, OLD, '全量无校正', '旧版', GAMES);
    console.log('\n  【判别 2】全量无校正 vs 仅搜索 —— 同为无校正：新静态表 vs 旧评估（搜索同源）');
    results.nocorrVsSearch = matchup(NOCORR, SEARCH_ONLY, '全量无校正', '仅搜索', GAMES);
  }
  check('全量引擎得分率 > 50%（强于旧版）', results.full > 0.5, (results.full * 100).toFixed(1) + '%');
  return results;
}

/* ============================================================ */
console.log('════════ 引擎棋力基准 · ' + new Date().toLocaleString('zh-CN') + ' ════════');
if (!ONLY || ONLY === '--perf') benchPerf();
if (!ONLY || ONLY === '--tactics') benchTactics();
if (!ONLY || ONLY === '--play') benchPlay();
console.log('\n断言：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
