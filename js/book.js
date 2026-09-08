/* ============================================================
 * book.js — 开局库（内置小编制库，零依赖）
 *
 * 设计：
 *   - LINES 用坐标串记录主流开局线（从初始局面双方交替走子），
 *     同一条目重复出现 = 权重更高（出现频次即权重）。
 *   - 首次查询时用 ChessEngine 把 LINES 逐步展开为
 *     { FEN(局面+走棋方) → [{coord, w}] } 映射：
 *       · FEN 由引擎自己生成，key 绝不会写错；
 *       · 每步走法用 legalMoves 校验，编错的线自动截断（不崩库）。
 *   - 按 FEN 查库：同一局面经不同次序到达也能命中（天然支持次序调换）。
 *
 * 坐标格式：列字母 a=0..i=8 + 行号 0-9（红在下 r7-9，黑在上 r0-2），
 *   与 ChessEngine.moveToCoord 一致，例如 h7e7 = 炮二平五。
 * ============================================================ */
(function (global) {
  'use strict';
  const Eng = global.ChessEngine;

  // —— 开局线编制（主流开局，前 4-8 手）——
  // 重复写 = 权重大。首着分布：中炮 10 / 飞相 2 / 起马 1 / 仙人指路 2。
  const LINES = [
    // 中炮 vs 屏风马（最主流，写两遍加权）
    'h7e7 h0g2 b9c7 b0c2 c6c5 g3g4 h9g7',   // 中炮七兵 vs 屏风马 7 卒
    'h7e7 h0g2 b9c7 b0c2 c6c5 g3g4 h9g7',
    'h7e7 h0g2 b9c7 b0c2 g6g5 c3c4 h9g7',   // 中炮三兵 vs 屏风马 3 卒
    'h7e7 h0g2 h9g7 b0c2 i9h9 i0h0',        // 中炮直车 vs 屏风马
    // 中炮 vs 顺炮
    'h7e7 h2e2 b9c7 h0g2 h9g7 i0h0',        // 顺炮直车
    'h7e7 h2e2 h9g7 b0c2 b9c7 c3c4',        // 顺炮缓开车
    // 中炮 vs 列炮
    'h7e7 b2e2 b9c7 h0g2 h9g7 b0c2',
    // 中炮 vs 反宫马 / 单提马 / 飞象
    'h7e7 b0c2 b9c7 h2f2 h9g7 g3g4',
    'h7e7 b0c2 b9c7 h0i2',
    'h7e7 c0e2 b9c7 h0g2',
    // 飞相局
    'g9e7 h0g2 b9c7 b0c2 h9g7 g3g4',
    'g9e7 b0c2 b9c7 c3c4',
    // 起马局
    'b9c7 c3c4 h9g7 h0g2 g9e7 b0c2',
    // 仙人指路
    'c6c5 b2c2 g9e7 h0g2 h9g7',             // 对卒底炮（炮占 c2，马改走 8 路）
    'c6c5 c3c4 h9g7 h0g2 b9c7 b0c2',        // 对兵局
  ];

  let MAP = null;      // fenKey -> Map(coord -> weight)
  let BUILT_LINES = 0; // 成功展开的线数（< LINES.length 说明有被截断的线）

  /** 局面查询键：FEN 的「棋子布局 + 走棋方」两段 */
  function fenKey(board, turn) {
    return Eng.toFEN(board, turn).split(' ').slice(0, 2).join(' ');
  }

  function buildMap() {
    MAP = {};
    BUILT_LINES = 0;
    for (const line of LINES) {
      const coords = line.trim().split(/\s+/);
      let board = Eng.parseFEN(Eng.START_FEN).board;
      let turn = Eng.RED;
      let ok = true;
      for (const coord of coords) {
        const legal = Eng.legalMoves(board, turn);
        const m = legal.find(x => Eng.moveToCoord(x) === coord);
        if (!m) { ok = false; break; } // 编错的线在此截断，不污染后面的局面
        const key = fenKey(board, turn);
        if (!MAP[key]) MAP[key] = new Map();
        MAP[key].set(coord, (MAP[key].get(coord) || 0) + 1);
        board = Eng.makeMove(board, m);
        turn = turn === Eng.RED ? Eng.BLACK : Eng.RED;
      }
      if (ok) BUILT_LINES++;
    }
  }

  /**
   * 查开局库。
   * @returns {{move, coord, weight, alts}|null} 权重最高的合法库走法；alts 为全部候选（调试用）
   */
  function lookup(board, turn) {
    if (!MAP) buildMap();
    const entry = MAP[fenKey(board, turn)];
    if (!entry) return null;
    const legal = Eng.legalMoves(board, turn);
    const alts = [];
    for (const [coord, w] of entry) {
      const m = legal.find(x => Eng.moveToCoord(x) === coord);
      if (m) alts.push({ move: m, coord, weight: w });
    }
    if (!alts.length) return null;
    alts.sort((a, b) => b.weight - a.weight);
    return { move: alts[0].move, coord: alts[0].coord, weight: alts[0].weight, alts };
  }

  global.ChessBook = {
    lookup,
    /** 库统计（测试/调试用） */
    stats() {
      if (!MAP) buildMap();
      return { positions: Object.keys(MAP).length, lines: LINES.length, builtLines: BUILT_LINES };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
