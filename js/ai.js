/* ============================================================
 * ai.js — 本地搜索引擎：negamax alpha-beta + 迭代加深
 * 用途：生成候选走法交给 LLM 挑选、玩家提示、纯引擎降级下棋
 * ============================================================ */
(function (global) {
  'use strict';
  const Eng = global.ChessEngine;
  const RED = Eng.RED, BLACK = Eng.BLACK;

  /** MVV-LVA 走法排序分（吃子优先，吃的子越贵越靠前） */
  function moveOrderScore(m) {
    if (!m.captured) return 0;
    return 1000 + (Eng.PIECE_VALUE[m.captured] || 0) - (Eng.PIECE_VALUE[m.piece] || 0) / 10;
  }

  /** 静态搜索：只看吃子，避免水平线效应 */
  function quiesce(board, turn, alpha, beta, deadline, qDepth) {
    const stand = turn === RED ? Eng.evaluate(board) : -Eng.evaluate(board);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qDepth <= 0 || Date.now() > deadline) return alpha;
    const moves = Eng.legalMoves(board, turn).filter(m => m.captured);
    moves.sort((a, b) => moveOrderScore(b) - moveOrderScore(a));
    for (const m of moves) {
      if (Date.now() > deadline) break;
      const nb = Eng.makeMove(board, m);
      const s = -quiesce(nb, turn === RED ? BLACK : RED, -beta, -alpha, deadline, qDepth - 1);
      if (s >= beta) return beta;
      if (s > alpha) alpha = s;
    }
    return alpha;
  }

  function negamax(board, turn, depth, alpha, beta, deadline, qDepth) {
    if (Date.now() > deadline) return 0;
    const moves = Eng.legalMoves(board, turn);
    if (moves.length === 0) return -999999; // 将死/困毙 → 走棋方负
    if (depth <= 0) return quiesce(board, turn, alpha, beta, deadline, qDepth);

    moves.sort((a, b) => moveOrderScore(b) - moveOrderScore(a));
    let best = -Infinity;
    for (const m of moves) {
      if (Date.now() > deadline) break;
      const nb = Eng.makeMove(board, m);
      const s = -negamax(nb, turn === RED ? BLACK : RED, depth - 1, -beta, -alpha, deadline, qDepth);
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best === -Infinity ? 0 : best;
  }

  /**
   * 搜索主入口
   * @param {Array} board 棋盘
   * @param {string} turn 当前走棋方
   * @param {Object} opts { depth, timeLimit, topN }
   * @returns {{move, score, candidates:[{move,score,notation,coord}]}}
   */
  function search(board, turn, opts) {
    opts = opts || {};
    const maxDepth = Math.max(1, Math.min(6, opts.depth || 3));
    const timeLimit = opts.timeLimit || 1200;
    const topN = opts.topN || 5;
    const qDepth = opts.qDepth != null ? opts.qDepth : 4;
    const deadline = Date.now() + timeLimit;

    const rootMoves = Eng.legalMoves(board, turn);
    if (rootMoves.length === 0) return { move: null, score: 0, candidates: [] };

    let lastScores = null;
    let prevScores = null;
    for (let d = 1; d <= maxDepth; d++) {
      // 上一层的排序作为本层走法顺序
      const seq = lastScores
        ? lastScores.slice().sort((a, b) => b.score - a.score).map(x => x.move)
        : rootMoves.slice().sort((a, b) => moveOrderScore(b) - moveOrderScore(a));
      const scored = seq.map(m => ({ move: m, score: -Infinity }));
      let alpha = -Infinity, beta = Infinity;
      for (const m of seq) {
        if (Date.now() > deadline) break;
        const nb = Eng.makeMove(board, m);
        const s = -negamax(nb, turn === RED ? BLACK : RED, d - 1, -beta, -alpha, deadline, qDepth);
        const entry = scored.find(x => x.move === m);
        if (entry) entry.score = s;
        if (s > alpha) alpha = s;
      }
      prevScores = lastScores; // 保留上一层完整结果，用于本层超时未重评的走法
      lastScores = scored;
      if (Date.now() > deadline) break;
    }

    // 超时打断的走法会停留在 -Infinity：优先用当前层已算出的分数；
    // 未重评的走法回退到上一层的分数；极端情况下（第一层全部超时）按走法排序取前几个。
    const prevMap = new Map();
    if (prevScores) for (const e of prevScores) prevMap.set(e.move, e.score);
    const valid = [];
    for (const e of lastScores) {
      if (Number.isFinite(e.score)) valid.push(e);
      else if (prevMap.has(e.move) && Number.isFinite(prevMap.get(e.move))) {
        valid.push({ move: e.move, score: prevMap.get(e.move) });
      }
    }
    if (!valid.length) {
      rootMoves.slice(0, Math.max(1, topN)).forEach(m => valid.push({ move: m, score: 0 }));
    }
    valid.sort((a, b) => b.score - a.score);
    const candidates = valid.slice(0, Math.max(1, topN)).map(e => ({
      move: e.move,
      score: e.score,
      notation: Eng.notation(board, e.move),
      coord: Eng.moveToCoord(e.move),
    }));
    return { move: candidates[0] ? candidates[0].move : null, score: candidates[0] ? candidates[0].score : 0, candidates };
  }

  /** 快速评估（供状态栏/聊天注入） */
  function evaluateFen(board) { return Eng.evalSummary(board); }

  global.ChessAI = { search, evaluateFen };
})(typeof window !== 'undefined' ? window : globalThis);
