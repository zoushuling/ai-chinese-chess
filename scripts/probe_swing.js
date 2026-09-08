/* 探针：量化「坏棋被判成好棋」的 swing 计算（只读脚本，不参与游戏运行） */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(ROOT, 'js', 'engine.js'), 'utf8'));
const E = globalThis.ChessEngine;

const START = globalThis.ChessEngine.START_FEN;

function boardOf(fen) { return E.parseFEN(fen).board; }
function clone(b) { return b.map(row => row.slice()); }
/** 合法吃子/移动：覆盖目标格，但拒绝吃己方子（探针自身保护） */
function move(b, fr, fc, tr, tc) {
  const nb = clone(b);
  const src = nb[fr][fc], dst = nb[tr][tc];
  if (!src) throw new Error(`起点 (${fr},${fc}) 无子`);
  if (dst && dst.color === src.color) throw new Error(`目标 (${tr},${tc}) 是己方子`);
  nb[tr][tc] = src; nb[fr][fc] = null;
  return nb;
}
function report(name, mut, note) {
  let b1;
  try { b1 = mut(clone(boardOf(START))); }
  catch (e) { console.log(`${name.padEnd(24)} 跳过：${e.message}`); return; }
  const e0 = E.evaluate(boardOf(START)), e1 = E.evaluate(b1);
  const swing = e1 - e0;               // 玩家执红视角
  const verdict = Math.abs(swing) < 150 ? '不反应(<150)' : (swing > 0 ? '★判定好棋 +3' : '判定臭棋 -3');
  console.log(`${name.padEnd(24)} swing=${String(Math.round(swing)).padStart(6)}  ${verdict.padEnd(14)} ${note || ''}`);
}

console.log('== 初始局面，红方（玩家）走子；swing = evaluate(走后) - evaluate(走前)，阈值 ±150 ==\n');
console.log('-- 公认坏棋 --');
report('炮八进七 打底马', b => move(b, 7, 7, 0, 7), '炮换马，随后炮被黑车吃 → 净亏');
report('车九进六 吃卒', b => move(b, 9, 0, 3, 0), '车吃卒后被黑车沿列反吃 → 丢车');
report('车九进五 探卒林', b => move(b, 9, 0, 4, 0), '车入卒口（黑卒可吃）→ 送子');
console.log('\n-- 公认正着 --');
report('炮二平五 中炮', b => move(b, 7, 7, 7, 4), '');
report('马八进七', b => move(b, 9, 7, 7, 6), '');
report('车九进一', b => move(b, 9, 0, 8, 0), '');
report('兵七进一', b => move(b, 6, 6, 5, 6), '');
console.log('\n-- 悬子惩罚实测（THREAT_DIV=8）--');
console.log('送车到黑车口中，理论应 -900，但只扣 ' + Math.round(900 / 8) + '（子力/8），其余被位置分吃掉。');
