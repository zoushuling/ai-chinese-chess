/* 好棋/臭棋判定单元测试（Node）：node tests/test_react_judge.js
 * 覆盖 V0.5.2 的两级判定：
 *   ① AI.classifyLoss 分档（good +3 / blunder -3 / terrible -5 / 平淡 null）
 *   ② AI.moveLoss 用浅搜索识破"吃子后被反吃"（静态评估看不见的坏棋）
 */
'use strict';

require('../js/engine.js');
require('../js/book.js');
require('../js/ai.js');
const E = globalThis.ChessEngine;
const AI = globalThis.ChessAI;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

/* ---------- ① 亏损分档 ---------- */
console.log('== classifyLoss 分档 ==');
check('0 分 → good +3', JSON.stringify(AI.classifyLoss(0)) === JSON.stringify({ kind: 'good', delta: 3 }));
check('+50 分（优于最优，深度差导致）→ good', AI.classifyLoss(50).kind === 'good');
check('阈值 -30 命中 good', AI.classifyLoss(AI.LOSS_THRESHOLDS.good).kind === 'good');
check('-31 分 → 不反应', AI.classifyLoss(-31) === null);
check('-100 分 → 不反应（略亏）', AI.classifyLoss(-100) === null);
check('阈值 -120 命中 blunder', AI.classifyLoss(AI.LOSS_THRESHOLDS.blunder).kind === 'blunder');
check('-121 分 → blunder -3', AI.classifyLoss(-121).delta === -3);
check('阈值 -350 命中 terrible', AI.classifyLoss(AI.LOSS_THRESHOLDS.terrible).kind === 'terrible');
check('-900 分（丢车）→ terrible -5', AI.classifyLoss(-900).delta === -5);
check('NaN → null', AI.classifyLoss(NaN) === null);
check('undefined → null', AI.classifyLoss(undefined) === null);

/* ---------- ② moveLoss 真实搜索 ---------- */
console.log('\n== moveLoss：识破静态评估看不见的坏棋 ==');

/** 走一步并返回 {loss, verdict, notation} */
function play(fen, mover, sel) {
  const b0 = E.parseFEN(fen).board;
  const m = E.legalMoves(b0, mover).find(sel);
  if (!m) return null;
  const b1 = E.makeMove(b0, m);
  const r = AI.moveLoss(b0, b1, mover, { depth: 2, timeLimit: 200 });
  const e0 = E.evaluate(b0), e1 = E.evaluate(b1);
  const swing = mover === 'r' ? e1 - e0 : e0 - e1; // 静态分差（旧判定口径）
  return {
    notation: E.notation(b0, m),
    loss: r ? r.loss : null,
    best: r && r.best ? r.best.notation : null,
    verdict: r ? AI.classifyLoss(r.loss) : null,
    swing: Math.round(swing),
  };
}
const eatAt = (fr, fc, tr, tc) => m => m.fr === fr && m.fc === fc && m.tr === tr && m.tc === tc;

// 安全吃马：黑方无法吃回 → 真·好棋（静态 +502，复核也判好棋）
const safe = play('3k5/9/9/9/9/n8/9/9/9/R4K4 w - - 0 1', 'r', eatAt(9, 0, 5, 0));
check('安全吃马：loss 接近 0', safe.loss >= AI.LOSS_THRESHOLDS.good, safe.loss);
check('安全吃马：判定 good', safe.verdict && safe.verdict.kind === 'good', JSON.stringify(safe.verdict));
check('安全吃马：静态分差同为正（旧判定也判好棋）', safe.swing > 150, safe.swing);

// 吃马被车吃回：静态也是 +492（旧判定会夸），复核必须识破
const trap = play('r2k5/9/9/9/9/n8/9/9/9/R4K4 w - - 0 1', 'r', eatAt(9, 0, 5, 0));
check('吃马被反吃：静态分差仍为正（旧判定会误夸）', trap.swing > 150, trap.swing);
check('吃马被反吃：复核 loss ≤ -350', trap.loss <= AI.LOSS_THRESHOLDS.terrible, trap.loss);
check('吃马被反吃：判定 terrible -5', trap.verdict && trap.verdict.delta === -5, JSON.stringify(trap.verdict));
check('吃马被反吃：给出更优着法', typeof trap.best === 'string' && trap.best.length > 0, trap.best);

// 开局"炮打底马"：吃子但净亏约 50（炮换马），旧判定 +301 会夸，新判定应沉默
const cannon = play(E.START_FEN, 'r', eatAt(7, 7, 0, 7));
check('炮打底马：静态分差为正（旧判定会误夸）', cannon.swing > 150, cannon.swing);
check('炮打底马：复核 loss 在 -30~-120 之间', cannon.loss < AI.LOSS_THRESHOLDS.good && cannon.loss > AI.LOSS_THRESHOLDS.blunder, cannon.loss);
check('炮打底马：不反应（既不夸也不骂）', cannon.verdict === null, JSON.stringify(cannon.verdict));

// 黑方视角对称：同样的"吃子被反吃"在黑方也要识破
const bTrap = play('R8/9/3k5/9/9/N8/9/9/9/r3K4 b - - 0 1', 'b', eatAt(9, 0, 5, 0));
check('黑方吃子被反吃：判定 terrible', bTrap.verdict && bTrap.verdict.kind === 'terrible', JSON.stringify(bTrap.verdict));
check('黑方视角 loss 与红方同量级（符号一致）', bTrap.loss <= AI.LOSS_THRESHOLDS.terrible, bTrap.loss);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
