/* ============================================================
 * engine.js — 中国象棋规则引擎（零依赖，纯逻辑）
 * 棋盘坐标：row 0~9（上→下），col 0~8（左→右）
 *   红方在下（row 7~9 为九宫），黑方在上（row 0~2 为九宫）
 * 棋子编码：{ type: 'K'|'A'|'B'|'N'|'R'|'C'|'P', color: 'r'|'b' }
 *   K帅/将 A仕/士 B相/象 N马 R车 C炮 P兵/卒
 * ============================================================ */
(function (global) {
  'use strict';

  const ROWS = 10, COLS = 9;
  const RED = 'r', BLACK = 'b';
  const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

  // FEN 字符 → 棋子
  const FEN_MAP = {
    K: { t: 'K', c: RED }, A: { t: 'A', c: RED }, B: { t: 'B', c: RED },
    N: { t: 'N', c: RED }, R: { t: 'R', c: RED }, C: { t: 'C', c: RED }, P: { t: 'P', c: RED },
    k: { t: 'K', c: BLACK }, a: { t: 'A', c: BLACK }, b: { t: 'B', c: BLACK },
    n: { t: 'N', c: BLACK }, r: { t: 'R', c: BLACK }, c: { t: 'C', c: BLACK }, p: { t: 'P', c: BLACK },
  };

  // 棋子显示名：[0]=红 [1]=黑
  const PIECE_NAME = { K: ['帅', '将'], A: ['仕', '士'], B: ['相', '象'], N: ['马', '马'], R: ['车', '车'], C: ['炮', '炮'], P: ['兵', '卒'] };
  const PIECE_FEN = { K: 'K', A: 'A', B: 'B', N: 'N', R: 'R', C: 'C', P: 'P' };

  // 子力价值
  const PIECE_VALUE = { K: 100000, A: 200, B: 200, N: 400, C: 450, R: 900, P: 100 };

  // —— 位置价值表（红方视角）——
  // M_TABLE 上下对称，无需镜像；C_TABLE 黑方按 9-r 镜像（否则黑炮会被鼓励待在己方半场）；
  // P_TABLE 双色按同一绝对行查表（保持过河兵在河界两侧的连续分布），crossedRiver 已按颜色区分过河
  const M_TABLE = [
    [-8, -6, -4, -4, -4, -4, -4, -6, -8],
    [-6, -4, 0, 0, 0, 0, 0, -4, -6],
    [-4, 0, 2, 4, 4, 4, 2, 0, -4],
    [-4, 0, 4, 6, 6, 6, 4, 0, -4],
    [-4, 0, 4, 6, 8, 6, 4, 0, -4],
    [-4, 0, 4, 6, 8, 6, 4, 0, -4],
    [-4, 0, 4, 6, 6, 6, 4, 0, -4],
    [-4, 0, 2, 4, 4, 4, 2, 0, -4],
    [-6, -4, 0, 0, 0, 0, 0, -4, -6],
    [-8, -6, -4, -4, -4, -4, -4, -6, -8],
  ];
  const C_TABLE = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 2, 4, 4, 4, 4, 4, 2, 0],
    [0, 4, 6, 6, 8, 6, 6, 4, 0],
    [0, 4, 6, 8, 10, 8, 6, 4, 0],
    [0, 4, 6, 8, 10, 8, 6, 4, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  const P_TABLE = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [6, 8, 10, 16, 20, 16, 10, 8, 6],
    [4, 6, 8, 12, 16, 12, 8, 6, 4],
    [2, 4, 6, 10, 12, 10, 6, 4, 2],
    [0, 2, 2, 4, 6, 4, 2, 2, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  const K_TABLE_RED = (() => {
    const t = [];
    for (let r = 0; r < 10; r++) t.push(new Array(9).fill(0));
    t[7] = [0, 0, 0, 6, 8, 6, 0, 0, 0];
    t[8] = [0, 0, 0, 10, 12, 10, 0, 0, 0];
    t[9] = [0, 0, 0, 6, 8, 6, 0, 0, 0];
    return t;
  })();

  // —— 基础工具 ——
  function emptyBoard() {
    const b = [];
    for (let r = 0; r < ROWS; r++) b.push(new Array(COLS).fill(null));
    return b;
  }
  function cloneBoard(b) { return b.map(row => row.slice()); }
  function inBoard(r, c) { return r >= 0 && r < 10 && c >= 0 && c < 9; }
  function inPalace(r, c, color) { return c >= 3 && c <= 5 && (color === RED ? r >= 7 : r <= 2); }
  function crossedRiver(r, color) { return color === RED ? r <= 4 : r >= 5; }

  // —— FEN ——
  function parseFEN(fen) {
    const parts = fen.trim().split(/\s+/);
    const ranks = parts[0].split('/');
    const board = emptyBoard();
    for (let r = 0; r < 10; r++) {
      let c = 0;
      for (const ch of ranks[r]) {
        if (/\d/.test(ch)) { c += parseInt(ch, 10); }
        else { const info = FEN_MAP[ch]; board[r][c] = { type: info.t, color: info.c }; c++; }
      }
    }
    return { board, turn: parts[1] === 'b' ? BLACK : RED };
  }
  function toFEN(board, turn) {
    const ranks = [];
    for (let r = 0; r < 10; r++) {
      let s = '', empty = 0;
      for (let c = 0; c < 9; c++) {
        const p = board[r][c];
        if (!p) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        s += p.color === RED ? PIECE_FEN[p.type] : PIECE_FEN[p.type].toLowerCase();
      }
      if (empty) s += empty;
      ranks.push(s);
    }
    return ranks.join('/') + ' ' + (turn === RED ? 'w' : 'b') + ' - - 0 1';
  }
  function findKing(board, color) {
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (p && p.type === 'K' && p.color === color) return { r, c };
    }
    return null;
  }

  // —— 攻击判定：位于 (fr,fc) 的棋子 p 能否攻击到 (tr,tc)（含吃子/将军）——
  function attacks(board, fr, fc, tr, tc) {
    const p = board[fr][fc];
    if (!p) return false;
    const t = p.type;
    const adr = Math.abs(tr - fr), adc = Math.abs(tc - fc);
    switch (t) {
      case 'K': {
        if (fr === tr && fc === tc) return false; // 自身坐标：避免飞将循环无限下探
        if (adr + adc === 1 && inPalace(tr, tc, p.color)) return true;
        // 飞将（帅/将同列直对且中间无子）
        if (fc === tc) {
          const step = tr > fr ? 1 : -1;
          let rr = fr + step;
          while (rr !== tr) { if (board[rr][fc]) return false; rr += step; }
          const target = board[tr][tc];
          return !!(target && target.type === 'K' && target.color !== p.color);
        }
        return false;
      }
      case 'A':
        return adr === 1 && adc === 1 && inPalace(tr, tc, p.color);
      case 'B': {
        if (adr !== 2 || adc !== 2) return false;
        if (board[fr + Math.sign(tr - fr)][fc + Math.sign(tc - fc)]) return false; // 象眼
        if (p.color === RED ? tr < 5 : tr > 4) return false; // 不可过河
        return true;
      }
      case 'N': {
        if (!((adr === 2 && adc === 1) || (adr === 1 && adc === 2))) return false;
        if (adr === 2) return !board[fr + Math.sign(tr - fr)][fc]; // 蹩马腿
        return !board[fr][fc + Math.sign(tc - fc)];
      }
      case 'R': {
        if (fr !== tr && fc !== tc) return false;
        if (fr === tr) {
          const s = Math.sign(tc - fc);
          for (let c = fc + s; c !== tc; c += s) if (board[fr][c]) return false;
        } else {
          const s = Math.sign(tr - fr);
          for (let r = fr + s; r !== tr; r += s) if (board[r][fc]) return false;
        }
        return true;
      }
      case 'C': {
        if (fr !== tr && fc !== tc) return false;
        let cnt = 0;
        if (fr === tr) {
          const s = Math.sign(tc - fc);
          for (let c = fc + s; c !== tc; c += s) if (board[fr][c]) cnt++;
        } else {
          const s = Math.sign(tr - fr);
          for (let r = fr + s; r !== tr; r += s) if (board[r][fc]) cnt++;
        }
        return cnt === 1; // 炮须隔一子（炮架）才能吃/将军
      }
      case 'P': {
        if (adr + adc !== 1) return false;
        if (p.color === RED ? tr > fr : tr < fr) return false; // 不可后退
        if (adc === 1 && !crossedRiver(fr, p.color)) return false; // 横向须过河
        return true;
      }
      default: return false;
    }
  }

  function isAttacked(board, r, c, byColor) {
    for (let rr = 0; rr < 10; rr++) for (let cc = 0; cc < 9; cc++) {
      const p = board[rr][cc];
      if (p && p.color === byColor && attacks(board, rr, cc, r, c)) return true;
    }
    return false;
  }

  // —— 走法生成 ——
  function targetsFrom(board, r, c, p) {
    const out = [];
    const t = p.type, color = p.color;
    const push = (tr, tc) => { if (inBoard(tr, tc)) out.push([tr, tc]); };
    switch (t) {
      case 'K': {
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const tr = r + dr, tc = c + dc;
          if (inBoard(tr, tc) && inPalace(tr, tc, color)) push(tr, tc);
        }
        for (const dir of [-1, 1]) { // 飞将吃
          let rr = r + dir;
          while (rr >= 0 && rr < 10) {
            const q = board[rr][c];
            if (q) { if (q.type === 'K' && q.color !== color) push(rr, c); break; }
            rr += dir;
          }
        }
        break;
      }
      case 'A': {
        for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          const tr = r + dr, tc = c + dc;
          if (inBoard(tr, tc) && inPalace(tr, tc, color)) push(tr, tc);
        }
        break;
      }
      case 'B': {
        for (const [dr, dc] of [[-2, -2], [-2, 2], [2, -2], [2, 2]]) {
          const tr = r + dr, tc = c + dc;
          if (!inBoard(tr, tc)) continue;
          if (board[r + dr / 2][c + dc / 2]) continue; // 象眼
          if (color === RED ? tr >= 5 : tr <= 4) push(tr, tc);
        }
        break;
      }
      case 'N': {
        for (const [dr, dc] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
          const tr = r + dr, tc = c + dc;
          if (!inBoard(tr, tc)) continue;
          const lr = Math.abs(dr) === 2 ? r + dr / 2 : r;
          const lc = Math.abs(dr) === 2 ? c : c + dc / 2;
          if (!board[lr][lc]) push(tr, tc);
        }
        break;
      }
      case 'R': {
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          let tr = r + dr, tc = c + dc;
          while (inBoard(tr, tc)) {
            const q = board[tr][tc];
            if (!q) push(tr, tc);
            else { push(tr, tc); break; }
            tr += dr; tc += dc;
          }
        }
        break;
      }
      case 'C': {
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          let tr = r + dr, tc = c + dc, jumped = false;
          while (inBoard(tr, tc)) {
            const q = board[tr][tc];
            if (!jumped) {
              if (!q) push(tr, tc); else jumped = true;
            } else {
              if (q) { push(tr, tc); break; }
            }
            tr += dr; tc += dc;
          }
        }
        break;
      }
      case 'P': {
        const fwd = color === RED ? -1 : 1;
        push(r + fwd, c);
        if (crossedRiver(r, color)) { push(r, c - 1); push(r, c + 1); }
        break;
      }
    }
    return out;
  }

  function genMoves(board, color) {
    const moves = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (!p || p.color !== color) continue;
      for (const [tr, tc] of targetsFrom(board, r, c, p)) {
        const tp = board[tr][tc];
        if (tp && tp.color === color) continue; // 不吃己方
        moves.push({ fr: r, fc: c, tr, tc, piece: p.type, color, captured: tp ? tp.type : null });
      }
    }
    return moves;
  }

  function makeMove(board, move) {
    const nb = cloneBoard(board);
    nb[move.tr][move.tc] = nb[move.fr][move.fc];
    nb[move.fr][move.fc] = null;
    return nb;
  }

  /** 合法走法：过滤掉走完后己方被将军（含送将/面对面）的走法 */
  function legalMoves(board, color) {
    const king = findKing(board, color);
    if (!king) return [];
    const all = genMoves(board, color);
    const out = [];
    const opp = color === RED ? BLACK : RED;
    for (const m of all) {
      const nb = makeMove(board, m);
      // 帅/将移动时须检查其新位置是否被将军，其余棋子检查帅原位
      const kr = m.piece === 'K' ? m.tr : king.r;
      const kc = m.piece === 'K' ? m.tc : king.c;
      if (!isAttacked(nb, kr, kc, opp)) out.push(m);
    }
    return out;
  }

  /** 局面状态 */
  function gameStatus(board, turn) {
    const moves = legalMoves(board, turn);
    if (moves.length > 0) return { status: 'playing', moves };
    const king = findKing(board, turn);
    if (!king) return { status: 'checkmate', moves }; // 帅/将已被吃掉（如飞将吃），视同将死
    const inCheck = isAttacked(board, king.r, king.c, turn === RED ? BLACK : RED);
    return { status: inCheck ? 'checkmate' : 'stalemate', moves }; // 象棋中困毙亦判负
  }

  // —— 局面评估（红正黑负）——
  function evaluate(board) {
    let score = 0;
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (!p) continue;
      let v = PIECE_VALUE[p.type];
      switch (p.type) {
        case 'N': v += M_TABLE[r][c]; break;
        case 'C': v += C_TABLE[p.color === RED ? r : 9 - r][c]; break;
        case 'P':
          v += P_TABLE[r][c];
          if (crossedRiver(r, p.color)) v += 40;
          break;
        case 'R':
          if (p.color === RED ? r >= 7 : r <= 2) v += 12;
          if (r === 0 || r === 9) v -= 6;
          break;
        case 'K':
          v += p.color === RED ? K_TABLE_RED[r][c] : K_TABLE_RED[9 - r][c];
          break;
        default: break;
      }
      score += p.color === RED ? v : -v;
    }
    return score;
  }

  /** 评估摘要（供聊天/状态栏） */
  function evalSummary(board) {
    const s = evaluate(board);
    const diff = Math.abs(s);
    let label;
    if (s > 150) label = '红方明显占优';
    else if (s > 30) label = '红方略占优势';
    else if (s < -150) label = '黑方明显占优';
    else if (s < -30) label = '黑方略占优势';
    else label = '局面大致均势';
    return { score: s, label, diff: Math.round(diff) };
  }

  // —— 中文记谱 ——
  const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const CN_STEP = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  function notation(board, m) {
    const p = board[m.fr][m.fc];
    if (!p) return '?';
    const color = p.color;
    const name = PIECE_NAME[p.type][color === RED ? 0 : 1];
    // 同列同型棋子 → 前/中/后
    let same = [];
    for (let r = 0; r < 10; r++) {
      const q = board[r][m.fc];
      if (q && q.type === p.type && q.color === color) same.push(r);
    }
    let prefix;
    let positional = false; // 前/中/后 需放在棋子名之前
    if (same.length >= 2) {
      const sorted = [...same].sort((a, b) => (color === RED ? a - b : b - a));
      const idx = sorted.indexOf(m.fr);
      if (idx === 0) prefix = '前';
      else if (same.length === 2 || idx === same.length - 1) prefix = '后';
      else prefix = '中';
      positional = true;
    } else {
      prefix = color === RED ? CN_NUM[8 - m.fc] : String(m.fc + 1);
    }
    const colStr = (c) => (color === RED ? CN_NUM[8 - c] : String(c + 1));
    const dr = m.tr - m.fr;
    let action;
    if (dr === 0) {
      action = '平' + colStr(m.tc);
    } else {
      const advance = color === RED ? dr < 0 : dr > 0;
      const word = advance ? '进' : '退';
      if (p.type === 'N' || p.type === 'A' || p.type === 'B') {
        action = word + colStr(m.tc);
      } else {
        // 步数：红方用汉字，黑方用阿拉伯数字
        const steps = Math.abs(dr);
        action = word + (color === RED ? CN_STEP[steps] : String(steps));
      }
    }
    // 将军标记
    const nb = makeMove(board, m);
    const opp = color === RED ? BLACK : RED;
    const k = findKing(nb, opp);
    const check = k && isAttacked(nb, k.r, k.c, color);
    let s = (positional ? prefix + name : name + prefix) + action;
    if (m.captured) s += '吃';
    if (check) s += '+';
    return s;
  }

  /** 走法 → 坐标串，如 (row2,col4)→(row2,col5) = "e2f2"（列字母 a-i + 行号 0-9） */
  function moveToCoord(m) {
    return String.fromCharCode(97 + m.fc) + m.fr + String.fromCharCode(97 + m.tc) + m.tr;
  }
  function coordToMove(board, coord) {
    if (!coord || typeof coord !== 'string' || coord.length !== 4) return null;
    const fc = coord.charCodeAt(0) - 97, fr = +coord[1], tc = coord.charCodeAt(2) - 97, tr = +coord[3];
    if (!inBoard(fr, fc) || !inBoard(tr, tc)) return null;
    const p = board[fr][fc];
    if (!p) return null;
    return { fr, fc, tr, tc, piece: p.type, color: p.color, captured: board[tr][tc] ? board[tr][tc].type : null };
  }

  global.ChessEngine = {
    ROWS, COLS, RED, BLACK, START_FEN,
    PIECE_NAME, PIECE_VALUE,
    emptyBoard, cloneBoard, parseFEN, toFEN, findKing,
    targetsFrom, genMoves, legalMoves, makeMove,
    attacks, isAttacked, gameStatus,
    evaluate, evalSummary,
    notation, moveToCoord, coordToMove,
  };
})(typeof window !== 'undefined' ? window : globalThis);
