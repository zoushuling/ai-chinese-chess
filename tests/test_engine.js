/* 引擎单元测试（Node）：node tests/test_engine.js */
'use strict';
require('../js/engine.js');
require('../js/ai.js');
const Eng = globalThis.ChessEngine;
const AI = globalThis.ChessAI;
const RED = Eng.RED, BLACK = Eng.BLACK;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

console.log('== 开局解析与走法生成 ==');
const start = Eng.parseFEN(Eng.START_FEN).board;
check('开局红方合法走法 = 44', Eng.legalMoves(start, RED).length === 44, Eng.legalMoves(start, RED).length);
check('开局黑方合法走法 = 44', Eng.legalMoves(start, BLACK).length === 44, Eng.legalMoves(start, BLACK).length);
check('FEN 往返一致', Eng.toFEN(start, RED) === 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1');

console.log('== 中文记谱 ==');
// 红炮在 (7,1) 与 (7,7)：炮二平五 = (7,7)→(7,4)；马二进三 = (9,7)→(7,6)；兵三进一 = (6,6)→(5,6)
check('炮二平五', Eng.notation(start, { fr: 7, fc: 7, tr: 7, tc: 4 }) === '炮二平五');
check('马二进三', Eng.notation(start, { fr: 9, fc: 7, tr: 7, tc: 6 }) === '马二进三');
check('兵三进一', Eng.notation(start, { fr: 6, fc: 6, tr: 5, tc: 6 }) === '兵三进一');
// 黑炮在 (2,1) 与 (2,7)：炮2平5 = (2,1)→(2,4)；黑马2进3 = (0,1)→(2,2)
check('黑炮2平5', Eng.notation(start, { fr: 2, fc: 1, tr: 2, tc: 4 }) === '炮2平5');
check('黑马2进3', Eng.notation(start, { fr: 0, fc: 1, tr: 2, tc: 2 }) === '马2进3');
// 吃子标记：先走炮二平五，再炮五进四吃黑卒（(7,4)→(3,4)，以 (6,4) 红兵作炮架，真实合法吃子）
const bCap = Eng.makeMove(start, { fr: 7, fc: 7, tr: 7, tc: 4 });
check('吃子标记（炮五进四吃卒）', Eng.notation(bCap, { fr: 7, fc: 4, tr: 3, tc: 4, captured: 'P' }) === '炮五进四吃');

console.log('== 坐标转换 ==');
check('moveToCoord h7e7（炮二平五）', Eng.moveToCoord({ fr: 7, fc: 7, tr: 7, tc: 4 }) === 'h7e7');
const cm = Eng.coordToMove(start, 'h7e7');
check('coordToMove h7e7', !!cm && cm.fr === 7 && cm.fc === 7 && cm.tr === 7 && cm.tc === 4);
check('coordToMove 非法坐标 → null', Eng.coordToMove(start, 'zz99') === null);

console.log('== 构造局面测试将军/将死/困毙 ==');
// 将死：红帅 (9,4) 被黑车 (4,4) 将军；(9,3) 被黑车 (7,3) 控制、(9,5) 被黑车 (7,5) 控制、
// (8,4) 为车炮线之间唯一挡位（被黑车 (4,4) 攻击）；黑将 (0,3) 不同列无飞将
const b2 = Eng.emptyBoard();
b2[9][4] = { type: 'K', color: RED };
b2[0][3] = { type: 'K', color: BLACK };
b2[4][4] = { type: 'R', color: BLACK };
b2[7][3] = { type: 'R', color: BLACK };
b2[7][5] = { type: 'R', color: BLACK };
check('黑车将军红帅', Eng.isAttacked(b2, 9, 4, BLACK));
check('红方无合法走法（将死）', Eng.legalMoves(b2, RED).length === 0, Eng.legalMoves(b2, RED).length);
check('终局状态 = checkmate', Eng.gameStatus(b2, RED).status === 'checkmate');

// 困毙：红帅 (9,4)，(9,3) 被黑车 (7,3) 控制，(9,5) 被黑车 (7,5) 控制，
// (8,4) 被黑马 (9,6) 控制（马腿 (9,5) 为空），且红帅未被将军 → 无子可动判负
const b3 = Eng.emptyBoard();
b3[9][4] = { type: 'K', color: RED };
b3[0][3] = { type: 'K', color: BLACK };
b3[7][3] = { type: 'R', color: BLACK };
b3[7][5] = { type: 'R', color: BLACK };
b3[9][6] = { type: 'N', color: BLACK };
check('困毙局面红帅未被将军', !Eng.isAttacked(b3, 9, 4, BLACK));
check('红方无合法走法（困毙）', Eng.legalMoves(b3, RED).length === 0, Eng.legalMoves(b3, RED).length);
check('终局状态 = stalemate', Eng.gameStatus(b3, RED).status === 'stalemate');

console.log('== 蹩马腿/象眼 ==');
check('开局红马能跳（不蹩腿）', Eng.targetsFrom(start, 9, 7, start[9][7]).length === 2, Eng.targetsFrom(start, 9, 7, start[9][7]).length);
const b5 = Eng.emptyBoard();
b5[9][4] = { type: 'K', color: RED };
b5[0][4] = { type: 'K', color: BLACK };
b5[4][4] = { type: 'N', color: RED };
b5[3][4] = { type: 'R', color: RED }; // 塞住正上方马腿
const nTargets = Eng.targetsFrom(b5, 4, 4, b5[4][4]);
check('蹩马腿后不能向上跳', !nTargets.some(([r, c]) => r === 2 && (c === 3 || c === 5)));
check('蹩马腿后仍可横跳', nTargets.some(([r, c]) => (r === 3 && c === 2) || (r === 5 && c === 2) || (r === 6 && c === 3) || (r === 6 && c === 5)));
// 象眼：黑象 (0,2)，在 (1,3) 放子挡住 → 不能跳到 (2,4)
const b10 = Eng.emptyBoard();
b10[9][4] = { type: 'K', color: RED };
b10[0][4] = { type: 'K', color: BLACK };
b10[0][2] = { type: 'B', color: BLACK };
b10[1][3] = { type: 'R', color: BLACK };
const bTargets = Eng.targetsFrom(b10, 0, 2, b10[0][2]);
check('象眼被堵不能飞', !bTargets.some(([r, c]) => r === 2 && c === 4));

console.log('== 搜索 ==');
const sr = AI.search(start, RED, { depth: 2, topN: 5, timeLimit: 2000 });
check('搜索返回候选', sr.candidates && sr.candidates.length >= 1, JSON.stringify(sr && sr.candidates));
check('候选走法合法', sr.candidates.every(c => Eng.legalMoves(start, RED).some(m => m.fr === c.move.fr && m.fc === c.move.fc && m.tr === c.move.tr && m.tc === c.move.tc)));
check('候选按分数降序', sr.candidates.every((c, i, a) => i === 0 || a[i - 1].score >= c.score));
check('候选含记谱与坐标', sr.candidates.every(c => !!c.notation && /^[a-i][0-9][a-i][0-9]$/.test(c.coord)), JSON.stringify(sr.candidates && sr.candidates[0]));

console.log('== 评估 ==');
const ev = Eng.evalSummary(start);
check('开局评估大致均势', Math.abs(ev.score) < 50, ev.score);
const b6 = Eng.emptyBoard();
b6[9][4] = { type: 'K', color: RED }; b6[0][4] = { type: 'K', color: BLACK };
b6[8][3] = { type: 'A', color: RED }; b6[8][5] = { type: 'A', color: RED };
b6[1][3] = { type: 'A', color: BLACK }; b6[1][5] = { type: 'A', color: BLACK };
b6[7][0] = { type: 'R', color: RED }; b6[7][8] = { type: 'R', color: RED };
b6[2][0] = { type: 'R', color: BLACK };
check('多一车红方占优', Eng.evaluate(b6) > 500, Eng.evaluate(b6));

// 炮位置表对称性回归：黑炮镜像后不应被鼓励待在己方半场（曾因未镜像导致 AI 执黑时"恋家"）
const bC1 = Eng.emptyBoard();
bC1[9][4] = { type: 'K', color: RED }; bC1[0][4] = { type: 'K', color: BLACK };
bC1[7][4] = { type: 'C', color: RED };
const eRedHome = Eng.evaluate(bC1);
bC1[7][4] = null; bC1[2][4] = { type: 'C', color: RED };
const eRedDeep = Eng.evaluate(bC1);
check('红炮深入敌阵评估更高', eRedDeep > eRedHome, eRedDeep + ' vs ' + eRedHome);
const bC2 = Eng.emptyBoard();
bC2[9][4] = { type: 'K', color: RED }; bC2[0][4] = { type: 'K', color: BLACK };
bC2[2][4] = { type: 'C', color: BLACK };
const eBlackHome = Eng.evaluate(bC2);
bC2[2][4] = null; bC2[7][4] = { type: 'C', color: BLACK };
const eBlackDeep = Eng.evaluate(bC2);
// 黑方评估为负值：黑炮"深入敌阵更强"意味着红方视角总分更低（eBlackDeep < eBlackHome）
check('黑炮深入敌阵评估更高（镜像）', eBlackDeep < eBlackHome, eBlackDeep + ' vs ' + eBlackHome);

console.log('== 记谱：同列双车 前/后 ==');
const b7 = Eng.emptyBoard();
b7[9][4] = { type: 'K', color: RED }; b7[0][3] = { type: 'K', color: BLACK };
b7[7][0] = { type: 'R', color: RED }; b7[4][0] = { type: 'R', color: RED };
check('前车进一', Eng.notation(b7, { fr: 4, fc: 0, tr: 3, tc: 0 }) === '前车进一');
check('后车进一', Eng.notation(b7, { fr: 7, fc: 0, tr: 6, tc: 0 }) === '后车进一');
const b8 = Eng.emptyBoard();
b8[9][4] = { type: 'K', color: RED }; b8[0][3] = { type: 'K', color: BLACK };
b8[2][8] = { type: 'R', color: BLACK }; b8[5][8] = { type: 'R', color: BLACK };
check('黑前车进1（row5 为前）', Eng.notation(b8, { fr: 5, fc: 8, tr: 6, tc: 8 }) === '前车进1');
check('黑后车退1（row2 为后，向上退）', Eng.notation(b8, { fr: 2, fc: 8, tr: 1, tc: 8 }) === '后车退1');

console.log('== 兵过河 ==');
const b9a = Eng.makeMove(start, { fr: 6, fc: 6, tr: 5, tc: 6 });
check('未过河兵不能横走', !Eng.targetsFrom(b9a, 5, 6, b9a[5][6]).some(([r, c]) => c === 5 || c === 7));
const b9b = Eng.makeMove(b9a, { fr: 5, fc: 6, tr: 4, tc: 6 });
check('过河兵可横走', Eng.targetsFrom(b9b, 4, 6, b9b[4][6]).some(([r, c]) => c === 5 || c === 7));
check('过河兵可前进', Eng.targetsFrom(b9b, 4, 6, b9b[4][6]).some(([r, c]) => r === 3));
check('过河兵不能后退', !Eng.targetsFrom(b9b, 4, 6, b9b[4][6]).some(([r, c]) => r === 5));

console.log('== 飞将吃（帅面对面可直接吃） ==');
const b11 = Eng.emptyBoard();
b11[9][4] = { type: 'K', color: RED };
b11[0][4] = { type: 'K', color: BLACK };
b11[9][3] = { type: 'A', color: RED }; b11[9][5] = { type: 'A', color: RED };
b11[0][3] = { type: 'A', color: BLACK }; b11[0][5] = { type: 'A', color: BLACK };
const fly = Eng.legalMoves(b11, RED).some(m => m.tr === 0 && m.tc === 4);
check('红帅可飞将吃黑将', fly, JSON.stringify(Eng.legalMoves(b11, RED).slice(0, 3)));
const flyMove = Eng.legalMoves(b11, RED).find(m => m.tr === 0 && m.tc === 4);
check('飞将吃将后黑方视为将死', !!flyMove && Eng.gameStatus(Eng.makeMove(b11, flyMove), BLACK).status === 'checkmate',
  flyMove && Eng.gameStatus(Eng.makeMove(b11, flyMove), BLACK).status);
// 送将过滤：红帅走一步到 (8,4) 后与黑将面对面 → 非法
// （注意：仕可以垫到 (8,4) 挡住飞将线，这是合法着法，故仅检查帅本身）
check('帅不能走到与对方将面对面', !Eng.legalMoves(b11, RED).some(m => m.piece === 'K' && m.tr === 8 && m.tc === 4));

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
