/* ============================================================
 * llm.js — OpenAI 兼容 API 客户端（纯前端直连）
 * 支持流式 SSE 输出、JSON 提取、Function Calling（tools）、连接测试
 * 配置来源：AppSettings（localStorage）的 llm.{human,red,black} 三组
 *   human = 人机对战（玩家对手）  red/black = 观战模式红/黑 AI
 * 对外接口：
 *   LLMClient.request(messages, opts)        返回 content 文本（流式/非流式）
 *   LLMClient.requestFull(messages, opts)    非流式，返回 {content, toolCalls, raw}
 *   LLMClient.extractJSON(text)              降级用的 JSON 提取
 *   LLMClient.getConfig(profile)             读取某组配置（缺省 human）
 *   LLMClient.fcEnabled(profile)             该组是否配置完整且开启 FC
 * opts.profile：'human' | 'red' | 'black'（缺省 'human'）
 * ============================================================ */
(function (global) {
  'use strict';

  const PROVIDERS = [
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'kimi', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { id: 'custom', name: '自定义', baseUrl: '', model: '' },
  ];

  const PROFILE_KEYS = ['human', 'red', 'black'];

  function getConfig(profile) {
    const s = (global.AppSettings && global.AppSettings.get()) || {};
    const groups = (s.llm && typeof s.llm === 'object') ? s.llm : {};
    const key = PROFILE_KEYS.indexOf(profile) >= 0 ? profile : 'human';
    const g = (groups[key] && typeof groups[key] === 'object') ? groups[key] : {};
    return {
      baseUrl: (g.baseUrl || '').trim(),
      apiKey: (g.apiKey || '').trim(),
      model: (g.model || '').trim(),
      useFc: g.useFc !== false,
      cotGuide: g.cotGuide || 'off', // 模式一：本地 CoT 引导（提示词工程）off | brief | standard | deep
      reasoning: g.reasoning || 'off', // 模式二：推理模型参数下发 off | low | medium | high
    };
  }

  /* ============================================================
   * 模式一：本地 CoT 引导（提示词工程）
   * —— 思考仍由模型完成，本地只提供「思考脚手架」：限定几步、每步多长、
   *    按什么顺序推演，并要求把推演要点写进结构化字段（FC 的 thought）或
   *    不写进正文。思考是模型输出的一部分，本地可解析、可剥离、可丢弃。
   * —— 与模式二（推理模型）语义完全独立：
   *      模式一 = 本地脚手架 + 模型受限输出，结构与长度本地可控；
   *      模式二 = 供应商原生思考通道（reasoning_content），结构本地管不着。
   *    两者可各自独立开关，也可同时开启。
   * ============================================================ */
  const COT_LEVELS = ['off', 'brief', 'standard', 'deep'];

  /** 每档的步数与每步字数上限（字数越紧，思考 token 越少，延迟越低） */
  const COT_SPEC = {
    off: null,
    brief: { steps: 2, max: 12 },
    standard: { steps: 3, max: 20 },
    deep: { steps: 4, max: 30 },
  };

  /** 各任务的推演步骤模板；档位步数不足则取前 N 步 */
  const COT_STEPS = {
    move: [
      '看清局面：子力对比与当前威胁',
      '比较候选：各步的代价与收益',
      '按你的棋风取舍并定下走法',
      '反问一句：这步有没有被反吃的漏洞',
    ],
    analyze: [
      '提炼局面关键：子力、威胁、弱点',
      '判断谁占优、差距有多大',
      '挑出最值得说的一两个要点',
      '检查：有没有漏掉对方的反击',
    ],
    taunt: [
      '确认对手这一步错在哪里',
      '找出更优的替代着法',
      '决定嘲讽的角度与力度',
      '收束：话要短，别变成讲棋',
    ],
    good: [
      '确认这一步好在哪里',
      '判断是否值得开口称赞',
      '按你的性格决定夸的尺度',
    ],
    review: [
      '回顾开局到中局的转折点',
      '定位决定胜负的关键几手',
      '给出一两条能落地的建议',
      '收尾：用你自己的语气做总结',
    ],
    undo: [
      '判断这次悔棋请求是否合理',
      '结合你对他的态度决定给不给面子',
      '给出裁决与一句话回应',
    ],
    comment: [
      '看清这步棋的意图',
      '点出它的优劣',
      '用解说的口吻说一句话',
    ],
    chat: [
      '判断他这话的意图与情绪',
      '决定回应的态度',
      '组织一句符合你性格的话',
    ],
  };

  /**
   * 生成 CoT 引导脚手架（纯函数，便于单测）。
   * @param {string} level off | brief | standard | deep
   * @param {string} kind  move | analyze | taunt | good | review | undo | comment | chat
   * @returns {string|null} 注入 prompt 的指令文本；off 或档位非法时返回 null
   *
   * 设计约束：
   *   ① 关闭时返回 null——调用方据此做到 prompt 逐字节不变；
   *   ② 思考要点要求写进 structured 字段（FC 的 thought）或"不写进正文"，
   *      不新增面向玩家的思考展示，沿用 V0.5.1 的决策（思考不展示，防出戏）；
   *   ③ 每步设字数上限——这是把思考 token 压到本地可控范围的主要手段。
   */
  function buildCoTGuide(level, kind) {
    const spec = COT_SPEC[level];
    if (!spec) return null;
    const pool = COT_STEPS[kind] || COT_STEPS.chat;
    const steps = pool.slice(0, Math.max(1, Math.min(spec.steps, pool.length)));
    const head = kind === 'move'
      ? `【思考方式】给出最终选择前，先按下面 ${steps.length} 步快速推演，每步不超过 ${spec.max} 字。推演要点写进 thought 字段，不要写进正文。`
      : `【思考方式】组织回答前先按下面 ${steps.length} 步理清思路，每步不超过 ${spec.max} 字。这只是你的内部依据，不要写进回答正文。`;
    return head + '\n' + steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  }

  /**
   * 模式二：推理模型参数推断（V0.5.1，纯函数便于单测）。
   * 语义：把思考交给供应商的原生推理通道（reasoning_content），
   *      思考的结构、长度、步数全部由供应商决定，本地只能通过档位粗调、靠超时兜底。
   *      与模式一（buildCoTGuide）互不干涉，可独立开关。
   * @param {Object} o { model, reasoning }  reasoning: 'off'|'low'|'medium'|'high'
   * @returns {{params:Object|null, omitTemp:boolean, tokenKey:string, tokenFloor:number}}
   *   params     追加到请求体的推理参数（null = 不加任何参数）
   *   omitTemp   true 时省略 temperature（OpenAI 推理系只接受默认值）
   *   tokenKey   'max_tokens' | 'max_completion_tokens'（o 系只认后者）
   *   tokenFloor 推理模型回答 token 下限（思考可能吃满上限，需放大）
   * 关键：reasoning='off' 时返回 params:null——请求体与旧版逐字节一致。
   */
  const EFFORT = { low: 'low', medium: 'medium', high: 'high' };
  function inferReasoning(o) {
    const level = (o && o.reasoning) || 'off';
    const out = { params: null, omitTemp: false, tokenKey: 'max_tokens', tokenFloor: 0 };
    if (level === 'off') return out;
    const model = String((o && o.model) || '').toLowerCase();
    const effort = EFFORT[level] || 'medium';
    if (/reasoner/.test(model)) {
      // DeepSeek reasoner：思考内建、无需参数；但回答 token 上限需放宽
      out.tokenFloor = 2048;
      return out;
    }
    if (/qwen3/.test(model)) { out.params = { enable_thinking: true }; return out; }
    if (/glm-4\.[56]/.test(model)) { out.params = { thinking: { type: 'enabled' } }; return out; }
    if (/(^|[-_])o[13](-|$)|^o3|gpt-5/.test(model)) {
      out.params = { reasoning_effort: effort };
      out.tokenKey = 'max_completion_tokens'; // o 系拒绝 max_tokens，且思考与回答共池
      out.tokenFloor = 4096;
      out.omitTemp = true;
      return out;
    }
    // 兜底：OpenAI 兼容 effort（多数网关容忍未知/新模型）
    out.params = { reasoning_effort: effort };
    out.omitTemp = true;
    return out;
  }

  /** 该组配置是否完整（可发起请求）且开启 Function Calling */
  function fcEnabled(profile) {
    const c = getConfig(profile);
    return !!(c.baseUrl && c.apiKey && c.model) && c.useFc;
  }

  function endpoint(baseUrl) {
    return baseUrl.replace(/\/+$/, '') + '/chat/completions';
  }

  function parseSSE(resp, onDelta) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', full = '';
    function handleLine(line) {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        const piece = (delta && delta.content) || '';
        if (piece) {
          full += piece;
          if (onDelta) onDelta(piece);
        }
        // 注：推理模型的 delta.reasoning_content 在此被静默忽略——V0.5.1 曾透传给 UI
        // 做"思考过程折叠展示"，体验后认为易出戏而移除；推理参数下发不受影响。
      } catch (e) { /* 忽略无法解析的行 */ }
    }
    async function pump() {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, idx).trim());
          buffer = buffer.slice(idx + 1);
        }
      }
      // flush：流结束时可能没有尾随换行，最后一段 data: 事件不能丢
      if (buffer.trim()) handleLine(buffer.trim());
      return full;
    }
    return pump();
  }

  const DEFAULT_TIMEOUT = 30000;

  /**
   * 生效超时（毫秒）：取全局设置 llmTimeout（秒，默认 60）；两种深度思考模式的放大策略不同。
   *   模式二（推理模型）：思考发生在供应商侧、耗时不可控，强制不低于 90 秒；
   *   模式一（CoT 引导）：只是让模型多输出几十个思考 token，给 10 秒余量足够。
   * 两者同开时按更严格的模式二处理。
   */
  function effectiveTimeout(profile) {
    const s = (global.AppSettings && global.AppSettings.get()) || {};
    const sec = (s.llmTimeout != null && +s.llmTimeout > 0) ? +s.llmTimeout : 60;
    const cfg = getConfig(profile);
    const r = inferReasoning({ model: cfg.model, reasoning: cfg.reasoning });
    if (r.params || cfg.reasoning !== 'off') return Math.max(sec, 90) * 1000;
    if (cfg.cotGuide !== 'off') return (sec + 10) * 1000;
    return sec * 1000;
  }

  /** 发起 chat/completions 请求（公共：超时/取消/错误处理），返回 fetch Response */
  async function postChatImpl(body, opts, timeoutMs) {
    const cfg = getConfig(opts.profile);
    if (!cfg.baseUrl || !cfg.apiKey) throw new Error('未配置 API：请点击右上角「设置」填写接口地址与 API Key');
    if (!cfg.model) throw new Error('未配置模型名称');
    const inner = new AbortController();
    const onOuterAbort = () => inner.abort();
    if (opts.signal) {
      if (opts.signal.aborted) inner.abort();
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => inner.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(endpoint(cfg.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
        signal: inner.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        if (opts.signal && opts.signal.aborted) throw e; // 用户主动取消，保持原语义
        throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），请检查网络或稍后重试');
      }
      throw new Error('网络请求失败：' + (e.message || e));
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
    }
    if (!resp.ok) {
      let detail = '';
      try { const j = await resp.json(); detail = (j.error && (j.error.message || j.error.code)) || JSON.stringify(j).slice(0, 300); }
      catch (e) { detail = (await resp.text().catch(() => '')).slice(0, 300); }
      throw new Error('API 返回错误 ' + resp.status + '：' + detail);
    }
    return resp;
  }

  /**
   * postChat 日志包装（V0.5.1）：每次请求记成功/失败与耗时到 Logger（cat=llm）。
   * 覆盖走子/聊天/解说/复盘/连接测试等全部路径；用户主动取消不记（噪音）。
   */
  async function postChat(body, opts) {
    const cfg = getConfig(opts.profile);
    const t0 = Date.now();
    const timeoutMs = opts.timeout != null ? opts.timeout : effectiveTimeout(opts.profile);
    try {
      const resp = await postChatImpl(body, opts, timeoutMs);
      const L = global.Logger;
      if (L) L.info('llm', 'chat_ok', { ms: Date.now() - t0, profile: opts.profile, model: cfg.model, stream: !!body.stream, tools: !!(body.tools && body.tools.length) });
      return resp;
    } catch (e) {
      const cancelled = !!(opts.signal && opts.signal.aborted && e.name === 'AbortError');
      const L = global.Logger;
      if (L && !cancelled) {
        L.warn('llm', 'chat_error', { ms: Date.now() - t0, profile: opts.profile, model: cfg.model, stream: !!body.stream, err: (e && e.message) || String(e) });
      }
      throw e;
    }
  }

  function baseBody(messages, opts) {
    const cfg = getConfig(opts.profile);
    const body = {
      model: cfg.model,
      messages,
      stream: !!opts.stream,
    };
    // 深度思考：off 时 r.params=null，body 与旧版逐字节一致（temperature/max_tokens 照旧）
    const r = inferReasoning({ model: cfg.model, reasoning: cfg.reasoning });
    if (r.params) Object.assign(body, r.params);
    if (!r.omitTemp) body.temperature = opts.temperature != null ? opts.temperature : 0.8;
    body[r.tokenKey] = Math.max(opts.maxTokens || 1024, r.tokenFloor || 0);
    return body;
  }

  /** 常规请求：返回回复文本（流式时为累积全文） */
  async function request(messages, opts) {
    opts = opts || {};
    const body = baseBody(messages, opts);
    if (opts.tools) body.tools = opts.tools;
    if (opts.toolChoice != null) body.tool_choice = opts.toolChoice;
    const resp = await postChat(body, opts);
    if (!opts.stream) {
      const j = await resp.json();
      const msg = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message : {};
      const content = typeof msg.content === 'string' ? msg.content : '';
      // 降级兼容：响应只有工具调用没有文本时，返回空字符串由调用方处理
      return content;
    }
    return parseSSE(resp, opts.onDelta);
  }

  /** 容错解析工具参数 JSON（部分模型会包 markdown 或加引号） */
  function parseArgs(s) {
    if (!s) return {};
    try { return JSON.parse(s); } catch (e) { /* fallthrough */ }
    const j = extractJSON(s);
    return j || {};
  }

  /**
   * Function Calling 请求：非流式，返回结构化响应
   * @param {Array} messages 消息数组
   * @param {Object} opts { tools, toolChoice, temperature, maxTokens, signal, timeout }
   * @returns {{content:string, toolCalls:Array<{id:string,name:string,args:object}>, raw:object}}
   */
  async function requestFull(messages, opts) {
    opts = opts || {};
    const body = baseBody(messages, opts);
    body.stream = false;
    if (opts.tools) body.tools = opts.tools;
    if (opts.toolChoice != null) body.tool_choice = opts.toolChoice;
    const resp = await postChat(body, opts);
    const j = await resp.json();
    const msg = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message : {};
    const content = typeof msg.content === 'string' ? msg.content : (msg.content ? String(msg.content) : '');
    const toolCalls = [];
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc.function || !tc.function.name) continue;
        toolCalls.push({
          id: tc.id || '',
          name: tc.function.name,
          args: parseArgs(tc.function.arguments),
        });
      }
    }
    return { content, toolCalls, raw: j };
  }

  /** 从模型输出中稳健提取 JSON 对象（降级路径用） */
  function extractJSON(text) {
    if (!text) return null;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const cand = fence ? fence[1] : text;
    const start = cand.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cand.length; i++) {
      const ch = cand[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(cand.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  /** 连接测试（用当前 settings 中该组的配置发一条最小请求） */
  async function testConnection(profile) {
    const r = await request(
      [{ role: 'user', content: '请只回复四个字：连接成功' }],
      { stream: false, maxTokens: 20, temperature: 0, profile }
    );
    return (r || '').trim();
  }

  global.LLMClient = {
    PROVIDERS, getConfig, fcEnabled, request, requestFull, extractJSON, testConnection, inferReasoning, effectiveTimeout,
    // 模式一：本地 CoT 引导（提示词工程）
    COT_LEVELS, COT_SPEC, COT_STEPS, buildCoTGuide,
  };
})(typeof window !== 'undefined' ? window : globalThis);
