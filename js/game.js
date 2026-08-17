/* ============================================================
 * game.js — 对局状态机：走子、悔棋、终局、棋谱
 * 事件回调：Game.onEvent(type, payload)
 *   'state'  — 对局状态整体变化（新局/重开/悔棋）
 *   'move'   — 走了一步 { move, notation, turn, over, check }
 * ============================================================ */
(function (global) {
  'use strict';
  const Eng = global.ChessEngine;
  const RED = Eng.RED, BLACK = Eng.BLACK;

  const Game = {
    state: null,
    onEvent: null,
  };

  // 同一局面（同方走子）重复出现 3 次即视为长将循环
  const LONG_CHECK_REPEAT = 3;

  /** 判断把 matched 应用到当前局面后，是否构成“长将”（重复将军局面） */
  function givesRepeatedCheck(st, matched) {
    const nb = Eng.makeMove(st.board, matched);
    const nextTurn = st.turn === RED ? BLACK : RED;
    // 只约束将军：下一步轮到的一方必须正被将军
    const king = Eng.findKing(nb, nextTurn);
    if (!king || !Eng.isAttacked(nb, king.r, king.c, st.turn)) return false;
    const fenAfter = Eng.toFEN(nb, nextTurn);
    let seen = 0;
    for (const h of st.history) {
      if (h.preFen === fenAfter) {
        seen++;
        if (seen >= LONG_CHECK_REPEAT - 1) return true; // 这步将造成第 3 次重复
      }
    }
    return false;
  }

  function emit(type, payload) {
    if (Game.onEvent) Game.onEvent(type, payload);
  }

  /** 从 FEN 快照恢复局面 */
  function restoreFrom(fen) {
    const parsed = Eng.parseFEN(fen);
    Game.state.board = parsed.board;
    Game.state.turn = parsed.turn;
    Game.state.over = null;
    Game.state.moveCount = Game.state.history.length;
  }

  /** 新开一局。settings: { maxUndo } */
  Game.newGame = function (settings) {
    Game.state = {
      settings: settings || {},
      board: Eng.parseFEN(Eng.START_FEN).board,
      turn: RED,
      history: [],           // [{ preFen, move, notation, check }]
      over: null,            // null | { winner, reason }
      undoUsed: 0,
      moveCount: 0,
    };
    emit('state', Game.state);
  };

  /** 应用一步走法（校验合法性），返回是否成功 */
  Game.applyMove = function (move) {
    const st = Game.state;
    if (!st || st.over) return false;
    const legal = Eng.legalMoves(st.board, st.turn);
    const matched = legal.find(m => m.fr === move.fr && m.fc === move.fc && m.tr === move.tr && m.tc === move.tc);
    if (!matched) return false;
    if (givesRepeatedCheck(st, matched)) return false; // 禁止长将

    const notation = Eng.notation(st.board, matched);
    st.history.push({
      preFen: Eng.toFEN(st.board, st.turn),
      // 用引擎生成的走法对象，保证 piece/color/captured 字段完整
      move: { fr: matched.fr, fc: matched.fc, tr: matched.tr, tc: matched.tc, piece: matched.piece, color: matched.color, captured: matched.captured },
      notation,
      check: notation.endsWith('+'),
    });
    st.board = Eng.makeMove(st.board, matched);
    st.moveCount++;
    st.turn = st.turn === RED ? BLACK : RED;

    // 终局判定
    const gs = Eng.gameStatus(st.board, st.turn);
    if (gs.status !== 'playing') {
      const loser = st.turn;
      st.over = { winner: loser === RED ? BLACK : RED, reason: gs.status === 'checkmate' ? '将死' : '困毙' };
    }
    emit('move', { move: matched, notation, turn: st.turn, over: st.over, check: notation.endsWith('+') });
    return true;
  };

  /** 认输 */
  Game.resign = function (color) {
    const st = Game.state;
    if (!st || st.over) return;
    st.over = { winner: color === RED ? BLACK : RED, reason: '认输' };
    emit('move', { move: null, notation: '', turn: st.turn, over: st.over, resign: true });
  };

  /** 悔棋：回退 steps 步（限次数） */
  Game.undo = function (steps) {
    const st = Game.state;
    if (!st || st.over || st.history.length === 0) return false;
    const maxUndo = st.settings.maxUndo || 0;
    if (st.undoUsed >= maxUndo) return false;
    const n = Math.max(1, Math.min(steps || 1, st.history.length));
    const removed = st.history.splice(st.history.length - n, n);
    // 回退到“最早被移除的那一步”之前，保证棋盘与剩余棋谱一致
    const targetFen = removed[0].preFen;
    restoreFrom(targetFen);
    st.undoUsed += 1; // 一次悔棋操作算一次（无论回退几步）
    emit('state', Game.state);
    return true;
  };

  Game.canUndo = function () {
    const st = Game.state;
    if (!st || st.over) return false;
    const maxUndo = st.settings.maxUndo || 0;
    return st.undoUsed < maxUndo && st.history.length > 0;
  };

  /** 判断某步走法是否构成长将（供主程序/提示/搜索候选过滤使用） */
  Game.wouldRepeatCheck = function (move) {
    const st = Game.state;
    if (!st || st.over || !move) return false;
    const legal = Eng.legalMoves(st.board, st.turn);
    const matched = legal.find(m => m.fr === move.fr && m.fc === move.fc && m.tr === move.tr && m.tc === move.tc);
    if (!matched) return false;
    return givesRepeatedCheck(st, matched);
  };

  /** 已确认是合法走法时可直接调用，避免重复生成合法走法（供批量过滤使用） */
  Game.wouldRepeatCheckMatched = function (matched) {
    const st = Game.state;
    if (!st || st.over || !matched) return false;
    return givesRepeatedCheck(st, matched);
  };

  /** 导出棋谱文本（中文记谱 + FEN 序列） */
  Game.exportPGN = function () {
    const st = Game.state;
    const lines = ['[对局记录] AI 对话象棋'];
    const moves = [];
    for (let i = 0; i < st.history.length; i++) {
      const h = st.history[i];
      const n = Math.floor(i / 2) + 1;
      const side = i % 2 === 0 ? '红' : '黑';
      moves.push(n + '. ' + side + ' ' + h.notation);
    }
    lines.push(moves.join('  ') || '（尚无走法）');
    if (st.over) lines.push('结果：' + (st.over.winner === RED ? '红方' : '黑方') + '胜（' + st.over.reason + '）');
    lines.push('');
    lines.push('FEN 序列：');
    st.history.forEach((h, i) => {
      const nextFen = i + 1 < st.history.length ? st.history[i + 1].preFen : Eng.toFEN(st.board, st.turn);
      lines.push((i + 1) + '. ' + nextFen);
    });
    lines.push('终局 FEN：' + Eng.toFEN(st.board, st.turn));
    return lines.join('\n');
  };

  global.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);
