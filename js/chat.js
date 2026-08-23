/* ============================================================
 * chat.js — 聊天面板：流式输出、快捷指令、观战解说、复盘
 * 对外接口（均由 main.js 驱动）：
 *   Chat.init(els)
 *   Chat.setPosition(ctx)        每步走完后刷新局面上下文
 *   Chat.send(text)              发送自由消息
 *   Chat.quickAction(kind)       analyze | hint | taunt | review
 *   Chat.spectateComment(moveInfo) 观战解说（流式）
 *   Chat.triggerTaunt(blunder)   玩家臭棋自动嘲讽
 *   Chat.requestUndo(info)       悔棋审批：LLM 裁决 + 本地兜底
 *   Chat.autoReview(result)      终局自动复盘
 *   Chat.systemLine(text)        灰色系统提示行
 *   Chat.abort() / Chat.clear()
 * 回调：Chat.onHint(move)        提示按钮 → 主程序高亮
 * ============================================================ */
(function (global) {
  'use strict';
  const Eng = global.ChessEngine;
  const RED = Eng.RED, BLACK = Eng.BLACK;
  const Personas = global.Personas;
  const LLM = global.LLMClient;
  const Affinity = global.Affinity;

  const Chat = {
    els: null,
    ctx: null,          // { board, turn, fen, evalSummary, topMoves, lastMove, personaColor, playerColor, mode }
    history: [],        // [{role:'user'|'assistant', content}]
    controller: null,
    busy: false,
    onHint: null,
  };

  const CANNED_TAUNTS = [
    '（本地模式）哼，就这？我闭着眼都比你走得好。',
    '（本地模式）你这步棋……建议回家再练三年。',
    '（本地模式）送子？谢谢啊，笑纳了。',
    '（本地模式）将军！你看，我又领先了。',
    '（本地模式）嘿嘿，这棋下得颇有我爷爷当年的风采——他老人家也总输。',
  ];
  const CANNED_GOOD_REACTIONS = [
    '（本地模式）哟，这步不错啊，有两下子。',
    '（本地模式）嘶……这步棋有点东西，我得认真了。',
    '（本地模式）漂亮，这步走到我心坎上了。',
    '（本地模式）可以啊，看来你不是来送菜的。',
  ];

  // 悔棋审批：本地兜底用词来自好感度模块（辱骂关键词表）
  const RUDE_KEYWORDS = (Affinity && Affinity.RUDE_KEYWORDS) || [];
  function playerWasRude() {
    return Chat.history.some(m => m.role === 'user' &&
      RUDE_KEYWORDS.some(k => String(m.content || '').toLowerCase().includes(k)));
  }

  function undoInstruction(count, movesDesc, affinityInfo) {
    const escalation = count <= 1
      ? '这是本局第 1 次，轻嘲一句即可。'
      : `这是本局第 ${count} 次，可以比之前更毒舌一些。`;
    const affText = affinityInfo
      ? `当前玩家对你的好感度：${affinityInfo.value}/100（${affinityInfo.tier}）。\n` +
        `好感度会影响你的裁决倾向：好感度高时更倾向同意，低时更倾向驳回，但请结合本局聊天记录里用户之前对你的态度综合判断。\n`
      : '';
    return `用户刚刚点击了悔棋按钮，请求悔棋。\n` +
      `需要撤销的走法：${movesDesc}。\n` + affText +
      `- 如果用户态度尚可、没有明显冒犯你，就同意本次悔棋，并用你的人设风格嘲讽他一句（${escalation}）。\n` +
      `- 如果用户之前对你出言不逊、态度过差，你可以驳回本次悔棋请求，并嘲讽他活该。\n` +
      `只输出一个 JSON 对象：{"allow":true,"reply":"你的回复"} 或 {"allow":false,"reply":"你的回复"}；\n` +
      `可选附加 "affinityDelta":±n（n 为 0~5 的整数），表示这次互动后你对玩家好感的增减。\n` +
      `allow 为 true 表示同意悔棋，false 表示驳回；reply 要口语化、符合人设，1~3 句，不要 Markdown，不要输出 JSON 以外的内容。`;
  }

  /** 悔棋本地兜底：好感度档位量化标准（LLM 失败/离线时使用） */
  function localUndoVerdict(count, personaId) {
    const v = Affinity.get(personaId);
    const tier = Affinity.tier(v);
    if (playerWasRude()) return { allow: false, reply: '（本地兜底）就你之前这态度，还想悔棋？驳回。' };
    if (tier === 'low') {
      return { allow: false, reply: `（本地兜底）好感度才 ${v}/100，还想让我给你悔棋？驳回。` };
    }
    if (tier === 'mid') {
      if (count <= 2) return { allow: true, reply: `（本地兜底）行，看在你态度还行的份上，悔吧（本局第 ${count} 次）。` };
      return { allow: false, reply: `（本地兜底）都第 ${count} 次悔棋了，好感度也就一般，驳回。` };
    }
    return { allow: true, reply: count <= 1 ? '（本地兜底）好感度不错，悔就悔吧。' : `（本地兜底）冲你这好感度，第 ${count} 次也准了。` };
  }

  /* ---------- 初始化 ---------- */
  Chat.init = function (els) {
    Chat.els = els;
    els.sendBtn.addEventListener('click', () => Chat.send(els.input.value));
    els.input.addEventListener('keydown', e => {
      // 中文输入法组合期间的回车是"确认候选词"，不应发送
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Chat.send(els.input.value); }
    });
    els.quickBtns.forEach(btn => {
      btn.addEventListener('click', () => Chat.quickAction(btn.dataset.action));
    });
    els.stopBtn.addEventListener('click', () => Chat.abort());
  };

  Chat.configured = function () {
    const c = LLM.getConfig();
    return !!(c.baseUrl && c.apiKey && c.model);
  };

  /** 是否启用流式输出（设置开关） */
  function streamingEnabled() {
    const s = global.AppSettings ? global.AppSettings.get() : {};
    return s.streaming !== false;
  }

  Chat.setPosition = function (ctx) { Chat.ctx = ctx; };
  Chat.getContext = function () { return Chat.ctx; };

  /* ---------- 消息渲染 ---------- */
  /** 当前对局人设的配音参数：棋风 → 音调/语速，另带人设绑定的音色名 */
  function currentVoice() {
    if (!global.TTS) return null;
    const persona = Personas.get(Chat.ctx ? Chat.ctx.personaId : undefined);
    const v = global.TTS.styleVoice(persona.style);
    return { pitch: v.pitch, rate: v.rate, name: persona.voice || '' };
  }

  function addBubble(role, text) {
    const wrap = Chat.els.messages;
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const inner = document.createElement('div');
    inner.className = 'bubble';
    inner.textContent = text || '';
    div.appendChild(inner);
    // AI 气泡：点击可重听配音（手动触发，不受自动配音开关限制）
    if (role === 'ai' && global.TTS) {
      const voice = currentVoice();
      div.title = '点击重听';
      div.addEventListener('click', () => {
        const t = inner.textContent || '';
        if (t && !t.startsWith('⚠️')) global.TTS.speakText(t, voice);
      });
    }
    wrap.appendChild(div);
    scrollBottom();
    return { div, inner };
  }

  function scrollBottom() {
    const m = Chat.els.messages;
    m.scrollTop = m.scrollHeight;
  }

  function updateBusy(b) {
    Chat.busy = b;
    Chat.els.sendBtn.disabled = b;
    // 注意：index.html 给停止按钮加了 .hidden，而 .hidden 使用 !important，
    // 不能只用 style.display 覆盖，必须同步切换 class。
    Chat.els.stopBtn.classList.toggle('hidden', !b);
    Chat.els.input.placeholder = b ? 'AI 正在回复…（可点击停止）' : (Chat.configured() ? '和对手聊聊… (Enter 发送)' : '未配置 API，仅可查看本地分析');
  }

  /* ---------- 系统提示行 ---------- */
  Chat.systemLine = function (text) {
    const wrap = Chat.els.messages;
    const div = document.createElement('div');
    div.className = 'msg sys';
    div.textContent = text;
    wrap.appendChild(div);
    scrollBottom();
  };

  const colorName = c => (c === RED ? '红' : '黑');
  function pieceName(piece, color) {
    return Eng.PIECE_NAME[piece] ? Eng.PIECE_NAME[piece][color === RED ? 0 : 1] : '棋子';
  }

  /** 全量棋谱（精简中文记谱，按手数顺序），供复盘时注入 prompt 抗幻觉 */
  function movesRecordText() {
    const st = global.Game && global.Game.state;
    if (!st || !st.history || !st.history.length) return '（棋谱为空，双方尚未走子）';
    return st.history.map((h, i) =>
      `${i + 1}.${colorName(h.move.color)}${h.notation}`
    ).join(' ');
  }

  /* ---------- 局面上下文 → prompt 文本 ---------- */
  function positionBlock() {
    const c = Chat.ctx;
    if (!c) return '';
    const ev = c.evalSummary || { label: '未知', diff: 0 };
    let s = '当前棋局信息：\n';
    s += `- 现在轮到：${colorName(c.turn)}方走子\n`;
    s += `- FEN：${c.fen}\n`;
    s += `- 局面评估：${ev.label}（分差约 ${ev.diff} 分）\n`;
    if (c.topMoves && c.topMoves.length) {
      s += '- 引擎推荐走法（按推荐度降序）：' + c.topMoves.map((m, i) => `${i + 1}. ${m.notation} (${m.score > 0 ? '+' : ''}${Math.round(m.score)})`).join('，') + '\n';
    }
    if (c.lastMove) {
      const lm = c.lastMove;
      const mover = colorName(lm.color);
      let who;
      if (c.personaColor && lm.color === c.personaColor) who = '这步是你走的';
      else if (c.mode === 'human') who = '这步是用户走的';
      else who = `这步是${mover}方AI走的`;
      let capDesc = '';
      if (lm.captured) {
        const capColor = lm.color === RED ? BLACK : RED;
        capDesc = `，吃掉了${colorName(capColor)}方的${pieceName(lm.captured, capColor)}`;
      }
      s += `- 上一手：${mover}方 ${lm.notation}（${who}${capDesc}）\n`;
    }
    return s;
  }

  function baseSystem(persona) {
    const c = Chat.ctx;
    if (!c) return '';
    // 优先使用 main.js 注入的 personaColor；缺失时按“轮到对方”兜底
    const myColor = c.personaColor || (c.turn === RED ? BLACK : RED);
    const my = myColor === RED ? '红' : '黑';
    const opp = myColor === RED ? '黑' : '红';
    const role = c.mode === 'spectate'
      ? `你是「${persona.name}」${persona.emoji}，执${my}方的棋手，正在和另一位 AI 棋手对弈，用户是观战解说。`
      : `你是「${persona.name}」${persona.emoji}，执${my}方，正在和用户（执${opp}方）下中国象棋。`;
    return role + '\n' +
      `你的人设：${persona.desc}\n` +
      Personas.styleText(persona) + '\n' +
      `回复风格：像真人棋友一样口语化聊天，不要 Markdown 列表/标题，不要复述 FEN 或系统数据，不要自称 AI；默认 1~5 句，除非用户要求详细分析。\n\n` +
      positionBlock();
  }

  const KIND_INSTRUCTION = {
    // 分析局面 = 全局战略解读：只讲态势与计划，不给具体某一步（那是“提示”的职责）
    analyze: '请像真人和棋友聊天那样，用口语段落做全局战略分析：双方子力与局势对比、各自的薄弱点、攻防方向和后续计划。不要推荐具体的某一步走法（那是“提示”按钮的事），聚焦整体局面解读，4~8 句，不要编号列表。',
    // 提示 = 战术层面：只讲引擎替玩家推荐的那一步棋
    hint: '用户刚刚点击了「给我提示」按钮，引擎为当前该走子的一方（用户的棋）推荐了一步棋，具体走法在后面给出。\n' +
      '重要：这个推荐走法属于用户一方，是替对手出的主意，绝对不是你自己的棋。严禁说成“我走这步”“我打算走”“我刚走了”等把你和该走法绑定的表述，也不要顺势替自己挑选回应。\n' +
      '请以对手的身份大度指点：明明是对局，你却看不下去了，摆出“教你一招”的姿态，用 1~2 句口语讲清这步棋妙在哪里，保持你的人设。',
    hintRefuse: '用户点击了「给我提示」，但你（对手）当前对他好感度很低，不想教他。请按你的人设拒绝：可以嘲讽他之前的表现或棋力，明确表示这次不给提示。1~2 句口语，不要 Markdown，不要输出 JSON。',
    taunt: '现在请以你的人设风格，用一两句口语嘲讽一下对手（可以结合棋局变化，犀利但不要脏话，不要真实攻击性内容）。',
    good: '对方刚走了一步好棋，请以你的人设风格做出反应（可以惊讶、称赞、警惕或嘴硬），用一两句口语，不要书面分析。',
    review: '请像真人复盘一样，用口语讲讲这盘棋的关键转折点、双方表现，以及你对对手的评价；不要编号列表。\n' +
      '复盘必须严格基于下方给出的真实棋谱：只能引用棋谱中实际记录的着法（可注明手数，如“第 12 手”），严禁编造、改动或脑补任何未发生的走法；如果记不清就笼统点评，不要虚构具体着法。',
    commentary: '请用一句话点评这步棋，保持你的人设风格，要像观棋时随口说出来的话。',
  };

  function kindInstruction(kind, extra) {
    const base = KIND_INSTRUCTION[kind] || '';
    return base + (extra ? '\n' + extra : '');
  }

  /** 复盘/认输的语气分档：好感度 低/中/高 叠加现有局面分档（仅人机模式） */
  function affinityReviewInstruction(personaId) {
    if (!Chat.ctx || Chat.ctx.mode !== 'human') return '';
    const v = Affinity.get(personaId);
    const tier = Affinity.tier(v);
    if (tier === 'low') {
      return `（好感度分档）玩家当前对你的好感度很低（${v}/100，冷淡）。复盘时语气冷淡、敷衍或带点嘲讽，点评从简，不要热情教学，明显不如从前上心。`;
    }
    if (tier === 'high') {
      return `（好感度分档）玩家当前对你的好感度很高（${v}/100，友好）。复盘时认真细致：多肯定对手表现，给出具体可执行的改进建议，语气热情一些（仍保持人设）。`;
    }
    return `（好感度分档）玩家当前对你的好感度一般（${v}/100）。按人设正常复盘即可。`;
  }

  /* ---------- 好感度：流式隐藏调分标记 [♥±n] ---------- */
  /** 调分目标：仅人机模式（观战模式不启用好感度） */
  function applyAffinityDelta(delta) {
    if (!delta || !Chat.ctx || Chat.ctx.mode !== 'human' || !Chat.ctx.personaId) return;
    Affinity.adjust(Chat.ctx.personaId, delta);
  }
  /** 流式增量调分追踪器：剥离 [♥±n] 标记，TTS 不朗读标记，跨 chunk 的未闭合标记暂存 */
  function createDeltaTracker(doSpeak) {
    let affDelta = 0, markerBuf = '';
    return {
      get delta() { return affDelta; },
      /** 把增量 piece 并入 acc；返回剥离标记后的 acc（用于渲染/历史） */
      feed(acc, piece) {
        acc += piece;
        const { text, delta, pending } = Affinity.stripAffinityMarkers(acc);
        if (delta) affDelta += delta;
        if (doSpeak && global.TTS) {
          const src = markerBuf ? markerBuf + piece : piece;
          const pp = Affinity.stripAffinityMarkers(src);
          markerBuf = pp.pending || '';
          if (pp.text) global.TTS.feed(pp.text);
        }
        return text;
      },
    };
  }

  /* ---------- 底层调用（流式） ---------- */
  // opts.speak：开启自动配音（流式时分句即时朗读；完成后 flush 残句；中止/出错即停止朗读）
  async function streamReply(system, user, opts) {
    opts = opts || {};
    Chat.abort();
    const controller = new AbortController();
    Chat.controller = controller;
    updateBusy(true);
    const bubble = addBubble('ai', '');
    const doSpeak = !!(opts.speak && global.TTS && global.TTS.isEnabled());
    const voice = doSpeak ? currentVoice() : null;
    if (doSpeak) global.TTS.begin(voice);
    let acc = '';
    const tracker = createDeltaTracker(doSpeak);
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    bubble.inner.appendChild(cursor);
    try {
      const messages = [{ role: 'system', content: system }];
      if (user) messages.push({ role: 'user', content: user });
      if (!streamingEnabled()) {
        acc = await LLM.request(messages, {
          stream: false,
          temperature: opts.temperature != null ? opts.temperature : 0.8,
          maxTokens: opts.maxTokens != null ? opts.maxTokens : 600,
          signal: controller.signal,
        });
        const cleaned = Affinity.stripAffinityMarkers(acc);
        acc = cleaned.text;
        if (cleaned.delta) applyAffinityDelta(cleaned.delta);
        cursor.remove();
        bubble.inner.textContent = acc || '（空回复）';
        Chat.history.push({ role: 'assistant', content: acc });
        trimHistory();
        if (doSpeak) global.TTS.speakText(acc, voice);
        return acc;
      }
      // 注意：流式返回值可能含 [♥±n] 标记，必须丢弃；acc 已在 onDelta 中剥离累积
      await LLM.request(messages, {
        stream: true,
        temperature: opts.temperature != null ? opts.temperature : 0.8,
        maxTokens: opts.maxTokens != null ? opts.maxTokens : 600,
        signal: controller.signal,
        onDelta: piece => {
          acc = tracker.feed(acc, piece);
          bubble.inner.textContent = acc;
          cursor.remove();
          bubble.inner.appendChild(cursor);
          scrollBottom();
        },
      });
      cursor.remove();
      bubble.inner.textContent = acc || '（空回复）';
      Chat.history.push({ role: 'assistant', content: acc });
      trimHistory();
      if (doSpeak) global.TTS.flush();
      if (tracker.delta) applyAffinityDelta(tracker.delta);
      return acc;
    } catch (e) {
      cursor.remove();
      if (doSpeak) global.TTS.stop();
      if (e.name === 'AbortError') {
        bubble.inner.textContent = acc || '';
        if (!acc && bubble.div && bubble.div.remove) bubble.div.remove();
      } else {
        bubble.inner.textContent = '⚠️ ' + (e.message || e);
        bubble.div.classList.add('err');
      }
      return null;
    } finally {
      // 只有当前请求仍是挂起中的那个才收尾，避免旧请求误清新请求的状态
      if (Chat.controller === controller) {
        updateBusy(false);
        Chat.controller = null;
      }
    }
  }

  function trimHistory() {
    // 保留最近 20 条对话
    const keep = 20;
    if (Chat.history.length > keep) Chat.history = Chat.history.slice(-keep);
  }

  /* ---------- 聊天流式渲染（自由聊天用） ---------- */
  /** 流式/非流式渲染聊天回复 + [♥±n] 剥离兜底 + TTS + 历史记录 */
  async function streamChatText(msgs, opts) {
    opts = opts || {};
    Chat.abort();
    const controller = new AbortController();
    Chat.controller = controller;
    updateBusy(true);
    const bubble = addBubble('ai', '');
    const doSpeak = !!(opts.speak !== false && global.TTS && global.TTS.isEnabled());
    const speakVoice = doSpeak ? currentVoice() : null;
    if (doSpeak) global.TTS.begin(speakVoice);
    let acc = '';
    const tracker = createDeltaTracker(doSpeak);
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    bubble.inner.appendChild(cursor);
    try {
      if (!streamingEnabled()) {
        acc = await LLM.request(msgs, {
          stream: false,
          temperature: opts.temperature != null ? opts.temperature : 0.8,
          maxTokens: opts.maxTokens != null ? opts.maxTokens : 600,
          signal: controller.signal,
        });
        const cleaned = Affinity.stripAffinityMarkers(acc);
        acc = cleaned.text;
        if (cleaned.delta) applyAffinityDelta(cleaned.delta);
        cursor.remove();
        bubble.inner.textContent = acc || '（空回复）';
        Chat.history.push({ role: 'assistant', content: acc });
        trimHistory();
        if (doSpeak) global.TTS.speakText(acc, speakVoice);
        return acc;
      }
      // 流式返回值可能含 [♥±n] 标记，必须丢弃；acc 已在 onDelta 中剥离累积
      await LLM.request(msgs, {
        stream: true,
        temperature: opts.temperature != null ? opts.temperature : 0.8,
        maxTokens: opts.maxTokens != null ? opts.maxTokens : 600,
        signal: controller.signal,
        onDelta: piece => {
          acc = tracker.feed(acc, piece);
          bubble.inner.textContent = acc;
          cursor.remove();
          bubble.inner.appendChild(cursor);
          scrollBottom();
        },
      });
      cursor.remove();
      bubble.inner.textContent = acc || '（空回复）';
      Chat.history.push({ role: 'assistant', content: acc });
      trimHistory();
      if (doSpeak) global.TTS.flush();
      if (tracker.delta) applyAffinityDelta(tracker.delta);
      return acc;
    } catch (e) {
      cursor.remove();
      if (doSpeak) global.TTS.stop();
      if (e.name === 'AbortError') { bubble.inner.textContent = acc || ''; if (!acc && bubble.div && bubble.div.remove) bubble.div.remove(); }
      else { bubble.inner.textContent = '⚠️ ' + (e.message || e); bubble.div.classList.add('err'); }
      return null;
    } finally {
      if (Chat.controller === controller) {
        updateBusy(false);
        Chat.controller = null;
      }
    }
  }

  /** FC 两阶段聊天：先非流式预判 adjust_affinity 调分，再流式正文打字机 */
  async function twoPhaseChat(msgs) {
    const FCT = global.FCTools;
    Chat.abort();
    const controller = new AbortController();
    Chat.controller = controller;
    updateBusy(true);
    let toolMsgs = [];
    let proceed = true;
    try {
      // 阶段 1：预判是否需要调分（小 max_tokens、短超时；上下文只用最近 8 条）
      const preMsgs = [
        { role: 'system', content: '判断玩家刚发的这条消息对你的态度并调整好感度：\n' +
          '- 玩家辱骂/嘲讽/人身攻击/威胁（如"大傻子""蠢蛋""王八蛋""略死你""菜鸟"）→ 必须调用 adjust_affinity，delta 为负数（轻度挑衅 -3~-5，严重辱骂 -6~-10）。\n' +
          '- 玩家礼貌/夸赞/道歉 → 可调用 adjust_affinity，delta 为正数（+1~+5）。\n' +
          '- 普通聊天 → 不要调用任何工具，回复一个空字符串。\n' +
          '只输出工具调用或空字符串。' },
      ].concat(Chat.history.slice(-8));
      const pre = await LLM.requestFull(preMsgs, {
        tools: [FCT.ADJUST_AFFINITY],
        temperature: 0.2,
        maxTokens: 24,
        timeout: 10000,
        signal: controller.signal,
      });
      const tc = (pre.toolCalls || []).find(t => t.name === 'adjust_affinity');
      if (tc) {
        const delta = parseInt(tc.args.delta, 10);
        const pid = Chat.ctx && Chat.ctx.personaId;
        if (Number.isFinite(delta) && delta !== 0 && pid) {
          Affinity.adjust(pid, delta);
          toolMsgs = [
            { role: 'assistant', content: null, tool_calls: [{ id: tc.id, type: 'function', function: { name: 'adjust_affinity', arguments: JSON.stringify(tc.args) } }] },
            { role: 'tool', tool_call_id: tc.id, content: `好感度已调整：${delta > 0 ? '+' : ''}${delta}（原因：${tc.args.reason || ''}）。请正常回复玩家。` },
          ];
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') proceed = false;
      else if (FCT.isFcUnsupportedError(e)) {
        FCT.markFallback();
        if (FCT.ensureNotified()) Chat.systemLine('⚠️ 当前服务商不支持函数调用，已自动降级为 JSON 模式。');
      }
      // 其他错误（网络/超时）：不标记降级，直接走流式正文（正文失败会有错误气泡）
    }
    if (!proceed) {
      if (Chat.controller === controller) { updateBusy(false); Chat.controller = null; }
      return;
    }
    // 阶段 2：流式正文（不带 tools，避免流式 tool_calls 兼容问题）
    await streamChatText(msgs.concat(toolMsgs), { temperature: 0.8, maxTokens: 600 });
  }

  /* ---------- 自由聊天 ---------- */
  Chat.send = function (text) {
    text = (text || '').trim();
    if (!text || Chat.busy) return;
    if (!Chat.ctx) { Chat.systemLine('请先开始一局对弈。'); return; }
    const persona = Personas.get(Chat.ctx.personaId);
    Chat.els.input.value = '';
    // 本地好感度自动调分：辱骂/挑衅（-8/-3）在 FC 模式下也是硬性底线，保证被骂必掉分；
    // 礼貌 +2 在 FC 模式下交给 LLM 预判（避免双重加分），降级/离线模式全量生效
    const fcChatLocal = !!(global.FCTools && LLM.requestFull &&
      global.AppSettings.get().useFunctionCalling !== false &&
      !global.FCTools.fallback.active && Chat.ctx.mode === 'human');
    if (Chat.ctx.mode === 'human') {
      const localDelta = Affinity.detectLocalDelta(text);
      const effective = fcChatLocal ? Math.min(0, localDelta) : localDelta;
      if (effective) Affinity.adjust(Chat.ctx.personaId, effective);
    }
    addBubble('user', text);
    Chat.history.push({ role: 'user', content: text });
    trimHistory();
    if (!Chat.configured()) {
      const ev = Chat.ctx.evalSummary || { label: '未知', diff: 0 };
      const tops = Chat.ctx.topMoves || [];
      Chat.systemLine(`📊 本地回应：${ev.label}（分差约 ${ev.diff} 分），引擎推荐：` +
        (tops.length ? tops.map(m => m.notation).join('、') : '无') + '。\n（配置 API 后即可和 AI 自由对话）');
      return;
    }
    const sys = baseSystem(persona);
    const msgs = [{ role: 'system', content: sys }].concat(Chat.history.slice(-16));
    // FC 两阶段聊天：先非流式预判好感度调分，再流式正文（仅人机模式且 FC 可用）
    const FCT = global.FCTools;
    const fcChat = !!(FCT && LLM.requestFull &&
      global.AppSettings.get().useFunctionCalling !== false &&
      !FCT.fallback.active && Chat.ctx.mode === 'human');
    if (fcChat) { twoPhaseChat(msgs); return; }
    // 旧路径：流式文本 + [♥±n] 标记兜底
    streamChatText(msgs, { temperature: 0.8, maxTokens: 600 });
  };

  /** 从模型回复文本中解析最后提到的合法走法（蓝圈跟随最终推荐） */
  function findMoveMentionedInText(board, turn, text) {
    if (!text) return null;
    const legal = Eng.legalMoves(board, turn);
    let best = null, bestIdx = -1;
    for (const m of legal) {
      const n = Eng.notation(board, m);
      if (!n) continue;
      const idx = text.lastIndexOf(n);
      if (idx > bestIdx) { bestIdx = idx; best = m; }
    }
    if (best) return best;
    for (const m of legal) {
      const coord = Eng.moveToCoord(m);
      if (!coord) continue;
      const idx = text.toLowerCase().lastIndexOf(coord);
      if (idx > bestIdx) { bestIdx = idx; best = m; }
    }
    return best;
  }

  /* ---------- 快捷指令 ---------- */
  Chat.quickAction = async function (kind) {
    if (Chat.busy) return;
    const c = Chat.ctx;
    if (!c) { Chat.systemLine('请先开始一局对弈。'); return; }
    const persona = Personas.get(c.personaId);

    if (kind === 'hint') {
      // 好感度门槛：低于阈值时 AI 拒绝给提示（拒绝不消耗好感度）
      const affNow = Affinity.get(c.personaId);
      if (affNow < Affinity.HINT_REFUSE_THRESHOLD) {
        if (!Chat.configured()) {
          Chat.systemLine(`💡 好感度只有 ${affNow}/100，对方拒绝给你提示。`);
        } else {
          await streamReply(
            baseSystem(persona) + '\n' + kindInstruction('hintRefuse',
              `当前玩家对你的好感度：${affNow}/100（${Affinity.tierLabel(affNow)}），低于提示门槛（${Affinity.HINT_REFUSE_THRESHOLD}）。`),
            '', { temperature: 0.9, maxTokens: 200, speak: true }
          );
        }
        return;
      }
      // 提示：本地引擎 top1 + 高亮；过滤长将走法，蓝圈与提示文字使用同一走法
      const r = global.ChessAI.search(c.board, c.turn, { depth: c.difficulty || 3, topN: 5 });
      if (global.Game && global.Game.wouldRepeatCheck) {
        r.candidates = (r.candidates || []).filter(x => !global.Game.wouldRepeatCheck(x.move));
      }
      const top = r.candidates && r.candidates.length ? r.candidates[0] : null;
      if (!top || !top.move) { Chat.systemLine('当前局面没有合法走法。'); return; }
      if (Chat.onHint) Chat.onHint(top.move);
      const hintMsg = `💡 提示：推荐 ${top.notation}（评分 ${Math.round(top.score)}）`;
      Chat.systemLine(hintMsg);
      // 使用成功即消耗好感度（好感越低消耗越狠），离线同样生效
      Affinity.adjust(c.personaId, -Affinity.hintCost(affNow));
      if (!Chat.configured()) return;
      const reply = await streamReply(
        baseSystem(persona) + '\n' + kindInstruction('hint', `引擎推荐给用户一方的走法：${top.notation}（评分 ${Math.round(top.score)}）。这是当前该走子一方的棋，不是你的。`),
        '', { temperature: 0.7, maxTokens: 250, speak: true }
      );
      // 若模型在解释中明确推荐了另一只棋子，让蓝圈跟随模型最终推荐
      // 仅当棋局上下文未变化时更新（防止玩家在解释期间走子导致蓝圈错位）
      const latest = Chat.ctx;
      if (latest && latest.fen === c.fen) {
        const modelMove = findMoveMentionedInText(c.board, c.turn, reply || '');
        if (modelMove && Chat.onHint) Chat.onHint(modelMove);
      }
      return;
    }

    if (kind === 'analyze') {
      if (!Chat.configured()) {
        // 本地分析
        const ev = c.evalSummary || { label: '未知', diff: 0 };
        const tops = c.topMoves || [];
        const text = `📊 本地分析：${ev.label}（分差约 ${ev.diff} 分）。\n推荐走法：` +
          (tops.length ? tops.map(m => m.notation).join('、') : '无') + '\n（配置 API 后可由 AI 给出详细解读）';
        Chat.systemLine(text);
        return;
      }
      await streamReply(baseSystem(persona) + '\n' + kindInstruction('analyze'), '', { temperature: 0.7, maxTokens: 600, speak: true });
      return;
    }

    if (kind === 'taunt') {
      if (!Chat.configured()) {
        Chat.systemLine(CANNED_TAUNTS[Math.floor(Math.random() * CANNED_TAUNTS.length)]);
        return;
      }
      await streamReply(baseSystem(persona) + '\n' + kindInstruction('taunt'), '', { temperature: 1.1, maxTokens: 250, speak: true });
      return;
    }

    if (kind === 'review') {
      const over = global.Game && global.Game.state && global.Game.state.over;
      const result = over
        ? `${over.winner === RED ? '红方' : '黑方'}获胜（${over.reason}）`
        : '棋局尚未结束，进行中途点评';
      if (!Chat.configured()) {
        const ev = c.evalSummary || { label: '未知', diff: 0 };
        Chat.systemLine(`🏁 复盘（本地）：${result}。最终评估：${ev.label}。\n配置 API 后可获得 AI 的完整复盘点评。`);
        return;
      }
      await streamReply(
        baseSystem(persona) + '\n' + kindInstruction('review',
          `棋局结果：${result}\n完整棋谱（按手数顺序，红先）：${movesRecordText()}\n${affinityReviewInstruction(c.personaId)}`),
        '', { temperature: 0.8, maxTokens: 800, speak: true }
      );
    }
  };

  /* ---------- 外部触发 ---------- */
  /** 玩家臭棋 → 自动嘲讽（由 main.js 检测后调用） */
  Chat.triggerTaunt = function (blunder) {
    if (Chat.busy) return;
    const c = Chat.ctx;
    const persona = Personas.get(c ? c.personaId : undefined);
    if (!Chat.configured()) {
      Chat.systemLine(CANNED_TAUNTS[Math.floor(Math.random() * CANNED_TAUNTS.length)]);
      return;
    }
    let extra = '';
    if (blunder) {
      extra = blunder.betterNotation
        ? `（提示：对手刚走了 ${blunder.notation}，这是一步明显的臭棋，引擎更推荐 ${blunder.betterNotation}。）`
        : `（提示：对手刚走了 ${blunder.notation}，这是一步明显的臭棋。）`;
    }
    streamReply(baseSystem(persona) + '\n' + kindInstruction('taunt', extra), '', { temperature: 1.1, maxTokens: 200 });
  };

  /** 玩家好棋 → 按人设自动反应（由 main.js 检测后调用） */
  Chat.triggerGoodMove = function (info) {
    if (Chat.busy) return;
    const c = Chat.ctx;
    const persona = Personas.get(c ? c.personaId : undefined);
    if (!Chat.configured()) {
      Chat.systemLine(CANNED_GOOD_REACTIONS[Math.floor(Math.random() * CANNED_GOOD_REACTIONS.length)]);
      return;
    }
    const extra = info
      ? `（提示：对手刚走了 ${info.notation}，这是一步好棋，局势分提高了约 ${info.evalGain} 分。）`
      : '';
    streamReply(baseSystem(persona) + '\n' + kindInstruction('good', extra), '', { temperature: 0.9, maxTokens: 200 });
  };

  /** 悔棋审批：LLM 先嘲讽/裁决，同意才允许悔棋；失败时本地关键词兜底 */
  Chat.requestUndo = async function (info) {
    if (!Chat.configured()) return null; // 离线由 main.js 直接放行
    const c = Chat.ctx;
    if (!c) return null;
    const persona = Personas.get(c.personaId);
    const count = Math.max(1, +((info && info.count) || 1) || 1);
    const moves = (info && info.moves && info.moves.length) ? info.moves : [];
    const movesDesc = moves.length
      ? moves.map((m, i) => {
          const side = colorName(m.color);
          let cap = '';
          if (m.captured) cap = `，吃掉了${colorName(m.color === RED ? BLACK : RED)}方的${pieceName(m.captured, m.color === RED ? BLACK : RED)}`;
          return `第 ${i + 1} 手：${side}方 ${m.notation}${cap}`;
        }).join('；')
      : '最近一步';
    const aff = Affinity.get(c.personaId);
    const sys = baseSystem(persona) + '\n' + undoInstruction(count, movesDesc, { value: aff, tier: Affinity.tierLabel(aff) });
    const msgs = [{ role: 'system', content: sys }]
      .concat(Chat.history.slice(-16))
      .concat([{ role: 'user', content: '（用户刚刚点击了悔棋按钮）' }]);

    Chat.abort();
    const controller = new AbortController();
    Chat.controller = controller;
    updateBusy(true);
    const bubble = addBubble('ai', '…');
    const finish = v => {
      const reply = v.reply || '（空回复）';
      bubble.inner.textContent = reply;
      Chat.history.push({ role: 'assistant', content: reply });
      trimHistory();
      return { allow: v.allow, reply };
    };
    try {
      // —— FC 主路径：answer_undo 工具调用（allow/reply/affinity_delta 一次完成）——
      const FCT = global.FCTools;
      const fcEnabled = !!(FCT && LLM.requestFull && global.AppSettings.get().useFunctionCalling !== false && !FCT.fallback.active);
      if (fcEnabled) {
        try {
          const resp = await LLM.requestFull(msgs, {
            tools: [FCT.ANSWER_UNDO], temperature: 0.4, maxTokens: 250, signal: controller.signal,
          });
          const tc = (resp.toolCalls || []).find(t => t.name === 'answer_undo');
          if (tc && typeof tc.args.allow === 'boolean' && tc.args.reply) {
            const llmDelta = parseInt(tc.args.affinity_delta, 10);
            if (Number.isFinite(llmDelta) && llmDelta !== 0) Affinity.adjust(c.personaId, llmDelta);
            return finish({ allow: tc.args.allow, reply: String(tc.args.reply) });
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e; // 交给外层统一处理（移除气泡）
          if (FCT.isFcUnsupportedError(e)) {
            FCT.markFallback();
            if (FCT.ensureNotified()) Chat.systemLine('⚠️ 当前服务商不支持函数调用，已自动降级为 JSON 模式。');
          }
          // 其他错误（网络/超时）：落到旧 JSON 路径，由旧逻辑的 catch 兜底
        }
      }
      // —— 降级/旧路径：JSON 提取 ——
      let j = LLM.extractJSON(await LLM.request(msgs, {
        stream: false, temperature: 0.4, maxTokens: 250, signal: controller.signal,
      }));
      if (!j) {
        const retryMsgs = msgs.concat([
          { role: 'assistant', content: '（上一轮输出格式无效）' },
          { role: 'user', content: '请严格只输出 JSON：{"allow":true,"reply":"..."} 或 {"allow":false,"reply":"..."}' },
        ]);
        j = LLM.extractJSON(await LLM.request(retryMsgs, {
          stream: false, temperature: 0.2, maxTokens: 250, signal: controller.signal,
        }));
      }
      if (!j || typeof j.allow !== 'boolean' || !j.reply) return finish(localUndoVerdict(count, c.personaId));
      // LLM 工具：可选的好感度加减分（affinityDelta，±0~5）
      const llmDelta = parseInt(j.affinityDelta, 10);
      if (Number.isFinite(llmDelta) && llmDelta !== 0) Affinity.adjust(c.personaId, llmDelta);
      return finish({ allow: j.allow, reply: String(j.reply) });
    } catch (e) {
      if (e.name === 'AbortError') { bubble.inner.textContent = ''; if (bubble.div && bubble.div.remove) bubble.div.remove(); return null; }
      // 网络/API 错误：用本地好感度档位兜底，保证悔棋审批不因请求失败而卡死
      return finish(localUndoVerdict(count, c.personaId));
    } finally {
      if (Chat.controller === controller) {
        updateBusy(false);
        Chat.controller = null;
      }
    }
  };

  /** 观战解说（每步后调用） */
  Chat.spectateComment = function (moveInfo) {
    if (Chat.busy) return;
    const c = Chat.ctx;
    const persona = Personas.get(c ? c.personaId : undefined);
    if (!Chat.configured()) {
      Chat.systemLine(`📣 ${moveInfo.colorName}走：${moveInfo.notation}（本地解说：可配置 API 获得 AI 解说）`);
      return;
    }
    streamReply(
      baseSystem(persona) + '\n' + kindInstruction('commentary', `这步棋：${moveInfo.notation}（${moveInfo.colorName}方）。只点评这一句，简短些。`),
      '', { temperature: 0.9, maxTokens: 120 }
    );
  };

  /** 终局自动复盘。extra：可选的额外指令（如认输分档说明） */
  Chat.autoReview = function (result, extra) {
    if (Chat.busy) return;
    const c = Chat.ctx;
    const persona = Personas.get(c ? c.personaId : undefined);
    if (!Chat.configured()) {
      Chat.systemLine(`🏁 对局结束：${result}。`);
      return;
    }
    let instruction = `棋局结果：${result}`;
    if (extra) instruction += '\n' + extra;
    instruction += `\n完整棋谱（按手数顺序，红先）：${movesRecordText()}`;
    // 好感度分档叠加（认输时与局面分档 3×3 组合）
    if (c && c.mode === 'human') instruction += '\n' + affinityReviewInstruction(c.personaId);
    streamReply(
      baseSystem(persona) + '\n' + kindInstruction('review', instruction),
      '', { temperature: 0.8, maxTokens: 800, speak: true }
    );
  };

  Chat.abort = function () {
    if (Chat.controller) { Chat.controller.abort(); Chat.controller = null; }
    updateBusy(false);
  };

  /** 快速显示一条 AI 消息（非流式，用于 AI 走子时的心理活动） */
  Chat.showQuickAssistant = function (text) {
    if (!text) return;
    const bubble = addBubble('ai', text);
    Chat.history.push({ role: 'assistant', content: text });
    trimHistory();
    return bubble;
  };

  Chat.clear = function () {
    Chat.abort();
    Chat.history = [];
    Chat.els.messages.innerHTML = '';
    Chat.systemLine('👋 对局开始，和对手打个招呼吧！');
  };

  global.Chat = Chat;
})(typeof window !== 'undefined' ? window : globalThis);
