/* 探针：统计开局第一步全部走法的 swing 分布，验证判定门槛是否失衡（只读脚本） */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(ROOT, 'js', 'engine.js'), 'utf8'));
const E = globalThis.ChessEngine;

const START = globalThis.ChessEngine.START_FEN;
const b0 = E.parseFEN(START).board;
const e0 = E.evaluate(b0);

function apply(b, m) {
  const nb = b.map(r => r.slice());
  const p = nb[m.fr][m.fc];
  nb[m.tr][m.tc] = p; nb[m.fr][m.fc] = null;
  return nb;
}
const moves = E.genMoves(b0, 'r');
const rows = [];
for (const m of moves) {
  const nb = apply(b0, m);
  const cap = b0[m.tr][m.tc];
  rows.push({ swing: E.evaluate(nb) - e0, cap: cap ? cap.type : '', m });
}
rows.sort((a, b) => b.swing - a.swing);
const good = rows.filter(r => r.swing >= 150);
const bad = rows.filter(r => r.swing <= -150);
console.log(`开局红方第一步共 ${rows.length} 个伪合法走法（玩家视角 swing）：`);
console.log(`  判「好棋」(swing ≥ +150) : ${good.length} 个 —— 全部是吃子: ${good.every(r => r.cap)}`);
console.log(`  判「臭棋」(swing ≤ -150) : ${bad.length} 个`);
console.log(`  不反应(|swing| < 150)    : ${rows.length - good.length - bad.length} 个\n`);
console.log('swing 最高的 6 个：');
rows.slice(0, 6).forEach(r => console.log(`  +${String(Math.round(r.swing)).padStart(4)}  ${r.m.notation || '?'}  吃子=${r.cap || '无'}`));
console.log('swing 最低的 6 个：');
rows.slice(-6).forEach(r => console.log(`  ${String(Math.round(r.swing)).padStart(5)}  ${r.m.notation || '?'}  吃子=${r.cap || '无'}`));
console.log(`\n单步最大理论跌幅 = 悬子惩罚(车 ${Math.round(900 / 8)}) + 位置分恶化；`);
console.log(`而吃一子最小收益 = 兵 100 ~ 马 400 → 正向门槛(150)极易越过，负向门槛几乎够不到。`);
