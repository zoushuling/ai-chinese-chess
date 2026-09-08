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
  const Affinity = global.Affinity;
  const FCTools = global.FCTools;
  const RED = Eng.RED, BLACK = Eng.BLACK;

  const $ = id => document.getElementById(id);
  /** 转义用户可控文本，防止人设名称/头像被当作 HTML 注入 */
  const escapeHtml = s => String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

  /* ---------- 设置 ---------- */
  // 单组 LLM 配置模板：human=人机对手；red/black=观战红/黑 AI（可各自接不同服务商/模型）
  const DEFAULT_LLM_GROUP = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    useFc: true, // Function Calling（走子/悔棋/好感度调分），不支持时自动降级
    // 深度思考两种模式，语义互相独立，均默认关闭（V0.5.3）
    cotGuide: 'off',  // 模式一：本地 CoT 引导（提示词工程）off | brief | standard | deep
    reasoning: 'off', // 模式二：推理模型参数下发 off | low | medium | high
  };
  const DEFAULT_SETTINGS = {
    llm: {
      human: Object.assign({}, DEFAULT_LLM_GROUP),
      red: Object.assign({}, DEFAULT_LLM_GROUP),
      black: Object.assign({}, DEFAULT_LLM_GROUP),
    },
    llmTimeout: 60,             // LLM 请求超时（秒）；深度思考开启时强制 ≥90s
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
    showDiagnostics: false, // 显示 LLM 诊断：LLM 失败/降级时在聊天里提示原因（默认关保持沉浸感）
    sound: true,
    ttsEnabled: true,
    ttsEngine: 'browser',
    ttsBaseUrl: '',
    ttsApiKey: '',
    ttsModel: 'tts-1',
    ttsVoice: 'alloy',
    ttsProvider: 'openai',   // 云端 TTS 服务商预设
    ttsBrowserVoice: 'auto', // 浏览器引擎默认音色（'auto' = 自动选择）
  };
  const LS_SETTINGS = 'aixq_settings';
  const LEGACY_LLM_KEYS = ['provider', 'apiBaseUrl', 'apiModel', 'apiKey', 'useFunctionCalling'];
  /** 规整 llm 配置组：补齐缺失字段、剔除脏值（localStorage 可能被篡改/半迁移） */
  function normalizeLlm(llm) {
    const out = {};
    ['human', 'red', 'black'].forEach(k => {
      const src = (llm && typeof llm === 'object' && llm[k] && typeof llm[k] === 'object') ? llm[k] : {};
      out[k] = {
        provider: typeof src.provider === 'string' ? src.provider : DEFAULT_LLM_GROUP.provider,
        baseUrl: typeof src.baseUrl === 'string' ? src.baseUrl : DEFAULT_LLM_GROUP.baseUrl,
        model: typeof src.model === 'string' ? src.model : DEFAULT_LLM_GROUP.model,
        apiKey: typeof src.apiKey === 'string' ? src.apiKey : '',
        useFc: src.useFc !== false,
        cotGuide: (src.cotGuide === 'brief' || src.cotGuide === 'standard' || src.cotGuide === 'deep') ? src.cotGuide : 'off',
        reasoning: (src.reasoning === 'low' || src.reasoning === 'medium' || src.reasoning === 'high') ? src.reasoning : 'off',
      };
    });
    return out;
  }
  let settings = loadSettings();
  function loadSettings() {
    let st;
    try {
      const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null') || {};
      // 过滤危险键，防止被篡改的 localStorage 污染原型（__proto__/constructor/prototype）
      const clean = {};
      for (const k of Object.keys(s)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        clean[k] = s[k];
      }
      st = Object.assign({}, DEFAULT_SETTINGS, clean);
      st.llm = normalizeLlm(clean.llm);
      // 旧版（≤V0.3.x）单套全局 LLM 配置迁移：复制到三组，升级后行为不变；
      // 仅当用户尚未产生新结构（clean.llm 缺失）时执行，防止降级安装反噬新配置
      if (!clean.llm && LEGACY_LLM_KEYS.some(k => clean[k] != null)) {
        const legacy = {
          provider: typeof clean.provider === 'string' ? clean.provider : st.llm.human.provider,
          baseUrl: clean.apiBaseUrl || st.llm.human.baseUrl,
          model: clean.apiModel || st.llm.human.model,
          apiKey: clean.apiKey || '',
          useFc: clean.useFunctionCalling !== false,
        };
        st.llm = {
          human: Object.assign({}, legacy),
          red: Object.assign({}, legacy),
          black: Object.assign({}, legacy),
        };
      }
    } catch (e) {
      st = Object.assign({}, DEFAULT_SETTINGS);
      st.llm = normalizeLlm(null);
    }
    // 平铺旧键一律清除（已被 llm 三组结构取代），避免新旧两份配置打架
    LEGACY_LLM_KEYS.forEach(k => delete st[k]);
    return st;
  }
  function saveSettings() { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* ignore */ } }
  global.AppSettings = {
    get: () => settings,
    set(s) {
      s = s || {};
      const patch = Object.assign({}, s);
      // 兼容旧版平铺 LLM 键：写入时归一到 llm.human（仅迁移出现的键，不覆盖其他字段）
      if (LEGACY_LLM_KEYS.some(k => k in patch)) {
        const g = Object.assign({}, settings.llm.human);
        if (typeof patch.provider === 'string') g.provider = patch.provider;
        if (typeof patch.apiBaseUrl === 'string') g.baseUrl = patch.apiBaseUrl;
        if (typeof patch.apiModel === 'string') g.model = patch.apiModel;
        if (typeof patch.apiKey === 'string') g.apiKey = patch.apiKey;
        if (patch.useFunctionCalling != null) g.useFc = patch.useFunctionCalling !== false;
        LEGACY_LLM_KEYS.forEach(k => delete patch[k]);
        settings.llm = Object.assign({}, settings.llm, { human: g });
      }
      // 新结构 llm：整组规整后写入（防止局部合并产生脏字段）
      if (patch.llm && typeof patch.llm === 'object') {
        settings.llm = normalizeLlm(Object.assign({}, settings.llm, patch.llm));
        delete patch.llm;
      }
      settings = Object.assign(settings, patch);
      saveSettings();
      // 设置变更入日志（V0.5.1；llm 整组变更记 keys='llm'）
      const L = global.Logger;
      if (L) {
        const ks = Object.keys(patch).filter(k => k !== '__proto__' && k !== 'constructor' && k !== 'prototype');
        L.info('settings', 'change', { keys: ks.length ? ks.join(',') : 'llm' });
      }
    },
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
    // 设置弹窗容器与页签
    'settingsTabs', 'paneGeneral', 'paneHuman', 'paneSpectate', 'paneLogs',
    'logFilterCat', 'logFilterLevel', 'logList', 'logCount', 'btnLogClear', 'btnLogExport',
    'setShowDiagnostics',
    // 三组 LLM 表单（人机/红方/黑方） + 各自的测试按钮与结果
    // 深度思考两种模式，各为单选组：容器 id + 档位 radio
    //   模式一 CoT 引导：setXCot{Off,Brief,Standard,Deep}
    //   模式二 推理模型：setXReasoning{Off,Low,Medium,High}
    'setHumanProvider', 'setHumanBaseUrl', 'setHumanModel', 'setHumanApiKey', 'setHumanUseFc',
    'setHumanCot', 'setHumanCotOff', 'setHumanCotBrief', 'setHumanCotStandard', 'setHumanCotDeep',
    'setHumanReasoning', 'setHumanReasoningOff', 'setHumanReasoningLow', 'setHumanReasoningMedium', 'setHumanReasoningHigh',
    'btnTestHumanApi', 'apiHumanTestResult',
    'setRedProvider',   'setRedBaseUrl',   'setRedModel',   'setRedApiKey',   'setRedUseFc',
    'setRedCot', 'setRedCotOff', 'setRedCotBrief', 'setRedCotStandard', 'setRedCotDeep',
    'setRedReasoning', 'setRedReasoningOff', 'setRedReasoningLow', 'setRedReasoningMedium', 'setRedReasoningHigh',
    'btnTestRedApi',   'apiRedTestResult',
    'setBlackProvider', 'setBlackBaseUrl', 'setBlackModel', 'setBlackApiKey', 'setBlackUseFc',
    'setBlackCot', 'setBlackCotOff', 'setBlackCotBrief', 'setBlackCotStandard', 'setBlackCotDeep',
    'setBlackReasoning', 'setBlackReasoningOff', 'setBlackReasoningLow', 'setBlackReasoningMedium', 'setBlackReasoningHigh',
    'btnTestBlackApi', 'apiBlackTestResult',
    // 一般设置字段（页签"一般设置"）
    'setAiPersona', 'setPlayerColor', 'setDifficulty', 'setMaxUndo',
    'setLlmTimeout', 'setLlmTimeout30', 'setLlmTimeout60', 'setLlmTimeout90', 'setLlmTimeout120', 'setLlmTimeout180',
    'setRedPersona', 'setBlackPersona', 'setInterval', 'setSound', 'setCommentary', 'setAutoTaunt', 'setAutoReview', 'setStreaming',
    'setTtsEnabled', 'setTtsEngine', 'setTtsProvider', 'setTtsBrowserVoice', 'setTtsBaseUrl', 'setTtsApiKey', 'setTtsModel', 'setTtsVoice', 'cloudVoiceList', 'btnTtsPreview', 'ttsPreviewResult',
    'btnSettingsSave', 'btnSettingsCancel',
    'modalPersonas', 'personaList', 'pName', 'pEmoji', 'pDesc', 'pStyle', 'pVoice', 'pTaunt', 'pTauntVal', 'pTalk', 'pTalkVal', 'pExtra',
    'btnPNew', 'btnPDupe', 'btnPSave', 'btnPDelete', 'personaEditHint', 'btnPersonasClose',
    'modalExport', 'exportText', 'btnExportCopy', 'btnExportDownload', 'btnExportClose',
    'btnHelp', 'modalHelp', 'btnHelpClose',
    'modalConfirm', 'confirmText', 'btnConfirmYes', 'btnConfirmNo',
    'affinityBadge', 'affinityList', 'btnAffinityResetAll',
    'btnSettings', 'btnPersonas', 'btnExport'];
  function cacheEls() { IDS.forEach(id => els[id] = $(id)); }

  /* ---------- 深度思考两种模式的单选组读写（radio 组无法像 select 那样整体 .value） ----------
   * 模式一 CoT 引导（本地提示词脚手架）：off | brief | standard | deep
   * 模式二 推理模型（供应商原生思考通道）：off | low | medium | high
   * 两者语义独立、各自持久化，不互相覆盖。
   */
  const R_LEVELS = ['off', 'low', 'medium', 'high'];
  const COT_LEVELS = ['off', 'brief', 'standard', 'deep'];

  /** radio 组元素 id；group 传 'Reasoning' | 'Cot' */
  const radioId = (profile, group, lv) => {
    const k = profile.charAt(0).toUpperCase() + profile.slice(1);
    return 'set' + k + group + lv.charAt(0).toUpperCase() + lv.slice(1);
  };
  /** 读某组当前选中档位（未选中任何档回落 off） */
  function radioValue(profile, group, levels) {
    const hit = levels.find(lv => { const el = els[radioId(profile, group, lv)]; return el && el.checked; });
    return hit || 'off';
  }
  /** 按档位点亮某组 radio */
  function setRadio(profile, group, levels, val) {
    levels.forEach(lv => {
      const el = els[radioId(profile, group, lv)];
      if (el) el.checked = (lv === val);
    });
  }
  const reasoningRadioId = (profile, lv) => radioId(profile, 'Reasoning', lv);
  function reasoningValue(profile) { return radioValue(profile, 'Reasoning', R_LEVELS); }
  function setReasoningRadio(profile, val) { setRadio(profile, 'Reasoning', R_LEVELS, val); }
  function cotValue(profile) { return radioValue(profile, 'Cot', COT_LEVELS); }
  function setCotRadio(profile, val) { setRadio(profile, 'Cot', COT_LEVELS, val); }

  /* ---------- LLM 请求超时档位（5 档单选，对应秒数） ---------- */
  const TIMEOUT_LEVELS = [30, 60, 90, 120, 180];
  /** 当前选中档位的秒数（未选中回落默认 60） */
  function timeoutValue() {
    const hit = TIMEOUT_LEVELS.find(v => els['setLlmTimeout' + v] && els['setLlmTimeout' + v].checked);
    return hit || 60;
  }
  /** 回填单选组；存量配置值不在档位内时就近取档（45 → 60） */
  function setTimeoutRadio(sec) {
    const n = Number.isFinite(+sec) ? +sec : 60;
    const nearest = TIMEOUT_LEVELS.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), TIMEOUT_LEVELS[0]);
    TIMEOUT_LEVELS.forEach(v => {
      const el = els['setLlmTimeout' + v];
      if (el) el.checked = (v === nearest);
    });
  }

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
    // 走子步进悔棋惩罚窗口（4 步后自动解除；必须在任何好感度调分之前）
    if (Affinity) Affinity.tickPenalties();
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
      const no = document.createElement('span');
      no.className = 'no';
      no.textContent = Math.floor(i / 2) + 1 + '.';
      span.appendChild(no);
      span.appendChild(document.createTextNode((i % 2 === 0 ? '红' : '黑') + h.notation));
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
    // 当前说话的会话槽：人机=对手槽（human）；观战=刚走棋的一方（红/黑槽）。
    // 槽决定人设、执子身份与 LLM 配置组，后续 send/解说/复盘均跟随
    Chat.use(mode === 'human' ? 'human' : (lastMover === RED ? 'red' : 'black'));
    const fen = Eng.toFEN(st.board, st.turn);
    const ctx = {
      board: st.board, turn: st.turn, fen,
      evalSummary: Eng.evalSummary(st.board),
      topMoves: [],
      lastMoveNotation: last ? last.notation : null,
      lastMove: last ? last.move : null,
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
      // 好感度徽标（人机模式显示当前对手好感度）
      if (Affinity && els.affinityBadge) {
        const v = Affinity.get(settings.aiPersonaId);
        els.affinityBadge.textContent = `💗 ${v}`;
        els.affinityBadge.classList.remove('hidden');
        els.affinityBadge.title = `好感度 ${v}/100（${Affinity.tierLabel(v)}）`;
      }
    } else {
      const r = Personas.get(settings.redPersonaId);
      const b = Personas.get(settings.blackPersonaId);
      els.chatOpponent.textContent = `🎬 观战：红 ${r.emoji}${r.name} vs 黑 ${b.emoji}${b.name}`;
      if (els.affinityBadge) els.affinityBadge.classList.add('hidden'); // 观战不启用好感度
    }
  }

  /* ---------- 好感度：调分回调（UI 更新 + 系统提示）与设置弹窗列表 ---------- */
  function onAffinityChange(info) {
    if (!info) return;
    updateChatHeader();
    renderAffinityList();
    if (info.all) return; // 全部重置：不逐条提示
    if (info.delta && Chat && typeof Chat.systemLine === 'function' && info.personaId) {
      const p = Personas.get(info.personaId);
      const who = p ? `${p.emoji} ${p.name}` : '对手';
      const sign = info.delta > 0 ? '+' : '−';
      Chat.systemLine(`💗 ${who} 好感度 ${sign}${Math.abs(info.delta)}：当前 ${info.after}/100`);
    }
  }
  function renderAffinityList() {
    const box = els.affinityList;
    if (!box || !Affinity) return;
    box.innerHTML = '';
    Personas.getAll().forEach(p => {
      const v = Affinity.get(p.id);
      const row = document.createElement('div');
      row.className = 'affinity-item';
      const name = document.createElement('span');
      name.className = 'affinity-name';
      name.textContent = p.emoji + ' ' + p.name;
      const tier = document.createElement('span');
      tier.className = 'affinity-tier';
      tier.textContent = Affinity.tierLabel(v);
      const val = document.createElement('span');
      val.className = 'affinity-val';
      val.textContent = String(v);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mini';
      btn.textContent = '重置';
      btn.addEventListener('click', () => {
        Affinity.reset(p.id);
        renderAffinityList();
        updateChatHeader();
      });
      row.appendChild(name); row.appendChild(tier); row.appendChild(val); row.appendChild(btn);
      box.appendChild(row);
    });
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
    // LLM 配置组：人机=human；观战=走子方对应组（红/黑可独立配置不同服务商/模型）
    const profile = mode === 'human' ? 'human' : (turn === RED ? 'red' : 'black');
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
    const cfg = LLM.getConfig(profile);
    if (!cfg.apiKey || !cfg.model || !cfg.baseUrl) {
      return { move: top.move, thought: null, notation: top.notation };
    }
    const sideName = turn === RED ? '红' : '黑';
    const oppSideName = turn === RED ? '黑' : '红';
    // —— 候选走法列表：所有字段定长，同局面下字符串完全一致 → 走子回到同局面时 list 字符级命中
    const list = res.candidates.map((c, i) => {
      const idxStr = String(i + 1).padStart(2, '0');                 // 编号定长 2 位
      const sign = c.score >= 0 ? '+' : '-';                          // 符号定长 1 位
      const scoreStr = sign + String(Math.abs(Math.round(c.score))).padStart(4, ' '); // 评分定长 5 位（含符号）
      const coord = String(c.coord).padEnd(4, ' ');                   // 坐标定长 4 位
      let cap = '';
      if (c.move.captured) {
        const capColor = turn === RED ? BLACK : RED;
        cap = ` 可吃${oppSideName}方${Eng.PIECE_NAME[c.move.captured][capColor === RED ? 0 : 1]}`;
      }
      return `${idxStr}. ${c.notation.padEnd(4, ' ')}(${coord} 评分${scoreStr})${cap}`;
    }).join('\n');
    const pickRule = freeChoice
      ? '当前棋力档位：LLM 自由选择。可在候选走法中任意选择：想赢选高分，想留情/斗气选低分（但别直接送将）。'
      : '当前棋力档位：引擎推荐。请结合你的人设挑选一步，不要超出候选列表。';
    // —— 好感度提示：统一三档同句式（数字 padStart 3 位、tier 单字、tip 等长）
    // 这样跨档切换时字符差异最小，前缀缓存更稳
    const affPack = (freeChoice && mode === 'human' && Affinity)
      ? (() => {
          const av = Affinity.get(settings.aiPersonaId);
          const tier = av >= 80 ? '高' : av < 30 ? '低' : '中';
          const tip  = av >= 80 ? '可适度放水或留情，别送将'
                       : av < 30 ? '可按心情下狠手'
                                  : '正常发挥即可';
          return `【好感度】${String(av).padStart(3, ' ')}/100（${tier}）。${tip}。`;
        })()
      : `【好感度】 n/a 。            （观战/固定档不启用）。`;
    // —— 模式一：本地 CoT 引导脚手架（内容只由档位决定，跨回合恒定）
    //    放在 affPack 之前：好感度每回合会变，放在它前面才能保住前缀缓存命中
    const cotBlock = LLM.buildCoTGuide ? LLM.buildCoTGuide(cfg.cotGuide, 'move') : null;
    // CoT 开启时给 thought 留 token 预算（思考要点要占输出，否则会截断最终选择）
    const cotExtra = cfg.cotGuide === 'deep' ? 160 : cfg.cotGuide === 'standard' ? 110 : cfg.cotGuide === 'brief' ? 70 : 0;
    // —— sys 头部：人设头 + 任务/输出格式（共享于 Personas）+ CoT 脚手架 + 好感度
    const sysHead =
      `你是象棋 AI 对手。\n\n` +
      `【身份】你扮演「${persona.name}」${persona.emoji}，执${sideName}方。\n` +
      `${persona.desc}\n` +
      `${Personas.styleText(persona)}\n\n` +
      `${Personas.systemHead(persona)}\n\n` +
      (cotBlock ? cotBlock + '\n\n' : '') +
      affPack + '\n';
    // —— user 段：易变的局面 + 候选 + 选子规则（user 不进 prefix cache，无须顾虑长度稳定）
    const userHead =
      `现在轮到你（${sideName}方）走子，对手执${oppSideName}方。\n` +
      `局面 FEN：${Eng.toFEN(board, turn)}\n\n`;
    const userTail = `${pickRule}\n\n候选走法（编号 评分越高越强）：\n${list}\n\n请选择走法。`;
    const controller = new AbortController();
    aiController = controller;
    const baseMsgs = [
      { role: 'system', content: sysHead },
      { role: 'user',   content: userHead + userTail },
    ];
    const fcEnabled = !!(FCTools && LLM.requestFull && LLM.fcEnabled(profile) && !FCTools.isFallback(profile));
    try {
      // —— FC 主路径：play_move 工具调用，非法走法回传重试（最多 3 轮）——
      if (fcEnabled) {
        try {
          let msgs = baseMsgs.slice();
          let chosen = null, thought = null;
          for (let round = 0; round < 3; round++) {
            const resp = await LLM.requestFull(msgs, {
              tools: [FCTools.PLAY_MOVE], profile, temperature: 0.4, maxTokens: 180 + cotExtra, signal: controller.signal,
            });
            const tc = (resp.toolCalls || []).find(t => t.name === 'play_move');
            if (!tc) break; // 模型未调用工具 → 走旧 JSON 路径
            chosen = matchMove(res.candidates, tc.args.move);
            thought = tc.args.thought;
            if (chosen) return { move: chosen.move, thought: thought || null, notation: chosen.notation };
            // 非法走法：把校验错误作为工具结果回传，让 LLM 重新选
            msgs = msgs.concat([
              { role: 'assistant', content: null, tool_calls: [{ id: tc.id, type: 'function', function: { name: 'play_move', arguments: JSON.stringify(tc.args) } }] },
              { role: 'tool', tool_call_id: tc.id, content: `走法 ${tc.args.move} 不在候选列表中（非法）。请严格从上面的候选走法中重新调用 play_move，只输出工具调用。` },
            ]);
          }
        } catch (e) {
          if (e.name === 'AbortError') return null;
          if (FCTools.isFcUnsupportedError(e)) {
            FCTools.markFallback(profile);
            if (FCTools.ensureNotified(profile)) Chat.systemLine('⚠️ 当前服务商不支持函数调用，已自动降级为 JSON 模式。');
          }
          // 其他错误（网络/超时）不标记降级，落入旧路径由旧逻辑兜底
        }
      }
      // —— 降级/旧路径：JSON 提取 ——
      let raw = await LLM.request(baseMsgs, { stream: false, profile, temperature: 0.4, maxTokens: 180 + cotExtra, signal: controller.signal });
      let j = LLM.extractJSON(raw);
      let chosen = matchMove(res.candidates, j && j.move);
      if (!chosen) {
        raw = await LLM.request(
          [{ role: 'system', content: sysHead },
          { role: 'user', content: userHead + `你上次的输出无效。请严格只从下面的候选走法中选一个，只输出 JSON：{"move":"坐标","thought":"..."}\n\n${userTail}` }],
          { stream: false, profile, temperature: 0.2, maxTokens: 180 + cotExtra, signal: controller.signal });
        j = LLM.extractJSON(raw);
        chosen = matchMove(res.candidates, j && j.move);
      }
      if (!chosen) {
        // JSON 两轮均无效 → 退回引擎推荐（V0.5.1：入日志 + 可选诊断提示）
        chosen = top;
        const L = global.Logger;
        if (L) L.warn('llm', 'pick_fallback', { profile, reason: 'json 两次无法解析/非法' });
        if (settings.showDiagnostics) Chat.systemLine('⚠️ LLM 返回了无法解析的走法，已改用引擎推荐。');
      }
      return { move: chosen.move, thought: (j && j.thought) || null, notation: chosen.notation };
    } catch (e) {
      if (e.name === 'AbortError') return null;
      // LLM 调用异常 → 引擎兜底（V0.5.1：入日志 + 可选诊断提示，默认静默保持沉浸感）
      const L = global.Logger;
      if (L) L.warn('llm', 'pick_error', { profile, err: (e && e.message) || String(e), fallback: 'engine' });
      if (settings.showDiagnostics) Chat.systemLine('⚠️ LLM 调用失败（' + String((e && e.message) || e).slice(0, 80) + '），已用本地引擎走子。');
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
    Chat.use('human'); // 人机模式：走子/心理活动/后续对话都走对手（human）会话槽
    aiBusy = true;
    els.thinkingTag.classList.remove('hidden');
    const persona = Personas.get(settings.aiPersonaId);
    try {
      const pick = await aiPick(persona, st.board, st.turn);
      if (gen !== stateGen) return; // 期间已重开/切换模式
      const cur = Game.state;
      if (!pick || !cur || cur !== st || cur.over || cur.turn !== st.turn) return; // 状态已变（悔棋/重开）
      if (!Game.applyMove(pick.move)) {
        // 理论极罕见（候选已过滤长将）：引擎拒绝时回退到引擎推荐
        Chat.systemLine('⚠️ 该走法被引擎拒绝，改用引擎推荐。');
        const fb = AI.search(st.board, st.turn, { depth: Math.min(2, settings.difficulty || 3), topN: 3, timeLimit: 400 });
        if (fb.move) Game.applyMove(fb.move);
      }
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

  /* ---------- 对好棋/坏棋的自动反应（V0.5.2） ----------
   * 两级判定：
   *   ① 静态闸门：走子前后 evaluate 之差 ≥150 才进入判定，平淡着法直接跳过（省性能）
   *   ② 搜索复核：用浅搜索量化"这一步相对引擎最优着法的亏损"，
   *      识破"吃子后被反吃"这类静态评估看不出来的坏棋
   * 好感度按复核结果分档：好棋 +3 / 臭棋 -3 / 严重臭棋 -5（与是否出台词无关）
   */
  const REACT_MIN_SWING = 150; // 静态闸门阈值

  /** 找一步与玩家所走不同的引擎推荐着法（用于臭棋时给出替代参考） */
  function findBetterNotation(before, pc, played) {
    try {
      const res = AI.search(before, pc, { depth: Math.min(2, settings.difficulty || 3), topN: 3, timeLimit: 400 });
      const better = (res.candidates || []).find(c =>
        !(c.move.fr === played.fr && c.move.fc === played.fc && c.move.tr === played.tr && c.move.tc === played.tc)
      ) || null;
      return better ? better.notation : null;
    } catch (e) { return null; }
  }

  function maybeReact() {
    if (!settings.autoTaunt) return;
    const st = Game.state;
    if (st.over || st.turn !== aiColor()) return;
    const last = st.history[st.history.length - 1];
    if (!last) return;
    const pc = playerColor();
    const before = Eng.parseFEN(last.preFen).board;
    const e0 = Eng.evaluate(before), e1 = Eng.evaluate(st.board);
    // 玩家视角的局势变化：正=变好，负=变差（只作闸门，不作结论）
    const swing = pc === RED ? e1 - e0 : e0 - e1;
    if (Math.abs(swing) < REACT_MIN_SWING) return; // 平淡着法：不判定也不调分
    if (st.moveCount - lastReactMoveCount < 4) return;
    const persona = Personas.get(settings.aiPersonaId);

    // 复核：静态分差会把"吃子后被反吃"判成好棋，改用浅搜索比对与最优着法的差距
    let loss = null, betterNotation = null, verdict = null;
    try {
      const r = AI.moveLoss(before, st.board, pc, { depth: 2, timeLimit: 200 });
      if (r) {
        loss = r.loss;
        betterNotation = r.best ? r.best.notation : null;
        verdict = AI.classifyLoss(r.loss);
      }
    } catch (e) { /* 搜索异常 → 回退静态判定 */ }
    if (loss == null) {
      // 搜索不可用：退回旧行为（静态分差定性）
      verdict = swing > 0 ? { kind: 'good', delta: +3 } : { kind: 'blunder', delta: -3 };
    }
    if (!verdict) return; // 复核后属"略亏/平淡"：不反应

    if (Affinity) Affinity.adjust(settings.aiPersonaId, verdict.delta);
    if (Math.random() > Math.min(1, persona.taunt / 10 * 0.95)) return;
    lastReactMoveCount = st.moveCount;
    const info = { notation: last.notation, loss: loss, evalGain: Math.round(swing) };
    if (verdict.kind === 'good') {
      Chat.triggerGoodMove(info);
    } else {
      if (!betterNotation) betterNotation = findBetterNotation(before, pc, last.move);
      Chat.triggerTaunt({ notation: last.notation, loss: loss, evalGain: Math.round(swing), betterNotation: betterNotation });
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
    // 观战：走子方会话槽（决定 LLM 配置组、人设与解说身份）
    Chat.use(st.turn === RED ? 'red' : 'black');
    aiBusy = true;
    els.thinkingTag.classList.remove('hidden');
    aiPick(persona, st.board, st.turn).then(pick => {
      if (gen !== stateGen) return; // 旧对局的异步结果，丢弃
      aiBusy = false;
      els.thinkingTag.classList.add('hidden');
      const cur = Game.state;
      if (!cur || cur !== st || cur.over) return;
      if (!pick) { schedule(); return; }
      if (!Game.applyMove(pick.move)) {
        Chat.systemLine('⚠️ 走法被引擎拒绝，本回合跳过。');
        schedule(); return;
      }
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
    if (Affinity) Affinity.clearPenalties(); // 新对局：悔棋惩罚窗口归零
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

  /** 通用确认框：text 为提示内容，onYes 在用户点「立即重开」时执行 */
  function confirmDialog(text, onYes) {
    els.confirmText.textContent = text;
    els.btnConfirmYes.onclick = () => { closeModal('modalConfirm'); if (onYes) onYes(); };
    els.btnConfirmNo.onclick = () => closeModal('modalConfirm');
    openModal('modalConfirm');
  }

  /* 设置弹窗 */
  /** 向指定 select 注入 LLM 服务商预设（OpenAI 兼容格式）。 */
  function fillProviderOptions(sel) {
    if (!sel) return;
    sel.innerHTML = '';
    LLM.PROVIDERS.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    });
  }
  /** 向指定 select 注入 LLM 服务商预设（OpenAI 兼容格式），被下方三个 useFc 分支复用 */
  function populateAllProviderSelects() {
    fillProviderOptions(els.setHumanProvider);
    fillProviderOptions(els.setRedProvider);
    fillProviderOptions(els.setBlackProvider);
  }
  /** 选中 provider 预设即自动填 Base URL 与模型（按 profile 路由到对应三个输入框） */
  function bindProviderAutoFill(sel, baseUrlEl, modelEl) {
    if (!sel || !baseUrlEl || !modelEl) return;
    sel.addEventListener('change', () => {
      const p = LLM.PROVIDERS.find(x => x.id === sel.value);
      if (p && p.baseUrl) { baseUrlEl.value = p.baseUrl; modelEl.value = p.model; }
    });
  }
  /** 推理模型 × 函数调用联动警示：开推理且模型名可嗅探为推理形态时，提示 FC 将自动降级 */
  function updateFcWarnings() {
    ['human', 'red', 'black'].forEach(p => {
      const key = p.charAt(0).toUpperCase() + p.slice(1);
      const warn = els['fcWarn' + key];
      if (!warn) return;
      const model = String(els['set' + key + 'Model'].value || '');
      const reasoning = reasoningValue(p);
      const on = reasoning !== 'off';
      // 已知与 Function Calling 不兼容或不可靠的推理形态
      const reasoner = /reasoner/.test(model) || /(^|[-_])o[13](-|$)|^o3|gpt-5/.test(model);
      warn.classList.toggle('hidden', !(on && reasoner));
    });
  }
  function openSettings() {
    refreshVoiceSelects();
    populateTtsProvider();
    refreshCloudVoices();
    renderAffinityList();
    // 三组 LLM 互不污染：分别填到各自字段
    populateAllProviderSelects();
    const llm = settings.llm;
    els.setHumanProvider.value = llm.human.provider;
    els.setHumanBaseUrl.value = llm.human.baseUrl || '';
    els.setHumanModel.value = llm.human.model || '';
    els.setHumanApiKey.value = llm.human.apiKey || '';
    els.setHumanUseFc.checked = llm.human.useFc !== false;
    setCotRadio('human', llm.human.cotGuide);
    setReasoningRadio('human', llm.human.reasoning);
    els.setRedProvider.value = llm.red.provider;
    els.setRedBaseUrl.value = llm.red.baseUrl || '';
    els.setRedModel.value = llm.red.model || '';
    els.setRedApiKey.value = llm.red.apiKey || '';
    els.setRedUseFc.checked = llm.red.useFc !== false;
    setCotRadio('red', llm.red.cotGuide);
    setReasoningRadio('red', llm.red.reasoning);
    els.setBlackProvider.value = llm.black.provider;
    els.setBlackBaseUrl.value = llm.black.baseUrl || '';
    els.setBlackModel.value = llm.black.model || '';
    els.setBlackApiKey.value = llm.black.apiKey || '';
    els.setBlackUseFc.checked = llm.black.useFc !== false;
    setCotRadio('black', llm.black.cotGuide);
    setReasoningRadio('black', llm.black.reasoning);
    setTimeoutRadio(settings.llmTimeout != null ? settings.llmTimeout : 60);
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
    els.setTtsBrowserVoice.value = settings.ttsBrowserVoice || 'auto';
    // 清空三组测试结果
    els.apiHumanTestResult.textContent = '';
    els.apiRedTestResult.textContent = '';
    els.apiBlackTestResult.textContent = '';
    els.apiHumanTestResult.style.color = '';
    els.apiRedTestResult.style.color = '';
    els.apiBlackTestResult.style.color = '';
    updateFcWarnings();
    if (els.setShowDiagnostics) els.setShowDiagnostics.checked = settings.showDiagnostics === true;
    renderLogs();
    openModal('modalSettings');
    // 打开时回到"一般设置"页签（避免上次停在 LLM 页签被误改）
    if (global.SettingsTabs && els.settingsTabs && els.paneGeneral && els.paneHuman && els.paneSpectate && els.paneLogs) {
      global.SettingsTabs.init({
        tabsRoot: els.settingsTabs,
        panes: { general: els.paneGeneral, human: els.paneHuman, spectate: els.paneSpectate, logs: els.paneLogs },
        initial: 'general',
      });
    }
  }

  /* ---------- 运行日志面板（V0.5.1） ---------- */
  /** 渲染日志列表（受面板筛选控制；最多展示 200 条，新→旧） */
  function renderLogs() {
    if (!els.logList || !global.Logger) return;
    const cat = els.logFilterCat ? els.logFilterCat.value : '';
    const level = els.logFilterLevel ? els.logFilterLevel.value : '';
    const rows = global.Logger.all({ cat: cat || undefined, level: level || undefined, limit: 200 });
    if (els.logCount) els.logCount.textContent = '共 ' + rows.length + ' 条' + (rows.length >= 200 ? '（截断）' : '');
    if (!rows.length) {
      els.logList.innerHTML = '<div class="log-empty">（暂无日志）</div>';
      return;
    }
    const pad2 = n => String(n).padStart(2, '0');
    els.logList.innerHTML = rows.map(e => {
      const d = new Date(e.ts);
      const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
      const fieldStr = Object.keys(e).filter(k => k !== 'ts' && k !== 'cat' && k !== 'level' && k !== 'ev')
        .map(k => ' ' + k + '=' + escapeHtml(String(e[k]))).join('');
      return '<div class="log-entry lv-' + e.level + '">' +
        '<span class="lvl">[' + e.level + ']</span> <b>' + e.cat + '</b> ' + escapeHtml(e.ev) +
        '<span class="muted-log">' + fieldStr + '</span></div>';
    }).join('');
  }
  function bindLogPanel() {
    if (!global.Logger) return;
    ['logFilterCat', 'logFilterLevel'].forEach(id => {
      const el = els[id];
      if (el) el.addEventListener('change', renderLogs);
    });
    if (els.btnLogClear) els.btnLogClear.addEventListener('click', () => {
      global.Logger.clear();
      renderLogs();
    });
    if (els.btnLogExport) els.btnLogExport.addEventListener('click', () => {
      const text = global.Logger.export();
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'aixq-logs-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
      if (typeof a.click === 'function') a.click();
      URL.revokeObjectURL(a.href);
    });
  }
  function saveSettingsFromModal() {
    // 三组 LLM 各自独立：人机对手 / 观战红方 / 观战黑方，互不污染
    settings.llm.human = {
      provider: els.setHumanProvider.value,
      baseUrl: els.setHumanBaseUrl.value.trim(),
      model: els.setHumanModel.value.trim(),
      apiKey: els.setHumanApiKey.value.trim(),
      useFc: els.setHumanUseFc.checked,
      cotGuide: cotValue('human'),
      reasoning: reasoningValue('human'),
    };
    settings.llm.red = {
      provider: els.setRedProvider.value,
      baseUrl: els.setRedBaseUrl.value.trim(),
      model: els.setRedModel.value.trim(),
      apiKey: els.setRedApiKey.value.trim(),
      useFc: els.setRedUseFc.checked,
      cotGuide: cotValue('red'),
      reasoning: reasoningValue('red'),
    };
    settings.llm.black = {
      provider: els.setBlackProvider.value,
      baseUrl: els.setBlackBaseUrl.value.trim(),
      model: els.setBlackModel.value.trim(),
      apiKey: els.setBlackApiKey.value.trim(),
      useFc: els.setBlackUseFc.checked,
      cotGuide: cotValue('black'),
      reasoning: reasoningValue('black'),
    };
    // 同步每组降级状态：关闭 FC 直接进入降级；重新开启时恢复 FC
    if (global.FCTools) {
      ['human', 'red', 'black'].forEach(p => {
        if (settings.llm[p].useFc) global.FCTools.resetFallback(p);
        else global.FCTools.markFallback(p);
      });
    }
    // 兜底校验：避免下拉框值异常（如 localStorage 被改坏）时写入非法配置导致对局卡死
    const diff = +els.setDifficulty.value;
    settings.difficulty = Number.isFinite(diff) && diff >= 0 && diff <= 4 ? diff : 3;
    settings.llmTimeout = timeoutValue();
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
    settings.showDiagnostics = els.setShowDiagnostics ? els.setShowDiagnostics.checked === true : false;
    settings.ttsEnabled = els.setTtsEnabled.checked;
    settings.ttsEngine = els.setTtsEngine.value === 'cloud' ? 'cloud' : 'browser';
    settings.ttsBaseUrl = els.setTtsBaseUrl.value.trim();
    settings.ttsApiKey = els.setTtsApiKey.value.trim();
    settings.ttsModel = els.setTtsModel.value.trim() || 'tts-1';
    settings.ttsVoice = els.setTtsVoice.value.trim() || 'alloy';
    settings.ttsProvider = els.setTtsProvider.value || 'openai';
    settings.ttsBrowserVoice = els.setTtsBrowserVoice.value || 'auto';
    if (GameSound) GameSound.setEnabled(settings.sound);
    saveSettings();
    if (Game.state) Game.state.settings.maxUndo = settings.maxUndo; // 悔棋次数即时生效
    updateChatHeader();
    closeModal('modalSettings');
    // 统一确认：改动已保存，能即时生效的（难度/人设/悔棋等）后续自动生效；
    // 换边/换模型等需重开才能完整应用，由用户决定是否立即重开
    confirmDialog('设置已保存。部分设置（如换边、模型）需要重新开始对局才能完整生效，是否现在重新开始？', () => { newGame(); });
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
    els.pVoice.value = p.voice || '';
    els.pTaunt.value = p.taunt;
    els.pTauntVal.textContent = p.taunt + '/10';
    els.pTalk.value = p.talkative;
    els.pTalkVal.textContent = p.talkative + '/10';
    els.pExtra.value = p.extra || '';
    autosizeTextarea(els.pDesc);   // 长描述自动撑高，全文可见
    autosizeTextarea(els.pExtra);
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
      voice: els.pVoice.value,
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
    closeModal('modalPersonas');
    // 人设已保存即生效（下一步 AI 发言/走子即用新设定）；是否重开由用户决定
    confirmDialog('人设已保存，对局将在下一步使用新设定。是否立即重新开始一局？', () => { newGame(); });
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

  /* ---------- 音色下拉填充 ---------- */
  /** 精简浏览器音色显示名：去掉 "Microsoft/Google" 前缀、"Online (Natural)" 与 "- Chinese (Mainland)" 等冗长后缀 */
  function shortVoiceName(name) {
    return String(name)
      .replace(/^Microsoft /i, '')
      .replace(/^Google /i, '')
      .replace(/\s*Online( \(Natural\))?/i, '')
      .replace(/\s*-\s*(Chinese|普通话|中文).*$/i, '');
  }
  function refreshVoiceSelects() {
    // 设置弹窗：浏览器引擎的全局默认音色
    const cur = els.setTtsBrowserVoice.value || settings.ttsBrowserVoice || 'auto';
    const browserOpts = (global.TTS && global.TTS.getBrowserVoices() || [])
      .map(v => `<option value="${escapeHtml(v.name)}">${escapeHtml(shortVoiceName(v.name))}</option>`)
      .join('');
    els.setTtsBrowserVoice.innerHTML = '<option value="auto">自动选择</option>' + browserOpts;
    els.setTtsBrowserVoice.value = cur;

    // 人设弹窗：全局默认 + 浏览器音色 + 云端预设音色
    const pCur = els.pVoice.value || '';
    const cloudOpts = (global.TTS && global.TTS.getAllPresetVoices() || [])
      .map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}（云端）</option>`)
      .join('');
    els.pVoice.innerHTML = '<option value="">跟随全局默认</option>' +
      '<optgroup label="浏览器音色">' + browserOpts + '</optgroup>' +
      '<optgroup label="云端音色">' + cloudOpts + '</optgroup>';
    els.pVoice.value = pCur;
  }

  /* ---------- 文本域自动增高（内容多时不用内部滚动，全部可见） ---------- */
  function autosizeTextarea(el) {
    if (!el || !el.style || typeof el.scrollHeight !== 'number') return;
    el.style.height = 'auto';
    el.style.height = Math.max(36, el.scrollHeight) + 'px';
  }

  /* ---------- TTS 服务商下拉与音色提示 ---------- */
  function populateTtsProvider() {
    const opts = (global.TTS && global.TTS.getProviders() || [])
      .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
      .join('');
    els.setTtsProvider.innerHTML = opts;
    els.setTtsProvider.value = settings.ttsProvider || 'openai';
  }
  /** 按当前服务商刷新云端音色候选（datalist） */
  function refreshCloudVoices() {
    const p = (global.TTS && global.TTS.getProvider(els.setTtsProvider.value || settings.ttsProvider)) || null;
    const voices = (p && p.voices) || [];
    els.cloudVoiceList.innerHTML = voices.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
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
      // 每次悔棋请求即扣 1 点好感度，并启动惩罚窗口（4 步内只减不加，
      // 防止悔棋 -1 被紧接着的好棋/礼貌/LLM 加分立即抵消）
      if (Affinity) {
        const pid = (Chat.currentPersona && Chat.ctx) ? Chat.currentPersona().id : settings.aiPersonaId;
        if (pid) {
          Affinity.adjust(pid, -1);
          Affinity.startUndoPenalty(pid);
        }
      }
      if (!Chat.configured()) {
        // 未配置 API Key：不嘲讽不判定，保持原有直接悔棋（好感度已扣）
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
      // 暂停期间定时器触发后会残留已过期的 id（tickSpectate 早退不清除），
      // 恢复时必须先 stopSpectate() 清掉它，否则 !spectateTimer 判假导致观战永久停摆
      if (!spectatePaused && mode === 'spectate') {
        stopSpectate();
        // 若上一 tick 仍在选步（aiBusy），由它完成后自行 schedule，避免重复启动两个 tick
        if (!aiBusy) tickSpectate();
      }
    });

    // 顶栏按钮
    els.btnHelp.addEventListener('click', () => openModal('modalHelp'));
    els.btnHelpClose.addEventListener('click', () => closeModal('modalHelp'));
    els.btnSettings.addEventListener('click', openSettings);
    // 未捕获错误/未处理 Promise 拒绝 → 日志（V0.5.1）
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('error', ev => {
        const L = globalThis.Logger;
        if (!L) return;
        const m = (ev && ev.message) || (ev && ev.error && ev.error.message) || '';
        L.error('error', 'window_error', { msg: m || 'unknown' });
      });
      globalThis.addEventListener('unhandledrejection', ev => {
        const L = globalThis.Logger;
        if (!L) return;
        const r = ev && ev.reason;
        L.error('error', 'unhandled_rejection', { msg: String((r && r.message) || r || '').slice(0, 200) });
      });
    }
    els.btnPersonas.addEventListener('click', () => {
      editingPersona = null;
      refreshVoiceSelects(); // 人设音色下拉需要最新语音列表
      renderPersonaList();
      if (Personas.getAll().length) selectPersona(Personas.getAll()[0].id);
      else { selectPersona('street_king'); }
      openModal('modalPersonas');
    });
    els.btnExport.addEventListener('click', openExport);
    if (els.btnAffinityResetAll) {
      els.btnAffinityResetAll.addEventListener('click', () => {
        if (!Affinity) return;
        Affinity.resetAll();
        renderAffinityList();
        updateChatHeader();
        Chat.systemLine('💗 所有对手好感度已重置为 50。');
      });
    }

    // 设置弹窗
    // 三组 LLM 表单的 provider 预设联动：选中即填 Base URL / 模型
    bindProviderAutoFill(els.setHumanProvider, els.setHumanBaseUrl, els.setHumanModel);
    bindProviderAutoFill(els.setRedProvider, els.setRedBaseUrl, els.setRedModel);
    bindProviderAutoFill(els.setBlackProvider, els.setBlackBaseUrl, els.setBlackModel);
    els.setTtsProvider.addEventListener('change', () => {
      const p = global.TTS && global.TTS.getProvider(els.setTtsProvider.value);
      if (p && p.baseUrl) els.setTtsBaseUrl.value = p.baseUrl;
      if (p && p.model) els.setTtsModel.value = p.model;
      if (p && p.voices && p.voices.length) els.setTtsVoice.value = p.voices[0];
      refreshCloudVoices();
    });
    // 三组"测试连接"：按 profile 把当前表单值临时写入 settings，再调 LLM.testConnection(profile)
    function bindTestButton(btn, resultEl, profile, baseUrlEl, modelEl, apiKeyEl) {
      if (!btn || !resultEl) return;
      btn.addEventListener('click', async () => {
        settings.llm[profile] = Object.assign({}, settings.llm[profile], {
          baseUrl: baseUrlEl.value.trim(),
          model: modelEl.value.trim(),
          apiKey: apiKeyEl.value.trim(),
        });
        resultEl.textContent = '⏳ 测试中…';
        resultEl.style.color = '#999';
        btn.disabled = true;
        try {
          const r = await LLM.testConnection(profile);
          resultEl.textContent = '✅ ' + r;
          resultEl.style.color = '#6fcf97';
        } catch (e) {
          resultEl.textContent = '❌ ' + (e.message || e);
          resultEl.style.color = '#ff9b9b';
        } finally {
          settings = loadSettings();
          btn.disabled = false;
        }
      });
    }
    bindTestButton(els.btnTestHumanApi, els.apiHumanTestResult, 'human', els.setHumanBaseUrl, els.setHumanModel, els.setHumanApiKey);
    bindTestButton(els.btnTestRedApi,   els.apiRedTestResult,   'red',   els.setRedBaseUrl,   els.setRedModel,   els.setRedApiKey);
    bindTestButton(els.btnTestBlackApi, els.apiBlackTestResult, 'black', els.setBlackBaseUrl, els.setBlackModel, els.setBlackApiKey);
    // 深度思考单选组/模型输入变化 → 刷新 FC 联动警示（radio 的 change 冒泡到容器，绑容器一次即可）
    [['setHumanReasoning', 'setHumanModel'], ['setRedReasoning', 'setRedModel'], ['setBlackReasoning', 'setBlackModel']].forEach(pair => {
      pair.forEach(id => {
        const el = els[id];
        if (el) el.addEventListener('change', updateFcWarnings);
      });
    });
    els.btnSettingsSave.addEventListener('click', saveSettingsFromModal);
    els.btnSettingsCancel.addEventListener('click', () => closeModal('modalSettings'));
    bindLogPanel();

    // TTS 试听：临时用当前表单值朗读一句（不落盘）
    els.btnTtsPreview.addEventListener('click', () => {
      settings.ttsEngine = els.setTtsEngine.value;
      settings.ttsBaseUrl = els.setTtsBaseUrl.value.trim();
      settings.ttsApiKey = els.setTtsApiKey.value.trim();
      settings.ttsModel = els.setTtsModel.value.trim() || 'tts-1';
      settings.ttsVoice = els.setTtsVoice.value.trim() || 'alloy';
      settings.ttsProvider = els.setTtsProvider.value || 'openai';
      const persona = Personas.get(settings.aiPersonaId);
      const styleVoice = global.TTS.styleVoice(persona.style);
      // 云端试听失败时给出可见反馈（否则"没声音"却不知原因）
      if (els.ttsPreviewResult) {
        els.ttsPreviewResult.textContent = '⏳ 试听中…';
        els.ttsPreviewResult.style.color = '#999';
        global.onTtsError = (msg) => {
          if (els.ttsPreviewResult) { els.ttsPreviewResult.textContent = '❌ ' + msg; els.ttsPreviewResult.style.color = '#ff9b9b'; }
        };
      }
      global.TTS.preview({ pitch: styleVoice.pitch, rate: styleVoice.rate, name: persona.voice || '' });
      if (els.ttsPreviewResult) setTimeout(() => {
        // 若未被错误回调改写（正常播放时 onTtsError 不会被触发），回退为空
        if (els.ttsPreviewResult.textContent === '⏳ 试听中…') els.ttsPreviewResult.textContent = '';
      }, 3000);
      settings = loadSettings();
    });

    // 人设弹窗
    els.btnPNew.addEventListener('click', () => {
      editingPersona = { id: null, isPreset: false };
      els.pName.value = '';
      els.pEmoji.value = '🤖';
      els.pDesc.value = '';
      els.pStyle.value = 'balanced';
      els.pVoice.value = '';
      els.pTaunt.value = 5; els.pTauntVal.textContent = '5/10';
      els.pTalk.value = 5; els.pTalkVal.textContent = '5/10';
      els.pExtra.value = '';
      autosizeTextarea(els.pDesc);
      autosizeTextarea(els.pExtra);
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
        if (Affinity) Affinity.remove(editingPersona.id); // 清理其好感度记录
        editingPersona = null;
        renderPersonaList();
        renderAffinityList();
        if (Personas.getAll().length) selectPersona(Personas.getAll()[0].id);
        populatePersonaSelects();
      }
    });
    els.btnPersonasClose.addEventListener('click', () => closeModal('modalPersonas'));
    // 人设文本域随输入自动增高
    els.pDesc.addEventListener('input', () => autosizeTextarea(els.pDesc));
    els.pExtra.addEventListener('input', () => autosizeTextarea(els.pExtra));

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
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '象棋棋谱_' + new Date().toISOString().slice(0, 10) + '.txt';
      a.click();
      // 延迟回收：部分浏览器（如 Firefox）会在 click 后同步回收时中断下载
      setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    if (Affinity) Affinity.onChange = info => onAffinityChange(info);
    if (GameSound) {
      GameSound.setEnabled(settings.sound !== false);
      // 浏览器要求用户手势后才能出声：第一次点击/按键时解锁音频
      document.addEventListener('pointerdown', () => GameSound.unlock(), { once: true });
      document.addEventListener('keydown', () => GameSound.unlock(), { once: true });
    }
    populatePersonaSelects();
    populateAllProviderSelects();
    bindEvents();
    drawBoard();
    setMode('human');
    // 首次启动自动展示玩法说明（localStorage 记忆，只弹一次；之后可从顶栏「📖 说明」随时重看）
    try {
      if (!localStorage.getItem('aixq_help_seen')) {
        localStorage.setItem('aixq_help_seen', '1');
        openModal('modalHelp');
      }
    } catch (e) { /* localStorage 不可用时静默跳过 */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
