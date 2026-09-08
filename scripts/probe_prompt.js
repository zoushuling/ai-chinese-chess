/* 探针：复现「好棋/臭棋」反应时真实发给 LLM 的 system 提示词（只读脚本）
 * V0.5.2：判定改为「静态闸门 + 搜索复核」，提示词改为只给引擎事实、不下结论。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const load = f => eval(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'));
load('engine.js'); load('book.js'); load('ai.js'); load('personas.js');
const E = globalThis.ChessEngine, AI = globalThis.ChessAI, P = globalThis.Personas;

const persona = P.get('street_king');
// 场景：红车吃黑马，随后被黑车沿列反吃（旧判定：静态 +492 → 夸；新判定：loss -518 → 严重臭棋）
const FEN = 'r2k5/9/9/9/9/n8/9/9/9/R4K4 w - - 0 1';
const b0 = E.parseFEN(FEN).board;
const mv = E.legalMoves(b0, 'r').find(m => m.fr === 9 && m.fc === 0 && m.tr === 5 && m.tc === 0);
const not = E.notation(b0, mv);
const b1 = E.makeMove(b0, mv);
const swing = Math.round(E.evaluate(b1) - E.evaluate(b0));
const r = AI.moveLoss(b0, b1, 'r', { depth: 2, timeLimit: 200 });
const verdict = AI.classifyLoss(r.loss);
const better = r.best ? r.best.notation : null;
const fen = E.toFEN(b1, 'b');
const ev = E.evalSummary(b1);
const res = AI.search(b1, 'b', { depth: 2, topN: 3, timeLimit: 300 });
const topMoves = res.candidates || [];

const lossTxt = `引擎认为这步相对最优着法 ${r.loss >= 0 ? '+' : ''}${r.loss} 分（0 分表示与最优等价，负得越多亏得越多）`;
const pos = [
  '当前棋局信息：',
  '- 现在轮到：黑方走子',
  `- FEN：${fen}`,
  `- 局面评估：${ev.label}（分差约 ${ev.diff} 分）`,
  topMoves.length ? '- 引擎推荐走法（按推荐度降序）：' + topMoves.map((m, i) => `${i + 1}. ${m.notation} (${m.score > 0 ? '+' : ''}${Math.round(m.score)})`).join('，') : '- 引擎推荐走法：（异步填充，自动反应时通常为空）',
  `- 上一手：红方 ${not}（这步是用户走的，吃掉了黑方的马）`,
].join('\n');

const head = `你是「${persona.name}」${persona.emoji}，执黑方，正在和用户（执红方）下中国象棋。\n` +
  `你的人设：${persona.desc}\n` +
  P.styleText(persona) + '\n' +
  '回复风格：像真人棋友一样口语化聊天，不要 Markdown 列表/标题，不要复述 FEN 或系统数据，不要自称 AI；默认 1~5 句，除非用户要求详细分析。\n\n' +
  pos;

const GOOD_INSTR = '对手刚走了一步棋，走法与引擎评估见后。请结合你自己的判断，按你的人设风格作出反应：可以称赞、惊讶、警惕，也可以嘴硬，用一两句口语，不要书面分析。';
const TAUNT_INSTR = '对手刚走了一步棋，走法与引擎评估见后。请结合你自己的判断，按你的人设风格作出反应：可以犀利点评、调侃，也可以嘴硬不认，用一两句口语，不要脏话、不要人身攻击、不要书面分析。';

console.log(`【场景】玩家（红）走「${not}」——吃马，但黑车可沿列反吃红车`);
console.log(`  旧判定：静态分差 ${swing > 0 ? '+' : ''}${swing} ≥ 150 → 判「好棋」，好感度 +3，提示词写死"这是一步好棋"→ 必被夸`);
console.log(`  新判定：复核 loss = ${r.loss} ≤ -350 → 判「${verdict.kind}」，好感度 ${verdict.delta}，提示词只给事实\n`);
console.log('════ 修复后 · 实际发出的 system 提示词（臭棋分支）════');
console.log(head + '\n' + TAUNT_INSTR + `\n（参考：对手刚走了 ${not}；${lossTxt}，引擎更推荐 ${better}。）`);
console.log(`\n（若是好棋分支，末两行则为）\n${GOOD_INSTR}\n（参考：对手刚走了 ${not}；${lossTxt}，局势分变化 ${swing >= 0 ? '+' : ''}${swing}。）`);
console.log(`\n调用参数：streamReply(system, '', { temperature: ${verdict.kind === 'good' ? 0.9 : 1.1}, maxTokens: 200 })`);
