/* ============================================================
 * ai.js — 本地搜索引擎：negamax + PVS + alpha-beta + 迭代加深
 * 用途：生成候选走法交给 LLM 挑选、玩家提示、纯引擎降级下棋
 *
 * 搜索增强（V0.5.0）：
 *   - Zobrist 64 位哈希 + 置换表（TT）
 *   - PVS 主变搜索 / 杀手启发 / 历史启发
 *   - 空步剪枝 / LMR 延迟削减 / 将军延伸
 *   - 将杀距离评分（越快的杀越优先）
 * ============================================================ */
(function (global) {
  'use strict';
  const Eng = global.ChessEngine;
  const RED = Eng.RED, BLACK = Eng.BLACK;
  const Z_LO = Eng.Z_LO, Z_HI = Eng.Z_HI;
  const ZT_LO = Eng.Z_TURN_LO, ZT_HI = Eng.Z_TURN_HI;
  const zidx = Eng.zobristIdx;
  const moveKey = Eng.moveKey;

  const MATE = 100000;
  const MATE_LOW = MATE - 128;
  const MAX_PLY = 64;
  const TT_MAX = 300000;        // 置换表条目上限，超出整体清空（比 LRU 更省开销）
  const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;

  /* ---------- 置换表 ---------- */
  // key = hash.lo（32 位）；命中后再校验 hi，等价于 64 位，杜绝碰撞错着
  let tt = new Map();
  function ttGet(lo, hi) {
    const e = tt.get(lo);
    return (e && e.hi === hi) ? e : null;
  }
  function ttSet(lo, hi, depth, score, flag, mk) {
    if (tt.size >= TT_MAX) tt.clear();
    tt.set(lo, { hi, depth, score, flag, mk });
  }

  /* ---------- 启发式表 ---------- */
  // 杀手走法：每层 2 个（同层其它分支中造成剪枝的非吃子走法）
  const killers = new Int32Array(MAX_PLY * 2).fill(-1);
  // 历史启发：按 [棋子类型][目标格] 累计造成剪枝的次数
  const HIST = new Int32Array(7 * 90);
  function histIdx(type, r, c) { return Eng.PIECE_INDEX[type] * 90 + r * Eng.COLS + c; }

  // 搜索路径上的哈希栈（避免每个节点分配对象）
  const HASH_LO = new Int32Array(MAX_PLY + 8);
  const HASH_HI = new Int32Array(MAX_PLY + 8);

  let nodes = 0;
  let aborted = false;

  /* ---------- 局面辅助 ---------- */
  function inCheck(board, color) {
    const k = Eng.findKing(board, color);
    if (!k) return true; // 帅已被吃（飞将）视作被将军
    return Eng.isAttacked(board, k.r, k.c, color === RED ? BLACK : RED);
  }
  /** 是否有"大子"（车马炮）：空步剪枝的前置条件，残局只有兵时不能剪 */
  function hasBigPiece(board, color) {
    for (let r = 0; r < Eng.ROWS; r++) for (let c = 0; c < Eng.COLS; c++) {
      const p = board[r][c];
      if (p && p.color === color && (p.type === 'R' || p.type === 'N' || p.type === 'C')) return true;
    }
    return false;
  }
  /** 搜索内循环统一用快速评估（子力+位置），把时间预算留给搜索深度 */
  function evalSide(board, turn) {
    const s = Eng.evaluateFast(board);
    return turn === RED ? s : -s;
  }

  /* ---------- 走法排序 ---------- */
  /**
   * 排序分（从高到低）：
   *   TT 最佳走法 > 吃子（MVV-LVA） > 杀手 1 > 杀手 2 > 历史启发
   */
  function orderMoves(moves, ply, ttMk) {
    const k1 = killers[ply * 2], k2 = killers[ply * 2 + 1];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const mk = moveKey(m);
      let sc;
      if (mk === ttMk) sc = 1e9;
      else if (m.captured) sc = 1e6 + (Eng.PIECE_VALUE[m.captured] || 0) * 16 - (Eng.PIECE_VALUE[m.piece] || 0);
      else if (mk === k1) sc = 9e5;
      else if (mk === k2) sc = 8e5;
      else sc = HIST[histIdx(m.piece, m.tr, m.tc)];
      m._s = sc;
    }
    moves.sort((a, b) => b._s - a._s);
    return moves;
  }

  /* ---------- 静态搜索：只看吃子，避免水平线效应 ---------- */
  function quiesce(board, turn, alpha, beta, ply, deadline, qDepth) {
    nodes++;
    if ((nodes & 2047) === 0 && Date.now() > deadline) { aborted = true; return alpha; }
    const stand = evalSide(board, turn);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qDepth <= 0) return alpha;

    const moves = Eng.legalMoves(board, turn).filter(m => m.captured);
    if (!moves.length) return alpha;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      // delta pruning：吃掉这个子也追不上 alpha，直接跳过
      if (stand + (Eng.PIECE_VALUE[m.captured] || 0) + 200 < alpha) continue;
      m._s = (Eng.PIECE_VALUE[m.captured] || 0) * 16 - (Eng.PIECE_VALUE[m.piece] || 0);
    }
    moves.sort((a, b) => b._s - a._s);

    const opp = turn === RED ? BLACK : RED;
    for (const m of moves) {
      const nb = Eng.makeMove(board, m);
      HASH_LO[ply + 1] = HASH_LO[ply] ^ Z_LO[zidx(m.piece, m.color, m.fr, m.fc)] ^ Z_LO[zidx(m.piece, m.color, m.tr, m.tc)] ^ ZT_LO
        ^ (m.captured ? Z_LO[zidx(m.captured, opp, m.tr, m.tc)] : 0);
      HASH_HI[ply + 1] = HASH_HI[ply] ^ Z_HI[zidx(m.piece, m.color, m.fr, m.fc)] ^ Z_HI[zidx(m.piece, m.color, m.tr, m.tc)] ^ ZT_HI
        ^ (m.captured ? Z_HI[zidx(m.captured, opp, m.tr, m.tc)] : 0);
      const s = -quiesce(nb, opp, -beta, -alpha, ply + 1, deadline, qDepth - 1);
      if (aborted) return alpha;
      if (s >= beta) return beta;
      if (s > alpha) alpha = s;
    }
    return alpha;
  }

  /* ---------- 主搜索 ---------- */
  function negamax(board, turn, depth, alpha, beta, ply, deadline, qDepth, allowNull) {
    nodes++;
    if ((nodes & 2047) === 0 && Date.now() > deadline) { aborted = true; return evalSide(board, turn); }
    if (ply >= MAX_PLY) return evalSide(board, turn);

    const lo = HASH_LO[ply], hi = HASH_HI[ply];
    const checked = inCheck(board, turn);
    if (checked) depth++; // 将军延伸：被将军时多搜一层，避免漏算杀棋

    const alphaOrig = alpha;
    let ttMk = -1;
    const e = ttGet(lo, hi);
    if (e) {
      ttMk = e.mk;
      if (e.depth >= depth && ply > 0) {
        let s = e.score;
        if (s > MATE_LOW) s -= ply; else if (s < -MATE_LOW) s += ply; // 还原将杀距离
        if (e.flag === TT_EXACT) return s;
        if (e.flag === TT_LOWER && s > alpha) alpha = s;
        else if (e.flag === TT_UPPER && s < beta) beta = s;
        if (alpha >= beta) return s;
      }
    }

    if (depth <= 0) return quiesce(board, turn, alpha, beta, ply, deadline, qDepth);

    const opp = turn === RED ? BLACK : RED;

    // 空步剪枝：让对手连走两手的搜索结果若仍不足以提升 alpha，说明本方局面足够好，可直接剪枝。
    // 象棋中 zugzwang 极少（不像国象残局），安全性可接受；被将军或有大子时才启用。
    if (allowNull && !checked && depth >= 3 && beta < MATE_LOW && hasBigPiece(board, turn)) {
      HASH_LO[ply + 1] = lo ^ ZT_LO;
      HASH_HI[ply + 1] = hi ^ ZT_HI;
      const R = depth > 6 ? 3 : 2;
      const s = -negamax(board, opp, depth - 1 - R, -beta, -beta + 1, ply + 1, deadline, qDepth, false);
      if (aborted) return alpha;
      if (s >= beta) return beta;
    }

    const moves = Eng.legalMoves(board, turn);
    if (moves.length === 0) return -MATE + ply; // 将死/困毙 → 走棋方负（象棋困毙亦判负）
    orderMoves(moves, ply, ttMk);

    let best = -Infinity, bestMk = -1;
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const nb = Eng.makeMove(board, m);
      HASH_LO[ply + 1] = lo ^ Z_LO[zidx(m.piece, m.color, m.fr, m.fc)] ^ Z_LO[zidx(m.piece, m.color, m.tr, m.tc)] ^ ZT_LO
        ^ (m.captured ? Z_LO[zidx(m.captured, opp, m.tr, m.tc)] : 0);
      HASH_HI[ply + 1] = hi ^ Z_HI[zidx(m.piece, m.color, m.fr, m.fc)] ^ Z_HI[zidx(m.piece, m.color, m.tr, m.tc)] ^ ZT_HI
        ^ (m.captured ? Z_HI[zidx(m.captured, opp, m.tr, m.tc)] : 0);

      const givesCheck = inCheck(nb, opp);
      let s;
      if (i === 0) {
        // PVS：首个走法用全窗口精确搜索
        s = -negamax(nb, opp, depth - 1, -beta, -alpha, ply + 1, deadline, qDepth, true);
      } else {
        // LMR：靠后的安静走法先浅搜，失败再全深重搜
        let r = 0;
        if (depth >= 3 && i >= 4 && !m.captured && !givesCheck && !checked) r = depth >= 6 ? 2 : 1;
        s = -negamax(nb, opp, depth - 1 - r, -alpha - 1, -alpha, ply + 1, deadline, qDepth, true);
        if (s > alpha && (r > 0 || s < beta)) {
          s = -negamax(nb, opp, depth - 1, -beta, -alpha, ply + 1, deadline, qDepth, true);
        }
      }
      if (aborted) return best === -Infinity ? evalSide(board, turn) : best;

      if (s > best) { best = s; bestMk = moveKey(m); }
      if (best > alpha) {
        alpha = best;
        if (alpha >= beta) {
          // 剪枝：更新杀手与历史启发，供后续分支复用
          if (!m.captured) {
            const k = ply * 2;
            if (killers[k] !== moveKey(m)) { killers[k + 1] = killers[k]; killers[k] = moveKey(m); }
            const hi2 = histIdx(m.piece, m.tr, m.tc);
            HIST[hi2] += depth * depth;
            if (HIST[hi2] > 1e6) for (let j = 0; j < HIST.length; j++) HIST[j] >>= 1; // 溢出保护
          }
          break;
        }
      }
    }

    // 写入置换表（将杀分数按 ply 归一化后再存）
    let store = best;
    if (store > MATE_LOW) store += ply; else if (store < -MATE_LOW) store -= ply;
    const flag = best <= alphaOrig ? TT_UPPER : (best >= beta ? TT_LOWER : TT_EXACT);
    const prev = tt.get(lo);
    if (!prev || prev.hi !== hi || prev.depth <= depth) ttSet(lo, hi, depth, store, flag, bestMk);
    return best;
  }

  /**
   * 搜索主入口
   * @param {Array} board 棋盘
   * @param {string} turn 当前走棋方
   * @param {Object} opts { depth, timeLimit, topN, qDepth }
   * @returns {{move, score, candidates:[{move,score,notation,coord}]}}
   */
  function search(board, turn, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const maxDepth = Math.max(1, Math.min(8, opts.depth || 3));
    const timeLimit = opts.timeLimit || 1200;
    const topN = opts.topN || 5;
    const qDepth = opts.qDepth != null ? opts.qDepth : 4;
    const deadline = Date.now() + timeLimit;

    const rootMoves = Eng.legalMoves(board, turn);
    if (rootMoves.length === 0) return { move: null, score: 0, candidates: [] };

    // 每次搜索重置启发式（杀手/历史跨搜索保留会污染不同局面的排序；历史表保留但衰减）
    killers.fill(-1);
    for (let j = 0; j < HIST.length; j++) HIST[j] >>= 3;
    nodes = 0;
    aborted = false;

    const rootHash = Eng.hashBoard(board, turn);
    HASH_LO[0] = rootHash.lo;
    HASH_HI[0] = rootHash.hi;

    let lastScores = null;
    let prevScores = null;
    let reachedDepth = 0;
    for (let d = 1; d <= maxDepth; d++) {
      // 上一层的排序作为本层走法顺序（TT 里的最佳走法也会通过 orderMoves 优先）
      const seq = lastScores
        ? lastScores.slice().sort((a, b) => b.score - a.score).map(x => x.move)
        : rootMoves.slice().sort((a, b) => (b.captured ? 1e6 : 0) - (a.captured ? 1e6 : 0));
      const scored = seq.map(m => ({ move: m, score: -Infinity }));
      let alpha = -Infinity;
      const beta = Infinity;
      for (let i = 0; i < seq.length; i++) {
        const m = seq[i];
        if (aborted || Date.now() > deadline) { aborted = true; break; }
        const nb = Eng.makeMove(board, m);
        const opp = turn === RED ? BLACK : RED;
        HASH_LO[1] = HASH_LO[0] ^ Z_LO[zidx(m.piece, m.color, m.fr, m.fc)] ^ Z_LO[zidx(m.piece, m.color, m.tr, m.tc)] ^ ZT_LO
          ^ (m.captured ? Z_LO[zidx(m.captured, opp, m.tr, m.tc)] : 0);
        HASH_HI[1] = HASH_HI[0] ^ Z_HI[zidx(m.piece, m.color, m.fr, m.fc)] ^ Z_HI[zidx(m.piece, m.color, m.tr, m.tc)] ^ ZT_HI
          ^ (m.captured ? Z_HI[zidx(m.captured, opp, m.tr, m.tc)] : 0);
        const s = -negamax(nb, opp, d - 1, -beta, -alpha, 1, deadline, qDepth, true);
        if (aborted) break;
        const entry = scored.find(x => x.move === m);
        if (entry) entry.score = s;
        if (s > alpha) alpha = s;
      }
      prevScores = lastScores; // 保留上一层完整结果，用于本层超时未重评的走法
      lastScores = scored;
      if (!aborted) reachedDepth = d;
      if (aborted || Date.now() > deadline) break;
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
      rootMoves.slice(0, Math.max(1, topN)).forEach(m => valid.push({ move: m, score: evalSide(board, turn) }));
    }

    // （V0.5.0 教训，勿复活）曾在此把"完整评估 - 快速评估"的动态增量补进 root 候选分
    // （dual-speed 校正）。实测两级证伪：
    //   ① 超时打断时：valid 混有本层精确分与上层陈旧分，校正令自对弈得分率 100% → 5%；
    //   ② 加 !aborted 守卫后：完整搜索下依然 15% vs 无校正 67%（head-to-head）。
    // 本质：这是用"1 层深度的动态评估判断"覆盖"6 层深度的搜索判断"，方向性错误；
    // 配对局面测试曾给出 +320 的正信号，但那是"旧评估裁判被机动性优化欺骗"的代理失真。
    // 结论：搜索只用 evaluateFast（子力+位置表，实测 head-to-head 66.7% vs 旧评估）；
    // 完整 evaluate() 仅供 evalSummary/UI 展示，不进搜索决策。
    valid.sort((a, b) => b.score - a.score);
    const candidates = valid.slice(0, Math.max(1, topN)).map(e => ({
      move: e.move,
      score: e.score,
      notation: Eng.notation(board, e.move),
      coord: Eng.moveToCoord(e.move),
    }));

    // 开局库：命中时把库走法提到候选首位——前 8-10 手跟谱走，不在开局浪费搜索深度。
    // 候选列表照常给出（LLM 仍有选择空间），仅首位顺序受库引导；降级引擎走 top1 即谱着。
    const book = global.ChessBook ? global.ChessBook.lookup(board, turn) : null;
    if (book && candidates.length) {
      const bmk = moveKey(book.move);
      const bi = candidates.findIndex(c => moveKey(c.move) === bmk);
      if (bi > 0) {
        candidates.unshift(candidates.splice(bi, 1)[0]);
      } else if (bi < 0) {
        candidates.unshift({
          move: book.move,
          score: candidates[0].score,
          notation: Eng.notation(board, book.move),
          coord: Eng.moveToCoord(book.move),
        });
        if (candidates.length > Math.max(1, topN)) candidates.pop();
      }
    }
    // 慢搜索日志（V0.5.1）：超过 200ms 的搜索记入 Logger（cat=engine），性能排查用
    const L = global.Logger;
    const ms = Date.now() - t0;
    if (L && ms > 200) {
      L.info('engine', 'slow_search', { ms, depth: reachedDepth, nodes, topN: Math.max(1, topN), timeLimit });
    }
    return {
      move: candidates[0] ? candidates[0].move : null,
      score: candidates[0] ? candidates[0].score : 0,
      candidates,
      depth: reachedDepth,
      nodes,
    };
  }

  /** 快速评估（供状态栏/聊天注入） */
  function evaluateFen(board) { return Eng.evalSummary(board); }

  /**
   * 清空置换表与启发式表。
   * 正常对局中 TT 跨步复用是性能优化，不该清；这里供基准测试调用——
   * 若两个引擎先后搜同一批局面而不清表，先跑的一方会给后跑方"预热"TT，
   * 造成系统性偏差（实测可达 200 分子力，足以淹没真实棋力差）。
   */
  function reset() {
    tt.clear();
    killers.fill(-1);
    HIST.fill(0);
    nodes = 0;
    aborted = false;
  }

  /* ---------- 走子质量判定（V0.5.2）----------
   * 背景：早期用「走子前后静态评估之差」判定好棋/臭棋，结果把"吃子后被反吃"
   * 判成好棋（静态评估看不到对手应手）。改用浅搜索量化"这一步相对引擎最优的亏损"。
   * 口径：loss = (-search(走后, 对手).score) - search(走前, 走子方).score，
   *       两者都换算到走子方视角；≤0 为亏，数值单位与子力一致（兵100/马400/车900）。
   * 注意：search 返回的 score 是「当前搜索方」视角，走后局面必须取负号换算回来。
   */
  const LOSS_THRESHOLDS = {
    good: -30,      // ≥ 此值：与最优几乎无损 → 好棋
    blunder: -120,  // ≤ 此值：明显吃亏（约一个兵以上） → 臭棋
    terrible: -350, // ≤ 此值：丢大子（约一马以上） → 严重臭棋
  };
  const LOSS_DELTA = { good: +3, blunder: -3, terrible: -5 };

  /**
   * 量化某一步的亏损。before/after 为走子前后的 board，mover 为走子方颜色。
   * @returns {{loss:number, best:?{move,score,notation,coord}, depth:number}|null}
   *          null = 搜索不可用（调用方应回退到静态判定）
   */
  function moveLoss(before, after, mover, opts) {
    opts = opts || {};
    const depth = opts.depth || 2;
    const timeLimit = opts.timeLimit || 200;
    const opp = mover === RED ? BLACK : RED;
    let best = null, reply = null;
    try {
      best = search(before, mover, { depth, topN: 3, timeLimit });
      reply = search(after, opp, { depth, topN: 3, timeLimit });
    } catch (e) { return null; }
    if (!best || !reply || !Number.isFinite(best.score) || !Number.isFinite(reply.score)) return null;
    if (!best.candidates || !best.candidates.length) return null;
    return {
      loss: Math.round(-reply.score - best.score), // 换算回 mover 视角
      best: best.candidates[0] || null,
      depth,
    };
  }

  /** 亏损分档：good(+3) / blunder(-3) / terrible(-5) / null(不反应) */
  function classifyLoss(loss) {
    if (!Number.isFinite(loss)) return null;
    if (loss >= LOSS_THRESHOLDS.good) return { kind: 'good', delta: LOSS_DELTA.good };
    if (loss <= LOSS_THRESHOLDS.terrible) return { kind: 'terrible', delta: LOSS_DELTA.terrible };
    if (loss <= LOSS_THRESHOLDS.blunder) return { kind: 'blunder', delta: LOSS_DELTA.blunder };
    return null;
  }

  global.ChessAI = {
    search, evaluateFen, reset, MATE,
    moveLoss, classifyLoss, LOSS_THRESHOLDS, LOSS_DELTA,
  };
})(typeof window !== 'undefined' ? window : globalThis);
