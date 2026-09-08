/* 探针：验证「搜索复核」判定能否纠正静态 swing 的误判（只读脚本）
 * loss = (-search(走后, 对手).score) - search(走前, 玩家).score，玩家视角，≤0 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const load = f => eval(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'));
load('engine.js'); load('book.js'); load('ai.js');
const E = globalThis.ChessEngine, AI = globalThis.ChessAI;

const DEPTH = 2, TL = 200;
function loss(before, after, pc) {
  const opp = pc === 'r' ? 'b' : 'r';
  const best = AI.search(before, pc, { depth: DEPTH, topN: 3, timeLimit: TL });
  const reply = AI.search(after, opp, { depth: DEPTH, topN: 3, timeLimit: TL });
  if (!best || !reply || !Number.isFinite(best.score) || !Number.isFinite(reply.score)) return null;
  return {
    loss: Math.round(-reply.score - best.score),
    best: best.candidates && best.candidates[0] ? best.candidates[0].notation : null,
  };
}
function judge(l) {
  if (l >= -20) return '好棋 +3';
  if (l >= -60) return '尚可 +2';
  if (l > -150) return '不反应';
  if (l > -400) return '臭棋 -3';
  return '严重臭棋 -5';
}
function run(name, fen, mvSel, pc, note) {
  const b0 = E.parseFEN(fen).board;
  const m = E.legalMoves(b0, pc).find(mvSel);
  if (!m) { console.log(`${name}: 找不到该走法`); return; }
  const not = E.notation(b0, m);
  const b1 = E.makeMove(b0, m);
  const e0 = E.evaluate(b0), e1 = E.evaluate(b1);
  const swing = pc === 'r' ? e1 - e0 : e0 - e1;
  const t0 = Date.now();
  const r = loss(b0, b1, pc);
  const dt = Date.now() - t0;
  console.log(`${name.padEnd(18)} ${not.padEnd(12)} 静态swing=${String(Math.round(swing)).padStart(5)}  复核loss=${String(r ? r.loss : 'NA').padStart(6)}  → ${r ? judge(r.loss) : 'NA'}  [${dt}ms] ${note || ''}`);
}

console.log('== 开局：静态判定误判的坏棋 ==');
run('炮打底马', E.START_FEN, m => m.fr === 7 && m.fc === 7 && m.tr === 0 && m.tc === 7, 'r', '吃马后被车吃炮');
run('车吃卒送车', E.START_FEN, m => m.fr === 9 && m.fc === 0 && m.tr === 3 && m.tc === 0, 'r', '吃卒后被黑车反吃');
console.log('\n== 开局：正着（静态不反应，复核看是否也沉默）==');
run('中炮', E.START_FEN, m => m.fr === 7 && m.fc === 7 && m.tr === 7 && m.tc === 4, 'r', '');
run('马八进七', E.START_FEN, m => m.fr === 9 && m.fc === 7 && m.tr === 7 && m.tc === 6, 'r', '');
console.log('\n== 构造局面：安全吃子 vs 送车 ==');
run('安全吃马', '4k4/9/9/9/9/n8/9/9/9/R4K4 w - - 0 1', m => m.fr === 9 && m.fc === 0 && m.tr === 5 && m.tc === 0, 'r', '黑无法吃回');
run('吃马被车吃', 'r3k4/9/9/9/9/n8/9/9/9/R4K4 w - - 0 1', m => m.fr === 9 && m.fc === 0 && m.tr === 5 && m.tc === 0, 'r', '黑车沿列吃回红车');
