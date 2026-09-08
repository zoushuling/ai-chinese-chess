/* ============================================================
 * ablation_eval.js — 评估函数逐项消融（定位哪一项改动有害）
 *
 *   node tests/ablation_eval.js              # 默认每项 6 局
 *   node tests/ablation_eval.js --games 10   # 指定局数
 *
 * 做法：以「旧评估 + 新搜索」为基线，把新评估的每一项改动单独保留/禁用，
 * 生成变体引擎与基线对打，用得分率判断该项是增益还是负增益。
 * 只影响 evaluateFast（搜索内循环）的静态项在这里能被干净地隔离出来。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xq-ablation-'));
const NEW_ENGINE = fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8');
const NEW_AI = fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8');
const LEGACY_ENGINE = fs.readFileSync(path.join(ROOT, 'tests/fixtures/legacy-engine.js'), 'utf8');

const argv = process.argv.slice(2);
// 安全参数解析：argv.indexOf 缺失时返回 -1，直接 +1 会误取 argv[0]（→ NaN）
const argN = (k, def) => {
  const i = argv.indexOf(k);
  return (i >= 0 && argv[i + 1] && !isNaN(+argv[i + 1])) ? +argv[i + 1] : def;
};
const GAMES = argN('--games', 6);
const TIME_MS = argN('--time', 150);

/** 用字符串替换生成引擎变体源码 */
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

// 三个"禁用器"：把某一项新改动退回旧版实现
const OFF_P = s => s.replace(/const P_TABLE = \[[\s\S]*?\n  \];/, P_OLD)
  .replace('v += P_TABLE[rr][c];', 'v += P_TABLE[r][c];');
const OFF_R = s => s.replace(
  "case 'R': v += R_TABLE[rr][c]; break;",
  "case 'R': v += (p.color === RED ? r >= 7 : r <= 2) ? 12 : 0; if (r === 0 || r === 9) v -= 6; break;");
const OFF_AB = s => s.replace("case 'A': v += A_TABLE[rr][c]; break;", "case 'A': break;")
  .replace("case 'B': v += B_TABLE[rr][c]; break;", "case 'B': break;");
// 关掉动态项（机动性/悬子/九宫/防线）：完整 evaluate 退化为 evaluateFast，root 校正增量归零
const OFF_DYN = s => s.replace(
  /function evaluate\(board\) \{\n    let score = evaluateFast\(board\);/,
  'function evaluate(board) {\n    const score = evaluateFast(board); if (1) return score;');

// 前向选择：从旧评估出发，一次只保留一项新改动，信号比"逐个禁用"更干净。
// 不动 evaluateFast——与生产 dual-speed 口径一致（内循环 fast，root 由 ai.js 自动加动态校正）。
const VARIANTS = [
  { name: '只留 新兵表(P)', patch: s => OFF_R(OFF_AB(OFF_DYN(s))) },
  { name: '只留 新车表(R)', patch: s => OFF_P(OFF_AB(OFF_DYN(s))) },
  { name: '只留 新士象表(A/B)', patch: s => OFF_P(OFF_R(OFF_DYN(s))) },
  { name: '只留 动态项(root校正)', patch: s => OFF_P(OFF_R(OFF_AB(s))) },
  { name: '仅静态(全表,关动态)', patch: s => OFF_DYN(s) },
  { name: '只留旧表(空跑自检)', patch: s => OFF_P(OFF_R(OFF_AB(OFF_DYN(s)))) },
];

function loadVariant(src, tag) {
  const p = path.join(TMP, tag + '.js');
  fs.writeFileSync(p, src);
  const sandbox = {};
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.global = sandbox;
  sandbox.Date = Date; sandbox.Math = Math;
  // eslint-disable-next-line no-new-func
  (new Function('window', 'globalThis', 'global', src + '\n' + NEW_AI))(sandbox, sandbox, sandbox);
  return sandbox;
}

/**
 * 基线 = 旧评估 + 新搜索。
 * 注意不能直接拿 legacy-engine.js 当基线：它没有 Zobrist 接口，新 ai.js 会崩。
 * 正确做法是以新引擎为底座，只把评估函数换成旧版（旧 evaluate 是自包含闭包，可安全移植）。
 */
const legacyOnly = loadVariant(LEGACY_ENGINE + '\n', 'legacyOnly');
const LEGACY_EVAL = legacyOnly.ChessEngine.evaluate;
const BASE = loadVariant(NEW_ENGINE, 'baseline');
BASE.ChessEngine.evaluate = LEGACY_EVAL;
BASE.ChessEngine.evaluateFast = LEGACY_EVAL;

const Eng = BASE.ChessEngine;
const RED = Eng.RED, BLACK = Eng.BLACK;

function playGame(aRed, aBlack) {
  let board = Eng.parseFEN(Eng.START_FEN).board;
  let turn = RED;
  const seen = new Map();
  for (let i = 0; i < 4; i++) { // 开局随机 4 手，保证局面多样
    const ms = Eng.legalMoves(board, turn);
    if (!ms.length) break;
    board = Eng.makeMove(board, ms[Math.floor(Math.random() * ms.length)]);
    turn = turn === RED ? BLACK : RED;
  }
  for (let i = 0; i < 120; i++) {
    const st = Eng.gameStatus(board, turn);
    if (st.status !== 'playing') return { winner: turn === RED ? BLACK : RED, reason: st.status };
    const key = Eng.toFEN(board, turn).split(' ')[0];
    const c = (seen.get(key) || 0) + 1; seen.set(key, c);
    if (c >= 3) return { winner: null, reason: '重复' };
    const ai = turn === RED ? aRed : aBlack;
    const r = ai.ChessAI.search(board, turn, { depth: 6, timeLimit: TIME_MS, topN: 1 });
    if (!r.move) return { winner: turn === RED ? BLACK : RED, reason: '无着' };
    board = Eng.makeMove(board, r.move);
    turn = turn === RED ? BLACK : RED;
  }
  return { winner: null, reason: '步数上限' };
}

function matchup(a, games) {
  let win = 0, lose = 0, draw = 0;
  for (let g = 0; g < games; g++) {
    const aIsRed = g % 2 === 0;
    const r = playGame(aIsRed ? a : BASE, aIsRed ? BASE : a);
    if (!r.winner) draw++;
    else if ((r.winner === RED) === aIsRed) win++;
    else lose++;
    process.stdout.write('  ' + win + '胜' + lose + '负' + draw + '和\r');
  }
  process.stdout.write('                    \r');
  return (win + draw * 0.5) / games;
}

console.log('════════ 评估函数逐项消融（每项 ' + GAMES + ' 局，每步 ' + TIME_MS + 'ms）════════');
console.log('基线 = 旧评估 + 新搜索。得分率 >50% 表示该项改动是增益。\n');

const results = [];
// 先测全套新评估
const full = loadVariant(NEW_ENGINE, 'full');
full.ChessEngine.evaluateFast = full.ChessEngine.evaluate; // 与基线口径一致：内循环也用其完整评估
results.push({ name: '【全套新评估】', score: matchup(full, GAMES) });

for (let i = 0; i < VARIANTS.length; i++) {
  const v = VARIANTS[i];
  let src;
  try { src = v.patch(NEW_ENGINE); } catch (e) { console.log('  跳过 ' + v.name + '（替换失败）'); continue; }
  if (src === NEW_ENGINE) { console.log('  ⚠ ' + v.name + ' 的替换未生效，请检查匹配串'); continue; }
  const sand = loadVariant(src, 'v' + i);
  sand.ChessEngine.evaluateFast = sand.ChessEngine.evaluate;
  results.push({ name: v.name, score: matchup(sand, GAMES) });
}

console.log('\n  ── 结果（得分率 = 该引擎对基线的得分率）──');
results.sort((a, b) => b.score - a.score);
for (const r of results) {
  const bar = '█'.repeat(Math.round(r.score * 25));
  console.log('  ' + r.name.padEnd(34) + (r.score * 100).toFixed(1).padStart(6) + '%  ' + bar);
}
console.log('\n  读法：禁用某项的得分率 > 全套新评估的得分率 ⇒ 那一项是负增益，应该去掉或调小。');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
