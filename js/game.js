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
    const targetFen = st.history.length > 0 ? st.history[st.history.length - 1].preFen : Eng.START_FEN;
    restoreFrom(targetFen);
    st.undoUsed += removed.length > 1 ? 1 : 1; // 一次悔棋操作算一次（无论回退几步）
    emit('state', Game.state);
    return true;
  };

  Game.canUndo = function () {
    const st = Game.state;
    if (!st || st.over) return false;
    const maxUndo = st.settings.maxUndo || 0;
    return st.undoUsed < maxUndo && st.history.length > 0;
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
