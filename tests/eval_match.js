/* ============================================================
 * eval_match.js — 配对局面棋力测试（比整局对弈信噪比高一个量级）
 *
 *   node tests/eval_match.js                 # 默认 40 局面 × 12 步
 *   node tests/eval_match.js --pos 80        # 指定局面数
 *   node tests/eval_match.js --plies 12      # 每个局面走多少步
 *
 * 为什么不用整局自对弈：
 *   整局对弈的胜负是二值信号，8 局的标准差高达 ±18%，
 *   根本区分不了 10% 的棋力差（实测"新旧评估"跑出的 25%~44% 全是噪声）。
 * 本方法：
 *   1. 生成一批随机中局局面
 *   2. 每个局面让 A 执红/B 执黑 走 K 步，再交换先后手走一遍
 *   3. 用「子力净优势」作为连续信号，两次相减消除先后手偏差
 *   连续信号 + 配对设计，同样时间下噪声约为整局对弈的 1/5。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
// 安全参数解析：argv.indexOf 缺失时返回 -1，直接 +1 会误取 argv[0]（→ NaN）
const arg = (k, def) => {
  const i = argv.indexOf(k);
  return (i >= 0 && argv[i + 1] && !isNaN(+argv[i + 1])) ? +argv[i + 1] : def;
};
const NPOS = arg('--pos', 40);
const PLIES = arg('--plies', 12);
// timeLimit 只作安全网：必须大到保证固定深度总能完成。
// 若预算截断搜索，aborted 的部分结果不确定（受机器负载影响），
// 配对两次 rollout 会走出不同棋谱——自检实测因此偏离 0 达 ±64 分，淹没真实信号。
const TIME_MS = arg('--time', 5000);
const SEED = arg('--seed', 20260905);
function sandboxLoad(files) {
  const s = {};
  s.window = s; s.globalThis = s; s.global = s; s.Date = Date; s.Math = Math;
  const code = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  // eslint-disable-next-line no-new-func
  (new Function('window', 'globalThis', 'global', code))(s, s, s);
  return s;
}

function sandboxLoadSrcs(srcList, extraFile) {
  const s = {};
  s.window = s; s.globalThis = s; s.global = s; s.Date = Date; s.Math = Math;
  const code = srcList.join('\n') + (extraFile ? '\n' + fs.readFileSync(extraFile, 'utf8') : '');
  // eslint-disable-next-line no-new-func
  (new Function('window', 'globalThis', 'global', code))(s, s, s);
  return s;
}

const NEW = sandboxLoadSrcs([], path.join(ROOT, 'js/engine.js'));
const Eng = NEW.ChessEngine;
const RED = Eng.RED, BLACK = Eng.BLACK;

// 用「旧评估」当尺子给终局打分：不能让被测引擎用自己的评估给自己打分，
// 否则测的是自我一致性而不是棋力。旧版 evaluate 是自包含闭包，可安全移植。
const LEGACY_EVAL = sandboxLoadSrcs([], path.join(ROOT, 'tests/fixtures/legacy-engine.js')).ChessEngine.evaluate;

/** 用给定的 engine.js 源码 + 当前 ai.js 构造一个引擎沙箱 */
function makeEngine(engineSrc) {
  return sandboxLoadSrcs([engineSrc], path.join(ROOT, 'js/ai.js'));
}

/**
 * 终局信号：用第三方（旧）评估给最终局面打分，红正黑负。
 * 一开始用「子力差」，但实测 8 步内双方常常一个子都没吃，信号恒为 0，
 * 完全测不出差异。位置分是连续信号，对没有吃子的局面同样敏感。
 */
function positionScore(board) { return LEGACY_EVAL(board); }

/** 从 startBoard 出发走 plies 步，返回终局评分（红方视角，含终局惩罚） */
const DEPTH = arg('--depth', 4);

function rollout(startBoard, startTurn, aiRed, aiBlack, plies) {
  let board = Eng.cloneBoard(startBoard);
  let turn = startTurn;
  // 关键：每次 rollout 前清空 TT 与启发式，否则先跑的一方会给后跑方预热，
  // 产生系统性偏差（自检实测 -203 分，比真实棋力差还大）。
  if (aiRed.reset) aiRed.reset();
  if (aiBlack.reset) aiBlack.reset();
  for (let i = 0; i < plies; i++) {
    const st = Eng.gameStatus(board, turn);
    if (st.status !== 'playing') {
      // 轮到 turn 走却无着 → turn 方负
      return turn === RED ? -5000 : 5000;
    }
    const ai = turn === RED ? aiRed : aiBlack;
    // 用固定深度而非时间限制：时间预算会随机器负载抖动，给测量引入额外噪声
    const r = ai.search(board, turn, { depth: DEPTH, timeLimit: TIME_MS, topN: 1 });    if (!r || !r.move) return turn === RED ? -5000 : 5000;
    board = Eng.makeMove(board, r.move);
    turn = turn === RED ? BLACK : RED;
  }
  return positionScore(board);
}

/** 生成随机中局局面（走 10~24 手随机合法着法，且局面未结束） */
function genPositions(n, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out = [];
  let guard = 0;
  while (out.length < n && guard < n * 60) {
    guard++;
    let board = Eng.parseFEN(Eng.START_FEN).board;
    let turn = RED;
    const steps = 10 + Math.floor(rnd() * 14);
    let ok = true;
    for (let i = 0; i < steps; i++) {
      const ms = Eng.legalMoves(board, turn);
      if (!ms.length) { ok = false; break; }
      board = Eng.makeMove(board, ms[Math.floor(rnd() * ms.length)]);
      turn = turn === RED ? BLACK : RED;
    }
    if (!ok) continue;
    if (Eng.gameStatus(board, turn).status !== 'playing') continue;
    out.push({ board, turn });
  }
  return out;
}

/**
 * 配对测试：A 与 B 在同一批局面上交换先后手各走一遍。
 * 返回 A 的平均净子力优势（正 = A 更强）。
 */
function matchup(A, B, positions) {
  let total = 0, n = 0;
  for (let i = 0; i < positions.length; i++) {
    const { board, turn } = positions[i];
    // run1：A 执红方视角（按 turn 分配，保证 A/B 各执一次先手）
    const run1 = rollout(board, turn, A, B, PLIES);
    const run2 = rollout(board, turn, B, A, PLIES);
    // run1 中 A 是"turn 方"，run2 中 A 是对手方。统一折算成 A 的净优势：
    // run1 返回红-黑；若 A 执红(turn=RED) 则 A 优势 = run1，否则 = -run1
    const a1 = turn === RED ? run1 : -run1;
    const a2 = turn === RED ? -run2 : run2;
    total += (a1 + a2) / 2;
    n++;
    process.stdout.write('  ' + n + '/' + positions.length + '  当前均值 ' + (total / n).toFixed(1) + '        \r');
  }
  process.stdout.write('                                              \r');
  return total / Math.max(1, n);
}

/* ---------------- 变体定义 ---------------- */
const NEW_ENGINE_SRC = fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8');
const P_OLD = `const P_TABLE = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [6, 8, 10, 16, 20, 16, 10, 8, 6],
    [4, 6, 8, 12, 16, 12, 8, 6, 4],
    [2, 4, 6, 10, 12, 10, 6, 4, 2],
    [0, 2, 2, 4, 6, 4, 2, 2, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];`;
const OFF_P = s => s.replace(/const P_TABLE = \[[\s\S]*?\n  \];/, P_OLD)
  .replace('v += P_TABLE[rr][c];', 'v += P_TABLE[r][c];');
const OFF_R = s => s.replace(
  "case 'R': v += R_TABLE[rr][c]; break;",
  "case 'R': v += (p.color === RED ? r >= 7 : r <= 2) ? 12 : 0; if (r === 0 || r === 9) v -= 6; break;");
const OFF_AB = s => s.replace("case 'A': v += A_TABLE[rr][c]; break;", "case 'A': break;")
  .replace("case 'B': v += B_TABLE[rr][c]; break;", "case 'B': break;");
// 关掉动态项（机动性/悬子/九宫/防线）：把完整 evaluate 直接退化为 evaluateFast
const OFF_DYN = s => s.replace(
  /function evaluate\(board\) \{\n    let score = evaluateFast\(board\);/,
  'function evaluate(board) {\n    const score = evaluateFast(board); if (1) return score;');

function buildVariant(name, src) {
  const s = makeEngine(src);
  // 与基线口径一致：搜索内循环与候选校正都走同一套评估
  s.ChessEngine.evaluateFast = s.ChessEngine.evaluateFast || s.ChessEngine.evaluate;
  return s.ChessAI;
}

/* ---------------- 主流程 ---------------- */
console.log('════════ 配对局面棋力测试 ════════');
console.log('局面数 ' + NPOS + '，每局面 ' + PLIES + ' 步，每步 ' + TIME_MS + 'ms\n');

const positions = genPositions(NPOS, SEED);
console.log('生成中局局面：' + positions.length + ' 个\n');

// 基线：新引擎骨架 + 旧评估函数引用双替换。
// 不用字符串补丁当基线：补丁会残留新行为（如过河+40、root 校正），
// 函数引用直换则与 legacy 完全等价，口径最干净。
function makeBaseline() {
  const s = makeEngine(NEW_ENGINE_SRC);
  s.ChessEngine.evaluate = LEGACY_EVAL;
  s.ChessEngine.evaluateFast = LEGACY_EVAL;
  return s.ChessAI;
}
const BASE = makeBaseline();

// 自检：基线 vs 自己的副本（应 ≈ 0）
console.log('── 自检（基线 vs 基线副本，理想值 0）──');
const selfCheck = matchup(BASE, makeBaseline(), positions.slice(0, 15));
console.log('  基线 vs 基线副本：' + selfCheck.toFixed(1) + ' 分（越接近 0 说明方法噪声越小）\n');

// 前向选择：从旧评估出发一次只加一项，信号比"逐项禁用"干净。
// 变体不动 evaluateFast——与生产 dual-speed 口径一致（内循环 fast，root 由 ai.js 自动加动态校正）。
const VARIANTS = [
  { name: '只留 新兵表(P)', src: OFF_R(OFF_AB(OFF_DYN(NEW_ENGINE_SRC))) },
  { name: '只留 新车表(R)', src: OFF_P(OFF_AB(OFF_DYN(NEW_ENGINE_SRC))) },
  { name: '只留 新士象表(A/B)', src: OFF_P(OFF_R(OFF_DYN(NEW_ENGINE_SRC))) },
  { name: '只留 动态项(root校正)', src: OFF_P(OFF_R(OFF_AB(NEW_ENGINE_SRC))) },
  { name: '仅静态(全表,关动态)', src: OFF_DYN(NEW_ENGINE_SRC) },
  { name: '全套新评估(静态+动态)', src: NEW_ENGINE_SRC },
];

console.log('── 各变体 vs 旧评估基线（正数 = 该变体更强，单位：子力分）──');
// --only <子串>：只跑名字含该子串的变体（深度加大后单变体变慢，用于定向复测）
const ONLY_SUB = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const results = [];
for (const v of VARIANTS) {
  if (ONLY_SUB && !v.name.includes(ONLY_SUB)) continue;
  const ai = buildVariant(v.name, v.src);
  const adv = matchup(ai, BASE, positions);
  results.push({ name: v.name, adv });
  console.log('  ' + v.name.padEnd(26) + (adv >= 0 ? '+' : '') + adv.toFixed(1));
}

console.log('\n  ── 排序 ──');
results.sort((a, b) => b.adv - a.adv);
for (const r of results) {
  const bar = r.adv >= 0 ? '█'.repeat(Math.min(30, Math.round(r.adv / 5))) : '▓'.repeat(Math.min(30, Math.round(-r.adv / 5)));
  console.log('  ' + r.name.padEnd(26) + (r.adv >= 0 ? '+' : '') + r.adv.toFixed(1).padStart(8) + '  ' + bar);
}
