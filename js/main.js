/* ============================================================
 * main.js — 主程序：棋盘渲染与交互、模式管理、AI 走子、
 *            弹窗装配、设置持久化
 * ============================================================ */
(function (global) {
  'use strict';
  const Eng = global.ChessEngine;
  const AI = global.ChessAI;
  const Personas = global.Personas;
  const LLM = global.LLMClient;
  const Game = global.Game;
  const Chat = global.Chat;
  const GameSound = global.GameSound;
  const RED = Eng.RED, BLACK = Eng.BLACK;

  const $ = id => document.getElementById(id);
  /** 转义用户可控文本，防止人设名称/头像被当作 HTML 注入 */
  const escapeHtml = s => String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

  /* ---------- 设置 ---------- */
  const DEFAULT_SETTINGS = {
    provider: 'openai',
    apiBaseUrl: 'https://api.openai.com/v1',
    apiModel: 'gpt-4o-mini',
    apiKey: '',
    difficulty: 3,
    playerColor: 'r',
    maxUndo: 2,
    aiPersonaId: 'street_king',
    redPersonaId: 'street_king',
    blackPersonaId: 'old_gentle',
    spectateInterval: 3000,
    commentary: true,
    autoTaunt: true,
    autoReview: true,
    streaming: true,
    sound: true,
    ttsEnabled: true,
    ttsEngine: 'browser',
    ttsBaseUrl: '',
    ttsApiKey: '',
    ttsModel: 'tts-1',
    ttsVoice: 'alloy',
  };
  const LS_SETTINGS = 'aixq_settings';
  let settings = loadSettings();
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
      return Object.assign({}, DEFAULT_SETTINGS, s || {});
    } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  function saveSettings() { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* ignore */ } }
  global.AppSettings = {
    get: () => settings,
    set(s) { settings = Object.assign(settings, s); saveSettings(); },
  };

  /* ---------- 运行状态 ---------- */
  let mode = 'human';            // human | spectate
  let selected = null;           // {r,c}
  let legalTargets = [];         // [{tr,tc}]
  let aiBusy = false;
  let aiController = null;
  let spectateTimer = null;
  let spectatePaused = false;
  let lastReactMoveCount = -10;   // 自动反应（好棋/坏棋）的冷却计数
  let undoPending = false;        // 正在等待 AI 审批悔棋请求
  let undoRequestCount = 0;       // 本局玩家请求悔棋次数（含被驳回）
  let hintMove = null;
  let ctxToken = 0;
  let stateGen = 0;      // 每开新局自增，用于丢弃旧对局的异步 AI 任务
  let resignContext = null; // 认输瞬间的局面评估 { tier, playerScore }，供差异化复盘

  /* ---------- DOM ---------- */
  const els = {};
  const IDS = ['boardCanvas', 'piecesLayer', 'thinkingTag', 'statusText', 'evalText', 'moveList',
    'btnUndo', 'btnRestart', 'btnResign', 'btnHint', 'btnPause', 'chatOpponent',
    'chatMessages', 'chatInput', 'btnSend', 'btnStop', 'modeTabs',
    'modalSettings', 'setProvider', 'setBaseUrl', 'setModel', 'setApiKey', 'btnTestApi', 'apiTestResult',
    'setAiPersona', 'setPlayerColor', 'setDifficulty', 'setMaxUndo',
    'setRedPersona', 'setBlackPersona', 'setInterval', 'setSound', 'setCommentary', 'setAutoTaunt', 'setAutoReview', 'setStreaming',
    'setTtsEnabled', 'setTtsEngine', 'setTtsBaseUrl', 'setTtsApiKey', 'setTtsModel', 'setTtsVoice', 'btnTtsPreview',
    'btnSettingsSave', 'btnSettingsCancel',
    'modalPersonas', 'personaList', 'pName', 'pEmoji', 'pDesc', 'pStyle', 'pTaunt', 'pTauntVal', 'pTalk', 'pTalkVal', 'pExtra',
    'btnPNew', 'btnPDupe', 'btnPSave', 'btnPDelete', 'personaEditHint', 'btnPersonasClose',
    'modalExport', 'exportText', 'btnExportCopy', 'btnExportDownload', 'btnExportClose',
    'btnSettings', 'btnPersonas', 'btnExport'];
  function cacheEls() { IDS.forEach(id => els[id] = $(id)); }

  /* ---------- 棋盘几何 ---------- */
  function boardMetrics() {
    const wrap = $('boardWrap');
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const pad = Math.max(10, Math.min(w, h) * 0.045);
    const cell = Math.floor(Math.min((w - pad * 2) / 8, (h - pad * 2) / 9));
    return { cell, ox: Math.floor((w - cell * 8) / 2), oy: Math.floor((h - cell * 9) / 2), w, h };
  }
  function piecePos(r, c) {
    const m = boardMetrics();
    return { x: m.ox + c * m.cell, y: m.oy + r * m.cell };
  }
  function cellFromXY(x, y) {
    const m = boardMetrics();
    const c = Math.round((x - m.ox) / m.cell), r = Math.round((y - m.oy) / m.cell);
    if (c < 0 || c > 8 || r < 0 || r > 9) return null;
    return { r, c };
  }

  /* ---------- 棋盘绘制 ---------- */
  function drawBoard() {
    const canvas = els.boardCanvas;
    const m = boardMetrics();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(m.w * dpr);
    canvas.height = Math.round(m.h * dpr);
    canvas.style.width = m.w + 'px';
    canvas.style.height = m.h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, m.w, m.h);

    const x0 = m.ox, y0 = m.oy, x1 = m.ox + 8 * m.cell, y1 = m.oy + 9 * m.cell;
    const stroke = '#5f3719';
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1.2, m.cell * 0.022);

    const seg = (x1p, y1p, x2p, y2p) => {
      ctx.beginPath();
      ctx.moveTo(x1p, y1p);
      ctx.lineTo(x2p, y2p);
      ctx.stroke();
    };
    // 横线
    for (let r = 0; r <= 9; r++) seg(x0, y0 + r * m.cell, x1, y0 + r * m.cell);
    // 竖线（中间列避开河界）
    for (let c = 0; c <= 8; c++) {
      const x = x0 + c * m.cell;
      if (c === 0 || c === 8) seg(x, y0, x, y1);
      else { seg(x, y0, x, y0 + 4 * m.cell); seg(x, y0 + 5 * m.cell, x, y1); }
    }
    // 九宫斜线
    seg(x0 + 3 * m.cell, y0, x0 + 5 * m.cell, y0 + 2 * m.cell);
    seg(x0 + 5 * m.cell, y0, x0 + 3 * m.cell, y0 + 2 * m.cell);
    seg(x0 + 3 * m.cell, y0 + 7 * m.cell, x0 + 5 * m.cell, y0 + 9 * m.cell);
    seg(x0 + 5 * m.cell, y0 + 7 * m.cell, x0 + 3 * m.cell, y0 + 9 * m.cell);

    // 星位点
    const dot = (r, c, type) => {
      const cx = x0 + c * m.cell, cy = y0 + r * m.cell;
      ctx.fillStyle = stroke;
      const s = Math.max(3, m.cell * 0.09);
      if (type === 'x') {
        ctx.beginPath();
        ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
        ctx.moveTo(cx - s, cy + s); ctx.lineTo(cx + s, cy - s);
        ctx.lineWidth = Math.max(1.4, m.cell * 0.03);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    for (const [c, r] of [[1, 2], [7, 2], [1, 7], [7, 7]]) dot(r, c, 'x');
    for (const [c, r] of [[0, 3], [2, 3], [4, 3], [6, 3], [8, 3], [0, 6], [2, 6], [4, 6], [6, 6], [8, 6]]) dot(r, c, 'o');

    // 楚河汉界
    ctx.font = `${Math.max(14, Math.floor(m.cell * 0.4))}px "KaiTi","STKaiti",serif`;
    ctx.fillStyle = '#5f3719';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const midY = y0 + 4.5 * m.cell;
    ctx.fillText('楚　河', x0 + 2 * m.cell, midY);
    ctx.fillText('汉　界', x0 + 6 * m.cell, midY);
  }

  /* ---------- 棋子渲染 ---------- */
  function renderBoard() {
    const layer = els.piecesLayer;
    layer.innerHTML = '';
    const m = boardMetrics();
    const size = Math.floor(m.cell * 0.84);
    const st = Game.state;
    if (!st) return;
    const last = st.history.length ? st.history[st.history.length - 1] : null;

    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
      const p = st.board[r][c];
      if (!p) continue;
      const div = document.createElement('div');
      div.className = 'piece ' + (p.color === RED ? 'red' : 'black');
      div.textContent = Eng.PIECE_NAME[p.type][p.color === RED ? 0 : 1];
      const pos = piecePos(r, c);
      div.style.width = size + 'px';
      div.style.height = size + 'px';
      div.style.fontSize = Math.floor(size * 0.5) + 'px';
      div.style.lineHeight = size + 'px';
      div.style.left = pos.x + 'px';
      div.style.top = pos.y + 'px';
      div.style.marginLeft = -(size / 2) + 'px';
      div.style.marginTop = -(size / 2) + 'px';
      if (selected && selected.r === r && selected.c === c) div.classList.add('selected');
      if (last && last.move.fr === r && last.move.fc === c) div.classList.add('last-from');
      if (last && last.move.tr === r && last.move.tc === c) div.classList.add('last-to');
      if (hintMove && hintMove.fr === r && hintMove.fc === c) div.classList.add('hint-from');
      if (hintMove && hintMove.tr === r && hintMove.tc === c) div.classList.add('hint-to');
      layer.appendChild(div);
    }
    for (const t of legalTargets) {
      const pos = piecePos(t.tr, t.tc);
      const d = document.createElement('div');
      if (st.board[t.tr][t.tc]) {
        d.className = 'target-capture';
        // 圆环比棋子略大一圈，确保深色标记清晰可见（CSS 中的百分比会相对整个棋盘层）
        const ring = Math.floor(m.cell * 0.84) + 6;
        d.style.width = ring + 'px';
        d.style.height = ring + 'px';
      } else {
        d.className = 'target-dot';
      }
      d.style.left = pos.x + 'px';
      d.style.top = pos.y + 'px';
      layer.appendChild(d);
    }
    // 最近一步的原位置中心加红点标记（棋子已移走，原格为空）
    if (last && last.move) {
      const fromPos = piecePos(last.move.fr, last.move.fc);
      const dot = document.createElement('div');
      dot.className = 'last-dot';
      const dotSize = Math.max(8, Math.floor(m.cell * 0.16));
      dot.style.width = dotSize + 'px';
      dot.style.height = dotSize + 'px';
      dot.style.left = fromPos.x + 'px';
      dot.style.top = fromPos.y + 'px';
      layer.appendChild(dot);
    }
  }

  /* ---------- 交互 ---------- */
  function clearSelection() { selected = null; legalTargets = []; }

  function handleClick(r, c) {
    if (hintMove) { hintMove = null; renderBoard(); }
    if (mode === 'spectate' || aiBusy || undoPending || !Game.state || Game.state.over) return;
    if (Game.state.turn !== playerColor()) return;
    const p = Game.state.board[r][c];
    if (selected) {
      const target = legalTargets.find(t => t.tr === r && t.tc === c);
      if (target) {
        doHumanMove(selected.r, selected.c, r, c);
        return;
      }
      if (p && p.color === playerColor()) { selectPiece(r, c); return; }
      clearSelection();
      renderBoard();
      return;
    }
    if (p && p.color === playerColor()) selectPiece(r, c);
  }

  function selectPiece(r, c) {
    selected = { r, c };
    legalTargets = Eng.legalMoves(Game.state.board, playerColor())
      .filter(m => m.fr === r && m.fc === c)
      .map(m => ({ tr: m.tr, tc: m.tc }));
    renderBoard();
  }

  function doHumanMove(fr, fc, tr, tc) {
    const move = { fr, fc, tr, tc };
    if (Game.wouldRepeatCheck(move)) {
      clearSelection();
      renderBoard();
      Chat.systemLine('⚠️ 不能长将：这步棋会让同一局面重复第 3 次，请换一种走法。');
      return;
    }
    clearSelection();
    if (!Game.applyMove(move)) return;
    afterMove(false);
  }

  function afterMove(movedByAI) {
    // 落子/吃子音效：玩家、AI、观战模式统一在这里播放
    const st = Game.state;
    const last = st.history.length ? st.history[st.history.length - 1] : null;
    if (last && GameSound) {
      if (last.move.captured) GameSound.playCapture();
      else GameSound.playMove();
    }
    renderBoard();
    updateStatus();
    updateMoveList();
    refreshChatContext();
    if (st.over) { onGameOver(); return; }
    if (mode === 'human') {
      if (!movedByAI) {
        maybeReact();
        aiTurn();
      }
    }
  }

  /* ---------- 悔棋 ---------- */
  /** 计算本次悔棋应回退的步数：让玩家回到“重走上一手”的位置 */
  function undoSteps() {
    const st = Game.state;
    if (!st || st.history.length === 0) return 0;
    const lastColor = st.history[st.history.length - 1].move.color;
    if (lastColor === playerColor()) return 1; // 玩家刚走的一步（AI 尚未应），只撤回它
    return Math.min(2, st.history.length);      // 撤回 AI 的应手 + 玩家上一手
  }

  /** 执行悔棋并刷新界面；若回退后轮到 AI，自动让 AI 续走避免卡死 */
  function performUndo(steps) {
    if (!Game.undo(steps)) return false;
    clearSelection();
    renderBoard();
    updateStatus();
    updateMoveList();
    refreshChatContext();
    if (mode === 'human' && !Game.state.over && Game.state.turn === aiColor()) aiTurn();
    return true;
  }

  /** 已配置 LLM 时的悔棋审批流程：先嘲讽/裁决，同意才执行 */
  async function requestUndo(steps) {
    const st = Game.state;
    if (!st) return;
    const count = ++undoRequestCount;
    undoPending = true;
    els.btnUndo.disabled = true;
    refreshChatContext(); // 保证聊天上下文是最新棋盘
    Chat.systemLine(`↩️ 你请求悔棋（本局第 ${count} 次），等待对手回应…`);
    const moves = st.history.slice(-steps).map(h => ({
      notation: h.notation,
      color: h.move.color,
      captured: h.move.captured,
    }));
    let verdict = null;
    try {
      verdict = await Chat.requestUndo({ count, steps, moves });
    } finally {
      if (Game.state === st) {
        undoPending = false;
        els.btnUndo.disabled = false;
      }
    }
    if (!verdict || !verdict.allow) return; // 驳回或取消
    const cur = Game.state;
    if (!cur || cur !== st || cur.over) return; // 等待期间对局已重开/切换
    performUndo(steps);
  }

  /* ---------- 状态栏 / 棋谱 ---------- */
  function updateStatus() {
    const st = Game.state;
    if (!st) return;
    const ev = Eng.evalSummary(st.board);
    els.evalText.textContent = ev.label;
    const king = Eng.findKing(st.board, st.turn);
    const check = king && Eng.isAttacked(st.board, king.r, king.c, st.turn === RED ? BLACK : RED);
    let txt;
    if (st.over) txt = (st.over.winner === RED ? '红方' : '黑方') + '胜（' + st.over.reason + '）';
    else txt = (st.turn === RED ? '红' : '黑') + '方走子' + (check ? ' — 将军！' : '');
    els.statusText.textContent = txt;
    els.statusText.classList.toggle('check', !!(check && !st.over));
  }

  function updateMoveList() {
    const st = Game.state;
    const box = els.moveList;
    box.innerHTML = '';
    st.history.forEach((h, i) => {
      const span = document.createElement('span');
      span.className = 'mv';
      span.innerHTML = `<span class="no">${Math.floor(i / 2) + 1}.</span>${i % 2 === 0 ? '红' : '黑'}${h.notation}`;
      if (i === st.history.length - 1) span.classList.add('cur');
      box.appendChild(span);
    });
    box.scrollTop = box.scrollHeight;
  }

  /* ---------- 聊天上下文 ---------- */
  function refreshChatContext() {
    const st = Game.state;
    if (!st) return;
    const last = st.history.length ? st.history[st.history.length - 1] : null;
    const lastMover = last ? last.move.color : RED;
    const personaId = mode === 'human'
      ? settings.aiPersonaId
      : (lastMover === RED ? settings.redPersonaId : settings.blackPersonaId);
    const fen = Eng.toFEN(st.board, st.turn);
    const ctx = {
      board: st.board, turn: st.turn, fen,
      evalSummary: Eng.evalSummary(st.board),
      topMoves: [],
      lastMoveNotation: last ? last.notation : null,
      lastMove: last ? last.move : null,
      personaId,
      // 人机模式：AI 是玩家的对手；观战模式：当前解说的 AI 就是刚走棋的那一方
      personaColor: mode === 'human' ? aiColor() : lastMover,
      difficulty: settings.difficulty,
      mode,
    };
    Chat.setPosition(ctx);
    const token = ++ctxToken;
    Promise.resolve(AI.search(st.board, st.turn, { depth: Math.min(2, settings.difficulty || 3), topN: 3, timeLimit: 300 })).then(res => {
      if (token !== ctxToken) return;
      const c = Chat.getContext();
      if (c && c.fen === fen) c.topMoves = res.candidates || [];
    });
  }

  function updateChatHeader() {
    if (mode === 'human') {
      const p = Personas.get(settings.aiPersonaId);
      els.chatOpponent.textContent = `🤝 对手：${p.emoji} ${p.name}`;
    } else {
      const r = Personas.get(settings.redPersonaId);
      const b = Personas.get(settings.blackPersonaId);
      els.chatOpponent.textContent = `🎬 观战：红 ${r.emoji}${r.name} vs 黑 ${b.emoji}${b.name}`;
    }
  }

  /* ---------- AI 走子 ---------- */
  const playerColor = () => settings.playerColor;
  const aiColor = () => (settings.playerColor === RED ? BLACK : RED);

  function matchMove(candidates, coord) {
    if (!coord) return null;
    const c = String(coord).toLowerCase().trim();
    const find = s => candidates.find(x => x.coord === s) || null;
    let hit = find(c);
    if (hit) return hit;
    if (/^[a-i][0-9][a-i][0-9]$/.test(c)) {
      const flip = c[0] + (9 - +c[1]) + c[2] + (9 - +c[3]);
      hit = find(flip);
    }
    return hit;
  }

  /** 引擎出候选 + LLM 按人设挑选；无 Key/失败时降级引擎 top1 */
  async function aiPick(persona, board, turn) {
    // difficulty = 0 表示“LLM 自由选择”：候选范围给足，让 LLM 根据对话氛围灵活选强弱
    const freeChoice = settings.difficulty === 0;
    const res = AI.search(board, turn, {
      depth: freeChoice ? 3 : settings.difficulty,
      topN: freeChoice ? 100 : 5,
      timeLimit: freeChoice ? (mode === 'spectate' ? 1600 : 2200) : (mode === 'spectate' ? 900 : 1400),
    });
    if (!res.candidates.length) return null;
    // 过滤长将走法：AI 不允许主动长将
    const legalAll = Eng.legalMoves(board, turn);
    const blockedKey = m => m.fr + ',' + m.fc + '>' + m.tr + ',' + m.tc;
    const blocked = new Set(legalAll.filter(m => Game.wouldRepeatCheckMatched(m)).map(blockedKey));
    res.candidates = res.candidates.filter(c => !blocked.has(blockedKey(c.move)));
    if (!res.candidates.length) {
      // 候选全被过滤时，从合法走法中选一个非长将的兜底（正常局面不会走到这里）
      const legal = legalAll.filter(m => !blocked.has(blockedKey(m)));
      if (!legal.length) return null;
      const fallback = legal[0];
      res.candidates = [{ move: fallback, score: 0, notation: Eng.notation(board, fallback), coord: Eng.moveToCoord(fallback) }];
      res.move = fallback;
      res.score = 0;
    } else {
      res.move = res.candidates[0].move;
      res.score = res.candidates[0].score;
    }
    const top = res.candidates[0];
    const cfg = LLM.getConfig();
    if (!cfg.apiKey || !cfg.model || !cfg.baseUrl) {
      return { move: top.move, thought: null, notation: top.notation };
    }
    const sideName = turn === RED ? '红' : '黑';
    const oppSideName = turn === RED ? '黑' : '红';
    const list = res.candidates.map((c, i) => {
      let cap = '';
      if (c.move.captured) {
        const capColor = turn === RED ? BLACK : RED;
        cap = `，可吃${oppSideName}方${Eng.PIECE_NAME[c.move.captured][capColor === RED ? 0 : 1]}`;
      }
      return `${i + 1}. ${c.notation}（坐标 ${c.coord}，评分 ${c.score > 0 ? '+' : ''}${Math.round(c.score)}${cap}）`;
    }).join('\n');
    const pickRule = freeChoice
      ? `当前棋力档位：LLM 自由选择。你可以根据当前互动氛围和你的心情，在候选走法里任意选择：` +
        `想认真赢棋就选评分高的；想放水、求饶、给对方面子或故意斗气，就选评分低一些的（但不要选会直接送将的走法）。`
      : `请结合你的棋风人设挑选一步。`;
    const sys =
      `你是象棋对手「${persona.name}」${persona.emoji}，执${sideName}方。\n${persona.desc}\n${Personas.styleText(persona)}\n\n` +
      `当前轮到你（${sideName}方）走子，对手执${oppSideName}方。\n局面 FEN：${Eng.toFEN(board, turn)}\n\n` +
      `引擎给出的候选走法（按推荐度降序，评分越高越强）：\n${list}\n\n` +
      `${pickRule}只输出一个 JSON 对象：\n{"move":"坐标","thought":"一句符合人设的心理活动/垃圾话"}\n` +
      `坐标格式：列字母 a-i（左到右）+ 行数字 0-9（上到下）。例如 h9e9 表示红方二路炮平五。\n` +
      `thought 要口语化，像真人下棋时随口说的话，不要书面分析；如果候选走法有吃子，要准确说明吃的是对方哪个棋子，不要张冠李戴。`;
    const controller = new AbortController();
    aiController = controller;
    try {
      const user1 = '请选择走法。';
      let raw = await LLM.request(
        [{ role: 'system', content: sys }, { role: 'user', content: user1 }],
        { stream: false, temperature: 0.4, maxTokens: 180, signal: controller.signal });
      let j = LLM.extractJSON(raw);
      let chosen = matchMove(res.candidates, j && j.move);
      if (!chosen) {
        raw = await LLM.request(
          [{ role: 'system', content: sys },
          { role: 'user', content: `你上次的输出无效。请严格只从上面的候选走法中选一个，只输出 JSON：{"move":"坐标","thought":"..."}` }],
          { stream: false, temperature: 0.2, maxTokens: 180, signal: controller.signal });
        j = LLM.extractJSON(raw);
        chosen = matchMove(res.candidates, j && j.move);
      }
      if (!chosen) chosen = top;
      return { move: chosen.move, thought: (j && j.thought) || null, notation: chosen.notation };
    } catch (e) {
      if (e.name === 'AbortError') return null;
      return { move: top.move, thought: null, notation: top.notation };
    } finally {
      // 仅当当前挂起的仍是我们这个请求时才清空，避免覆盖新开局的 controller
      if (aiController === controller) aiController = null;
    }
  }

  async function aiTurn() {
    if (mode !== 'human') return;
    const st = Game.state;
    if (!st || st.over || st.turn !== aiColor()) return;
    const gen = stateGen;
    aiBusy = true;
    els.thinkingTag.classList.remove('hidden');
    const persona = Personas.get(settings.aiPersonaId);
    try {
      const pick = await aiPick(persona, st.board, st.turn);
      if (gen !== stateGen) return; // 期间已重开/切换模式
      const cur = Game.state;
      if (!pick || !cur || cur !== st || cur.over || cur.turn !== st.turn) return; // 状态已变（悔棋/重开）
      Game.applyMove(pick.move);
      const notation = cur.history.length ? cur.history[cur.history.length - 1].notation : pick.notation;
      Chat.systemLine(`🤖 ${persona.emoji} ${persona.name} 走：${notation}`);
      afterMove(true);
      if (!cur.over && pick.thought) {
        if (Chat.busy) Chat.systemLine(`（${persona.name}嘀咕：${pick.thought}）`);
        else Chat.showQuickAssistant(pick.thought);
      }
    } finally {
      if (gen === stateGen) {
        aiBusy = false;
        els.thinkingTag.classList.add('hidden');
      }
    }
  }

  /* ---------- 对好棋/坏棋的自动反应 ---------- */
  function maybeReact() {
    if (!settings.autoTaunt) return;
    const st = Game.state;
    if (st.over || st.turn !== aiColor()) return;
    const last = st.history[st.history.length - 1];
    if (!last) return;
    const pc = playerColor();
    const before = Eng.parseFEN(last.preFen).board;
    const e0 = Eng.evaluate(before), e1 = Eng.evaluate(st.board);
    // 玩家视角的局势变化：正=好棋，负=坏棋
    const swing = pc === RED ? e1 - e0 : e0 - e1;
    const abs = Math.abs(swing);
    if (abs < 150) return; // 一般般的正着不反应
    if (st.moveCount - lastReactMoveCount < 4) return;
    const persona = Personas.get(settings.aiPersonaId);
    if (Math.random() > Math.min(1, persona.taunt / 10 * 0.95)) return;
    lastReactMoveCount = st.moveCount;
    if (swing > 0) {
      // 好棋：称赞/惊讶/警惕（按人设自由发挥）
      Chat.triggerGoodMove({ notation: last.notation, evalGain: Math.round(swing) });
    } else {
      // 坏棋：按人设嘲讽，并给出引擎更优的参考
      const res = AI.search(before, pc, { depth: Math.min(2, settings.difficulty || 3), topN: 1, timeLimit: 400 });
      const better = res.candidates && res.candidates.length ? res.candidates[0] : null;
      Chat.triggerTaunt({ notation: last.notation, betterNotation: better ? better.notation : null });
    }
  }

  /* ---------- 观战模式 ---------- */
  function startSpectate() {
    stopSpectate();
    spectatePaused = false;
    els.btnPause.textContent = '⏸️ 暂停';
    tickSpectate();
  }
  function tickSpectate() {
    if (mode !== 'spectate' || spectatePaused) return;
    const st = Game.state;
    if (!st || st.over) { if (st && st.over) onGameOver(); return; }
    const gen = stateGen;
    const persona = Personas.get(st.turn === RED ? settings.redPersonaId : settings.blackPersonaId);
    const colorName = st.turn === RED ? '红' : '黑';
    aiBusy = true;
    els.thinkingTag.classList.remove('hidden');
    aiPick(persona, st.board, st.turn).then(pick => {
      if (gen !== stateGen) return; // 旧对局的异步结果，丢弃
      aiBusy = false;
      els.thinkingTag.classList.add('hidden');
      const cur = Game.state;
      if (!cur || cur !== st || cur.over) return;
      if (!pick) { schedule(); return; }
      Game.applyMove(pick.move);
      Chat.systemLine(`${persona.emoji} ${persona.name}（${colorName}方）走：${pick.notation}`);
      afterMove(true);
      if (cur.over) return;
      if (settings.commentary) Chat.spectateComment({ notation: pick.notation, colorName });
      schedule();
    }).catch(() => {
      if (gen !== stateGen) return;
      aiBusy = false;
      els.thinkingTag.classList.add('hidden');
      schedule();
    });
  }
  function schedule() { spectateTimer = setTimeout(tickSpectate, settings.spectateInterval); }
  function stopSpectate() { if (spectateTimer) { clearTimeout(spectateTimer); spectateTimer = null; } }

  /* ---------- 终局 ---------- */
  /** 认输复盘的差异化指令：按认输瞬间玩家视角的局面分三档 */
  function resignReviewExtra(ctx) {
    const abs = Math.abs(ctx.playerScore);
    if (ctx.tier === 'close') {
      return `本局以用户认输告终。认输时双方势均力敌（玩家视角分差约 ${abs} 分，相差不远）。` +
        `请以你的人设表达惋惜：这棋明明还有得一拼，怎么就缴械了；可结合真实棋谱指出一两处他本可坚持或翻盘的地方。`;
    }
    if (ctx.tier === 'losing') {
      return `本局以用户认输告终。认输时用户局面已明显落后（玩家视角落后约 ${abs} 分）。` +
        `请以胜利者的姿态接受认输：可以得意、大度或按人设调侃，并结合真实棋谱点出用户的主要败因是哪几手。`;
    }
    return `本局以用户认输告终。但认输时用户局面其实占优（玩家视角领先约 ${abs} 分），却主动投子。` +
      `请以你的人设先表示难以置信，再毫不留情地调侃“明明占优还投降”，并结合真实棋谱指出他的优势所在、本可以怎么赢。`;
  }

  function onGameOver() {
    const st = Game.state;
    if (!st || !st.over) return;
    const result = (st.over.winner === RED ? '红方' : '黑方') + '获胜（' + st.over.reason + '）';
    Chat.systemLine('🏁 对局结束：' + result);
    updateStatus();
    if (settings.autoReview) {
      refreshChatContext();
      const extra = (st.over.reason === '认输' && resignContext) ? resignReviewExtra(resignContext) : null;
      Chat.autoReview(result, extra);
    }
  }

  /* ---------- 对局控制 ---------- */
  function newGame() {
    stateGen++; // 使旧对局中尚未完成的 AI 异步任务全部失效
    if (aiController) { aiController.abort(); aiController = null; }
    aiBusy = false;
    els.thinkingTag.classList.add('hidden');
    clearSelection();
    hintMove = null;
    lastReactMoveCount = -10;
    undoPending = false;
    undoRequestCount = 0;
    resignContext = null;
    if (els.btnUndo) els.btnUndo.disabled = false;
    Game.newGame({ maxUndo: settings.maxUndo });
    renderBoard();
    updateStatus();
    updateMoveList();
    updateChatHeader();
    Chat.clear();
    refreshChatContext();
    // 玩家执黑时，新局应由 AI（红方）先走，否则对局会卡在红方回合
    if (mode === 'human' && Game.state.turn === aiColor()) aiTurn();
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('#modeTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
    const human = m === 'human';
    els.btnUndo.classList.toggle('hidden', !human);
    els.btnResign.classList.toggle('hidden', !human);
    els.btnHint.classList.toggle('hidden', !human);
    els.btnPause.classList.toggle('hidden', human);
    stopSpectate();
    Chat.abort();
    newGame();
    if (m === 'spectate') startSpectate();
  }

  /* ---------- 弹窗 ---------- */
  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }

  /* 设置弹窗 */
  function populateProviderSelect() {
    const sel = els.setProvider;
    sel.innerHTML = '';
    LLM.PROVIDERS.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    });
  }
  function openSettings() {
    els.setProvider.value = settings.provider;
    els.setBaseUrl.value = settings.apiBaseUrl || '';
    els.setModel.value = settings.apiModel || '';
    els.setApiKey.value = settings.apiKey || '';
    els.setDifficulty.value = String(settings.difficulty);
    els.setPlayerColor.value = settings.playerColor;
    els.setMaxUndo.value = String(settings.maxUndo);
    els.setAiPersona.value = settings.aiPersonaId;
    els.setRedPersona.value = settings.redPersonaId;
    els.setBlackPersona.value = settings.blackPersonaId;
    els.setInterval.value = String(settings.spectateInterval);
    els.setSound.checked = settings.sound !== false;
    els.setCommentary.checked = settings.commentary;
    els.setAutoTaunt.checked = settings.autoTaunt;
    els.setAutoReview.checked = settings.autoReview;
    els.setStreaming.checked = settings.streaming;
    els.setTtsEnabled.checked = settings.ttsEnabled !== false;
    els.setTtsEngine.value = settings.ttsEngine === 'cloud' ? 'cloud' : 'browser';
    els.setTtsBaseUrl.value = settings.ttsBaseUrl || '';
    els.setTtsApiKey.value = settings.ttsApiKey || '';
    els.setTtsModel.value = settings.ttsModel || 'tts-1';
    els.setTtsVoice.value = settings.ttsVoice || 'alloy';
    els.apiTestResult.textContent = '';
    openModal('modalSettings');
  }
  function saveSettingsFromModal() {
    const prevPlayerColor = settings.playerColor;
    const prevModel = {
      provider: settings.provider,
      apiBaseUrl: settings.apiBaseUrl,
      apiModel: settings.apiModel,
      apiKey: settings.apiKey,
    };
    settings.provider = els.setProvider.value;
    settings.apiBaseUrl = els.setBaseUrl.value.trim();
    settings.apiModel = els.setModel.value.trim();
    settings.apiKey = els.setApiKey.value.trim();
    // 兜底校验：避免下拉框值异常（如 localStorage 被改坏）时写入非法配置导致对局卡死
    const diff = +els.setDifficulty.value;
    settings.difficulty = Number.isFinite(diff) && diff >= 0 && diff <= 4 ? diff : 3;
    settings.playerColor = els.setPlayerColor.value === 'b' ? 'b' : 'r';
    settings.maxUndo = Math.max(0, Math.min(5, +els.setMaxUndo.value || 0));
    settings.aiPersonaId = Personas.get(els.setAiPersona.value).id;
    settings.redPersonaId = Personas.get(els.setRedPersona.value).id;
    settings.blackPersonaId = Personas.get(els.setBlackPersona.value).id;
    const interval = +els.setInterval.value;
    settings.spectateInterval = (interval === 1500 || interval === 3000 || interval === 5000) ? interval : 3000;
    settings.sound = els.setSound.checked;
    settings.commentary = els.setCommentary.checked;
    settings.autoTaunt = els.setAutoTaunt.checked;
    settings.autoReview = els.setAutoReview.checked;
    settings.streaming = els.setStreaming.checked;
    settings.ttsEnabled = els.setTtsEnabled.checked;
    settings.ttsEngine = els.setTtsEngine.value === 'cloud' ? 'cloud' : 'browser';
    settings.ttsBaseUrl = els.setTtsBaseUrl.value.trim();
    settings.ttsApiKey = els.setTtsApiKey.value.trim();
    settings.ttsModel = els.setTtsModel.value.trim() || 'tts-1';
    settings.ttsVoice = els.setTtsVoice.value.trim() || 'alloy';
    if (GameSound) GameSound.setEnabled(settings.sound);
    saveSettings();
    if (Game.state) Game.state.settings.maxUndo = settings.maxUndo; // 悔棋次数即时生效
    updateChatHeader();
    // 换边会改变“该谁走子”，必须重开对局，否则当前局面会卡死
    const needRestart = mode === 'human' && settings.playerColor !== prevPlayerColor;
    if (needRestart) newGame();
    const modelChanged =
      settings.provider !== prevModel.provider ||
      settings.apiBaseUrl !== prevModel.apiBaseUrl ||
      settings.apiModel !== prevModel.apiModel ||
      settings.apiKey !== prevModel.apiKey;
    // 切换模型后当前对局不会自动重开，明确提醒玩家
    if (modelChanged && !needRestart) {
      Chat.systemLine('⚙️ 模型配置已更新，点击「重新开始」即可让新模型完整接管当前对局。');
    }
    closeModal('modalSettings');
  }

  /* 人设弹窗 */
  let editingPersona = null;   // {id|null, isPreset}
  function renderPersonaList() {
    const box = els.personaList;
    box.innerHTML = '';
    Personas.getAll().forEach(p => {
      const div = document.createElement('div');
      div.className = 'p-item' + (editingPersona && editingPersona.id === p.id ? ' active' : '');
      div.innerHTML = `<span>${escapeHtml(p.emoji)}</span><span>${escapeHtml(p.name)}</span>` +
        `<span class="tag">${Personas.isPreset(p.id) ? '预设' : '自定义'}</span>`;
      div.addEventListener('click', () => selectPersona(p.id));
      box.appendChild(div);
    });
  }
  function selectPersona(id) {
    const p = Personas.get(id);
    editingPersona = { id: p.id, isPreset: Personas.isPreset(p.id) };
    els.pName.value = p.name;
    els.pEmoji.value = p.emoji;
    els.pDesc.value = p.desc;
    els.pStyle.value = p.style;
    els.pTaunt.value = p.taunt;
    els.pTauntVal.textContent = p.taunt + '/10';
    els.pTalk.value = p.talkative;
    els.pTalkVal.textContent = p.talkative + '/10';
    els.pExtra.value = p.extra || '';
    els.btnPDupe.classList.toggle('hidden', !editingPersona.isPreset);
    els.btnPSave.textContent = editingPersona.isPreset ? '💾 保存为副本' : '💾 保存';
    els.btnPDelete.classList.toggle('hidden', editingPersona.isPreset);
    els.personaEditHint.textContent = editingPersona.isPreset
      ? '这是内置预设，保存修改会生成一个新的自定义对手。'
      : '修改后点击保存即可生效。';
    renderPersonaList();
  }
  function readPersonaForm() {
    return {
      name: els.pName.value.trim() || '未命名对手',
      emoji: els.pEmoji.value.trim() || '🤖',
      desc: els.pDesc.value.trim(),
      style: els.pStyle.value,
      taunt: +els.pTaunt.value,
      talkative: +els.pTalk.value,
      extra: els.pExtra.value.trim(),
    };
  }
  function savePersonaForm() {
    const data = readPersonaForm();
    if (!editingPersona) return;
    if (editingPersona.isPreset) {
      const np = Personas.add(Object.assign({}, data, { name: data.name + '·改' }));
      selectPersona(np.id);
    } else if (editingPersona.id) {
      Personas.update(Object.assign({}, data, { id: editingPersona.id }));
      selectPersona(editingPersona.id);
    } else {
      const np = Personas.add(data);
      selectPersona(np.id);
    }
    populatePersonaSelects();
  }

  /* 导出弹窗 */
  function openExport() {
    els.exportText.value = Game.exportPGN();
    openModal('modalExport');
  }

  /* ---------- 下拉框填充 ---------- */
  function populatePersonaSelects() {
    const opts = Personas.getAll()
      .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.emoji)} ${escapeHtml(p.name)}</option>`)
      .join('');
    els.setAiPersona.innerHTML = opts;
    els.setRedPersona.innerHTML = opts;
    els.setBlackPersona.innerHTML = opts;
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    document.querySelectorAll('#modeTabs .tab').forEach(t =>
      t.addEventListener('click', () => setMode(t.dataset.mode)));

    els.piecesLayer.addEventListener('click', e => {
      const rect = $('boardWrap').getBoundingClientRect();
      const cell = cellFromXY(e.clientX - rect.left, e.clientY - rect.top);
      if (cell) handleClick(cell.r, cell.c);
    });

    els.btnRestart.addEventListener('click', () => {
      Chat.abort();
      newGame(); // newGame 内部会中止并废弃进行中的 AI 任务
      if (mode === 'spectate') startSpectate();
    });
    els.btnUndo.addEventListener('click', () => {
      if (mode !== 'human' || aiBusy || undoPending) return;
      const st = Game.state;
      if (!st || st.over) return;
      if (aiController) { aiController.abort(); aiController = null; }
      const steps = undoSteps();
      if (!steps) return;
      if (!Chat.configured()) {
        // 未配置 API Key：不嘲讽不判定，保持原有直接悔棋
        Chat.abort();
        if (!performUndo(steps)) Chat.systemLine('无法悔棋（次数已用尽或暂无历史走法）。');
        return;
      }
      if (!Game.canUndo()) { Chat.systemLine('无法悔棋（次数已用尽或暂无历史走法）。'); return; }
      requestUndo(steps);
    });
    els.btnResign.addEventListener('click', () => {
      if (Game.state.over) return;
      // 认输前记录局面评估（红正黑负 → 换算成玩家视角），供终局差异化复盘
      const raw = Eng.evaluate(Game.state.board);
      const playerScore = playerColor() === RED ? raw : -raw;
      resignContext = {
        tier: playerScore < -150 ? 'losing' : (playerScore > 150 ? 'winning' : 'close'),
        playerScore: Math.round(playerScore),
      };
      Game.resign(playerColor());
      afterMove(false);
    });
    els.btnHint.addEventListener('click', () => {
      if (aiBusy || Game.state.over) return;
      Chat.quickAction('hint');
    });
    els.btnPause.addEventListener('click', () => {
      spectatePaused = !spectatePaused;
      els.btnPause.textContent = spectatePaused ? '▶️ 继续' : '⏸️ 暂停';
      // 若上一 tick 仍在选步（aiBusy），由它完成后自行 schedule，避免重复启动两个 tick
      if (!spectatePaused && mode === 'spectate' && !spectateTimer && !aiBusy) tickSpectate();
    });

    // 顶栏按钮
    els.btnSettings.addEventListener('click', openSettings);
    els.btnPersonas.addEventListener('click', () => {
      editingPersona = null;
      renderPersonaList();
      if (Personas.getAll().length) selectPersona(Personas.getAll()[0].id);
      else { selectPersona('street_king'); }
      openModal('modalPersonas');
    });
    els.btnExport.addEventListener('click', openExport);

    // 设置弹窗
    els.setProvider.addEventListener('change', () => {
      const p = LLM.PROVIDERS.find(x => x.id === els.setProvider.value);
      if (p && p.baseUrl) { els.setBaseUrl.value = p.baseUrl; els.setModel.value = p.model; }
    });
    els.btnTestApi.addEventListener('click', async () => {
      // 用当前表单值测试
      const saved = Object.assign({}, settings);
      settings.apiBaseUrl = els.setBaseUrl.value.trim();
      settings.apiModel = els.setModel.value.trim();
      settings.apiKey = els.setApiKey.value.trim();
      els.apiTestResult.textContent = '⏳ 测试中…';
      els.btnTestApi.disabled = true;
      try {
        const r = await LLM.testConnection();
        els.apiTestResult.textContent = '✅ ' + r;
        els.apiTestResult.style.color = '#6fcf97';
      } catch (e) {
        els.apiTestResult.textContent = '❌ ' + (e.message || e);
        els.apiTestResult.style.color = '#ff9b9b';
      } finally {
        settings = saved;
        els.btnTestApi.disabled = false;
      }
    });
    els.btnSettingsSave.addEventListener('click', saveSettingsFromModal);
    els.btnSettingsCancel.addEventListener('click', () => closeModal('modalSettings'));

    // TTS 试听：临时用当前表单值朗读一句（不落盘）
    els.btnTtsPreview.addEventListener('click', () => {
      const saved = Object.assign({}, settings);
      settings.ttsEngine = els.setTtsEngine.value;
      settings.ttsBaseUrl = els.setTtsBaseUrl.value.trim();
      settings.ttsApiKey = els.setTtsApiKey.value.trim();
      settings.ttsModel = els.setTtsModel.value.trim() || 'tts-1';
      settings.ttsVoice = els.setTtsVoice.value.trim() || 'alloy';
      const persona = Personas.get(settings.aiPersonaId);
      global.TTS.preview(global.TTS.styleVoice(persona.style));
      settings = saved;
    });

    // 人设弹窗
    els.btnPNew.addEventListener('click', () => {
      editingPersona = { id: null, isPreset: false };
      els.pName.value = '';
      els.pEmoji.value = '🤖';
      els.pDesc.value = '';
      els.pStyle.value = 'balanced';
      els.pTaunt.value = 5; els.pTauntVal.textContent = '5/10';
      els.pTalk.value = 5; els.pTalkVal.textContent = '5/10';
      els.pExtra.value = '';
      els.btnPDupe.classList.add('hidden');
      els.btnPSave.textContent = '💾 保存新对手';
      els.btnPDelete.classList.add('hidden');
      els.personaEditHint.textContent = '填写信息后点击保存，创建新的自定义对手。';
      renderPersonaList();
    });
    els.btnPDupe.addEventListener('click', () => {
      const data = readPersonaForm();
      const np = Personas.add(Object.assign({}, data, { name: data.name + '·改' }));
      selectPersona(np.id);
      populatePersonaSelects();
    });
    els.btnPSave.addEventListener('click', savePersonaForm);
    els.btnPDelete.addEventListener('click', () => {
      if (!editingPersona || editingPersona.isPreset) return;
      if (Personas.remove(editingPersona.id)) {
        editingPersona = null;
        renderPersonaList();
        if (Personas.getAll().length) selectPersona(Personas.getAll()[0].id);
        populatePersonaSelects();
      }
    });
    els.btnPersonasClose.addEventListener('click', () => closeModal('modalPersonas'));

    // 导出弹窗
    els.btnExportCopy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(els.exportText.value);
        els.btnExportCopy.textContent = '✅ 已复制';
        setTimeout(() => { els.btnExportCopy.textContent = '📋 复制'; }, 1500);
      } catch (e) {
        els.exportText.select();
        document.execCommand('copy');
      }
    });
    els.btnExportDownload.addEventListener('click', () => {
      const blob = new Blob(['\ufeff' + els.exportText.value], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '象棋棋谱_' + new Date().toISOString().slice(0, 10) + '.txt';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    els.btnExportClose.addEventListener('click', () => closeModal('modalExport'));

    // 点击遮罩关闭弹窗
    document.querySelectorAll('.modal').forEach(m => {
      m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
    });

    window.addEventListener('resize', () => { drawBoard(); renderBoard(); });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    cacheEls();
    Chat.init({
      messages: els.chatMessages,
      input: els.chatInput,
      sendBtn: els.btnSend,
      stopBtn: els.btnStop,
      quickBtns: document.querySelectorAll('#chatQuick button'),
    });
    Chat.onHint = m => { hintMove = m; renderBoard(); };
    if (GameSound) {
      GameSound.setEnabled(settings.sound !== false);
      // 浏览器要求用户手势后才能出声：第一次点击/按键时解锁音频
      document.addEventListener('pointerdown', () => GameSound.unlock(), { once: true });
      document.addEventListener('keydown', () => GameSound.unlock(), { once: true });
    }
    populatePersonaSelects();
    populateProviderSelect();
    bindEvents();
    drawBoard();
    setMode('human');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
