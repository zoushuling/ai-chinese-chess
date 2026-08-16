/* ============================================================
 * chat.js — 聊天面板：流式输出、快捷指令、观战解说、复盘
 * 对外接口（均由 main.js 驱动）：
 *   Chat.init(els)
 *   Chat.setPosition(ctx)        每步走完后刷新局面上下文
 *   Chat.send(text)              发送自由消息
 *   Chat.quickAction(kind)       analyze | hint | taunt | review
 *   Chat.spectateComment(moveInfo) 观战解说（流式）
 *   Chat.triggerTaunt(blunder)   玩家臭棋自动嘲讽
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

  /* ---------- 初始化 ---------- */
  Chat.init = function (els) {
    Chat.els = els;
    els.sendBtn.addEventListener('click', () => Chat.send(els.input.value));
    els.input.addEventListener('keydown', e => {
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
  function addBubble(role, text) {
    const wrap = Chat.els.messages;
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const inner = document.createElement('div');
    inner.className = 'bubble';
    inner.textContent = text || '';
    div.appendChild(inner);
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
    analyze: '请像真人和棋友聊天那样，用口语短段落分析当前局面：双方优劣势、各自的薄弱点，以及你推荐的 1-3 步走法（直接说出棋名，不要编号列表）。',
    taunt: '现在请以你的人设风格，用一两句口语嘲讽一下对手（可以结合棋局变化，犀利但不要脏话，不要真实攻击性内容）。',
    good: '对方刚走了一步好棋，请以你的人设风格做出反应（可以惊讶、称赞、警惕或嘴硬），用一两句口语，不要书面分析。',
    review: '请像真人复盘一样，用口语讲讲这盘棋的关键转折点、双方表现，以及你对对手的评价；不要编号列表。',
    commentary: '请用一句话点评这步棋，保持你的人设风格，要像观棋时随口说出来的话。',
  };

  function kindInstruction(kind, extra) {
    const base = KIND_INSTRUCTION[kind] || '';
    return base + (extra ? '\n' + extra : '');
  }

  /* ---------- 底层调用（流式） ---------- */
  async function streamReply(system, user, opts) {
    opts = opts || {};
    Chat.abort();
    const controller = new AbortController();
    Chat.controller = controller;
    updateBusy(true);
    const bubble = addBubble('ai', '');
    let acc = '';
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
        cursor.remove();
        bubble.inner.textContent = acc || '（空回复）';
        Chat.history.push({ role: 'assistant', content: acc });
        trimHistory();
        return acc;
      }
      acc = await LLM.request(messages, {
        stream: true,
        temperature: opts.temperature != null ? opts.temperature : 0.8,
        maxTokens: opts.maxTokens != null ? opts.maxTokens : 600,
        signal: controller.signal,
        onDelta: piece => {
          acc += piece;
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
      return acc;
    } catch (e) {
      cursor.remove();
      if (e.name === 'AbortError') {
        bubble.inner.textContent = acc || '';
        if (!acc) bubble.remove();
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

  /* ---------- 自由聊天 ---------- */
  Chat.send = function (text) {
    text = (text || '').trim();
    if (!text || Chat.busy) return;
    if (!Chat.ctx) { Chat.systemLine('请先开始一局对弈。'); return; }
    const persona = Personas.get(Chat.ctx.personaId);
    Chat.els.input.value = '';
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
    // 直接用流式调用（不走 streamReply 的本地兜底分支）
    Chat.abort();
    const controller = new AbortController();
    Chat.controller = controller;
    updateBusy(true);
    const bubble = addBubble('ai', '');
    let acc = '';
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    bubble.inner.appendChild(cursor);
    (async () => {
      try {
        if (!streamingEnabled()) {
          acc = await LLM.request(msgs, {
            stream: false,
            temperature: 0.8,
            maxTokens: 600,
            signal: controller.signal,
          });
          cursor.remove();
          bubble.inner.textContent = acc || '（空回复）';
          Chat.history.push({ role: 'assistant', content: acc });
          trimHistory();
          return;
        }
        acc = await LLM.request(msgs, {
          stream: true,
          temperature: 0.8,
          maxTokens: 600,
          signal: controller.signal,
          onDelta: piece => {
            acc += piece;
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
      } catch (e) {
        cursor.remove();
        if (e.name === 'AbortError') { bubble.inner.textContent = acc || ''; if (!acc) bubble.remove(); }
        else { bubble.inner.textContent = '⚠️ ' + (e.message || e); bubble.div.classList.add('err'); }
      } finally {
        if (Chat.controller === controller) {
          updateBusy(false);
          Chat.controller = null;
        }
      }
    })();
  };

  /* ---------- 快捷指令 ---------- */
  Chat.quickAction = async function (kind) {
    if (Chat.busy) return;
    const c = Chat.ctx;
    if (!c) { Chat.systemLine('请先开始一局对弈。'); return; }
    const persona = Personas.get(c.personaId);

    if (kind === 'hint') {
      // 提示：本地引擎 top1 + 高亮
      const r = global.ChessAI.search(c.board, c.turn, { depth: c.difficulty || 3, topN: 1 });
      if (!r.move) { Chat.systemLine('当前局面没有合法走法。'); return; }
      if (Chat.onHint) Chat.onHint(r.move);
      const hintMsg = `💡 提示：推荐 ${r.notation}（评分 ${Math.round(r.score)}）`;
      Chat.systemLine(hintMsg);
      if (!Chat.configured()) return;
      await streamReply(
        baseSystem(persona) + '\n' + kindInstruction('analyze', `引擎刚刚推荐了走法 ${r.notation}，请用你的口吻简短解释为什么这样走。`),
        '', { temperature: 0.7, maxTokens: 250 }
      );
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
      await streamReply(baseSystem(persona) + '\n' + kindInstruction('analyze'), '', { temperature: 0.7, maxTokens: 500 });
      return;
    }

    if (kind === 'taunt') {
      if (!Chat.configured()) {
        Chat.systemLine(CANNED_TAUNTS[Math.floor(Math.random() * CANNED_TAUNTS.length)]);
        return;
      }
      await streamReply(baseSystem(persona) + '\n' + kindInstruction('taunt'), '', { temperature: 1.1, maxTokens: 250 });
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
      await streamReply(baseSystem(persona) + '\n' + kindInstruction('review', `棋局结果：${result}`), '', { temperature: 0.8, maxTokens: 600 });
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

  /** 终局自动复盘 */
  Chat.autoReview = function (result) {
    if (Chat.busy) return;
    const c = Chat.ctx;
    const persona = Personas.get(c ? c.personaId : undefined);
    if (!Chat.configured()) {
      Chat.systemLine(`🏁 对局结束：${result}。`);
      return;
    }
    streamReply(
      baseSystem(persona) + '\n' + kindInstruction('review', `棋局结果：${result}`),
      '', { temperature: 0.8, maxTokens: 500 }
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
