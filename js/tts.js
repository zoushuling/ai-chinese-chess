/* ============================================================
 * tts.js — AI 发言配音（TTS）
 * 双引擎：
 *   1. 浏览器自带 speechSynthesis（默认，免费离线）：可自选系统音色（设置里下拉），
 *      人设可绑定专属音色（人设弹窗），棋风映射音调/语速
 *   2. 云端 TTS（自然度高，需单独配置）：
 *      a. OpenAI 兼容 /audio/speech 接口（mp3）：音色名直接传给 API
 *      b. 小米 MiMo（mimo-v2.5-tts 系列）：/chat/completions 格式，
 *         文本放 assistant 消息，返回 base64 音频（本地解码为 Blob 播放）
 * 对外接口：
 *   TTS.isEnabled()                自动配音总开关（设置项）
 *   TTS.styleVoice(style)          棋风 → {pitch, rate} 音色参数
 *   TTS.begin(voice)               开始一段新的朗读（打断旧朗读）
 *   TTS.feed(text)                 流式增量喂入，按句切分即时朗读
 *   TTS.flush()                    收尾：把无结尾标点的残段读出
 *   TTS.stop()                     停止当前朗读并清空队列
 *   TTS.speakText(text, voice)     完整文本一次性朗读（气泡重读用）
 *   TTS.preview(voice)             试听一句（设置弹窗用）
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 人设音色：棋风 → 音调/语速 ---------- */
  const STYLE_VOICE = {
    aggressive: { pitch: 0.80, rate: 1.12 },  // 嚣张/暴躁/小魅：低沉快速
    solid:      { pitch: 0.90, rate: 0.92 },  // 稳健老先生：沉稳缓慢
    balanced:   { pitch: 1.00, rate: 1.05 },  // 毒舌解说：标准稍快
    risky:      { pitch: 0.85, rate: 0.95 },  // 寡言剑客：低沉平缓
    cautious:   { pitch: 1.25, rate: 1.05 },  // 学棋妹妹：明亮活泼
  };

  function cfg() {
    const s = (global.AppSettings && global.AppSettings.get()) || {};
    return {
      enabled: s.ttsEnabled !== false,
      engine: s.ttsEngine === 'cloud' ? 'cloud' : 'browser',
      baseUrl: (s.ttsBaseUrl || '').trim(),
      apiKey: (s.ttsApiKey || '').trim(),
      model: (s.ttsModel || '').trim(),
      voice: (s.ttsVoice || '').trim(),
      provider: (s.ttsProvider || 'openai').trim(), // 云端服务商（决定请求格式）
      browserVoice: (s.ttsBrowserVoice || 'auto').trim(), // 'auto' = 自动选择
    };
  }

  /* ---------- 云端 TTS 服务商预设（统一 OpenAI 兼容 /audio/speech 格式） ---------- */
  const TTS_PROVIDERS = [
    {
      id: 'openai', name: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', model: 'tts-1',
      voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
    },
    {
      id: 'ark', name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '',
      voices: [
        'zh_female_shuangkuaisisi_mars_bigtts', // 爽快思思
        'zh_female_wanwanxiaohei_mars_bigtts',  // 湾湾小黑
        'zh_male_jingqiangkaka_mars_bigtts',    // 京腔卡卡
        'zh_male_yuanlong_mars_bigtts',         // 元气龙
        'zh_female_xiaoqing_mars_bigtts',       // 晓青
        'zh_male_xiaoming_mars_bigtts',         // 小明
        'zh_female_xiaobei_mars_bigtts',        // 小北
        'zh_male_momo_mars_bigtts',             // 默默
      ],
    },
    {
      id: 'dashscope', name: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-tts-flash',
      voices: ['Cherry', 'Serena', 'Claire', 'Luca', 'Ethan'],
    },
    {
      // 小米 MiMo：OpenAI 兼容平台的 TTS，走 /chat/completions（文本放 assistant 消息，
      // audio.voice 传预置音色 ID，响应 choices[0].message.audio.data 为 base64 音频）
      id: 'mimo', name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-tts',
      voices: ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'],
    },
    {
      id: 'custom', name: '自定义', baseUrl: '', model: '',
      voices: [],
    },
  ];

  /** 全部预设音色（人设下拉的云端分组用） */
  function getAllPresetVoices() {
    const set = new Set();
    for (const p of TTS_PROVIDERS) for (const v of p.voices || []) set.add(v);
    return [...set];
  }

  function cloudReady(c) { return !!(c.baseUrl && c.apiKey && c.model && c.voice); }

  /* ---------- 句子切分 ---------- */
  // 句尾标点（含叠标点）或换行视为一句结束
  const SENT_END = /[。！？；…!?;\n]+/g;

  /** 从缓冲中切出所有完整句，返回 {sentences, rest} */
  function splitSentences(buf) {
    const sentences = [];
    let rest = buf;
    let m, lastEnd = -1;
    SENT_END.lastIndex = 0;
    while ((m = SENT_END.exec(rest)) !== null) lastEnd = m.index + m[0].length;
    if (lastEnd > 0) {
      sentences.push(rest.slice(0, lastEnd));
      rest = rest.slice(lastEnd);
    }
    return { sentences, rest };
  }

  /* ---------- 朗读队列 ---------- */
  // 状态：queue 为待读句子；speaking 标记是否正在出声；
  // token 用于丢弃被 stop 打断的旧回调
  const state = {
    queue: [],
    speaking: false,
    token: 0,
    voice: null,       // {pitch, rate}
    voiceName: '',     // 人设绑定音色名（可空）
    buffer: '',        // 流式喂入的未成句残段
    activeEngine: 'browser',
  };

  function voiceOf(v) {
    const base = STYLE_VOICE.balanced;
    return { pitch: v && v.pitch != null ? v.pitch : base.pitch, rate: v && v.rate != null ? v.rate : base.rate };
  }

  /* ---------- 引擎一：浏览器 speechSynthesis ---------- */
  let voices = [];
  function refreshVoices() {
    if (!global.speechSynthesis) return;
    try { voices = global.speechSynthesis.getVoices() || []; } catch (e) { voices = []; }
  }
  if (global.speechSynthesis) {
    refreshVoices();
    try { global.speechSynthesis.onvoiceschanged = refreshVoices; } catch (e) { /* ignore */ }
  }

  /** 列出系统全部中文语音（设置下拉用，按 名称|语言 去重；只列中文语言包） */
  function getBrowserVoices() {
    if (!voices.length) refreshVoices();
    const seen = new Set();
    const list = [];
    for (const v of voices) {
      if (!/^zh/i.test(v.lang || '')) continue; // 面向中文用户，只列中文语音
      const key = (v.name || '') + '|' + (v.lang || '');
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ name: v.name || '', lang: v.lang || '' });
    }
    return list;
  }

  /** 按名称关键字模糊匹配语音（优先中文语音） */
  function pickVoiceByName(key) {
    if (!key || !voices.length) return null;
    const k = String(key).toLowerCase();
    const all = voices.filter(v => (v.name || '').toLowerCase().includes(k));
    if (!all.length) return null;
    return all.find(v => /^zh/i.test(v.lang || '')) || all[0];
  }

  /** 挑中文语音：优先 zh-CN/zh，其次常见中文音色名 */
  function pickZhVoice() {
    if (!voices.length) refreshVoices();
    const zh = voices.filter(v => /^zh(-|_|$)/i.test(v.lang || ''));
    if (!zh.length) return null;
    const prefer = zh.find(v => /(xiaoxiao|yunxi|yunyang|huihui|yaoyao|kangkang|tingting)/i.test(v.name || ''));
    return prefer || zh.find(v => /zh[-_]CN/i.test(v.lang || '')) || zh[0];
  }

  /** 解析浏览器引擎最终音色：人设绑定 > 设置默认 > 自动挑选 */
  function resolveBrowserVoice() {
    const c = cfg();
    const named = pickVoiceByName(state.voiceName)
      || (c.browserVoice && c.browserVoice !== 'auto' ? pickVoiceByName(c.browserVoice) : null);
    return named || pickZhVoice();
  }

  function speakBrowser(text, voice, token, done) {
    const synth = global.speechSynthesis;
    if (!synth || typeof global.SpeechSynthesisUtterance === 'undefined') { done(); return; }
    const u = new global.SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    const v = resolveBrowserVoice();
    if (v && typeof v === 'object') { try { u.voice = v; } catch (e) { /* ignore */ } }
    u.pitch = Math.max(0, Math.min(2, voice.pitch));
    u.rate = Math.max(0.5, Math.min(2, voice.rate));
    u.onend = () => { if (token === state.token) done(); };
    u.onerror = () => { if (token === state.token) done(); };
    // Chrome 在 cancel() 后立即 speak 可能不出声，稍作缓冲
    setTimeout(() => {
      if (token !== state.token) return;
      try { synth.speak(u); } catch (e) { done(); }
    }, 50);
  }

  /* ---------- 引擎二：云端 TTS ---------- */
  /** 是否为小米 MiMo（官方 /chat/completions 格式）：预设选中或 Base URL 指向官方域名 */
  function isMimoProvider(c) {
    return !!c && (c.provider === 'mimo' || /xiaomimimo\.com/i.test(c.baseUrl || ''));
  }

  /** base64 → Blob（MiMo 响应携带 base64 音频数据） */
  function base64ToBlob(b64, mime) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }

  /** 小米 MiMo：POST {base}/chat/completions，文本放 assistant 消息，返回 base64 音频 */
  async function fetchMiMoAudio(text, voice) {
    const c = cfg();
    // 注意：绝不能使用 state.voiceName —— 它是人设绑定的浏览器音色名（如 yunyang/xiaoxiao），
    // MiMo 只认自己那套预置音色 ID（mimo_default/冰糖/Mia…），传错会 400 拒绝导致"没声音"。
    // 因此这里只用设置里的 MiMo 音色，缺省兜底 mimo_default。
    const voiceName = c.voice || 'mimo_default';
    // MiMo 无 speed 字段：把棋风音调/语速转成可选的 user 风格指令
    const msgs = [];
    const hints = [];
    if (voice && typeof voice.rate === 'number' && Math.abs(voice.rate - 1) > 0.06) {
      hints.push(voice.rate > 1 ? '语速稍快，干脆利落' : '语速稍缓，沉稳从容');
    }
    if (voice && typeof voice.pitch === 'number' && Math.abs(voice.pitch - 1) > 0.15) {
      hints.push(voice.pitch > 1 ? '音色明亮活泼' : '音色低沉平缓');
    }
    if (hints.length) msgs.push({ role: 'user', content: '朗读风格要求：' + hints.join('，') + '。' });
    msgs.push({ role: 'assistant', content: text });
    const body = {
      model: c.model || 'mimo-v2.5-tts',
      messages: msgs,
      audio: { format: 'mp3', voice: voiceName },
    };
    const url = c.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    // 20s 超时：云端 TTS 挂起时静默跳过，不让朗读队列卡死
    const timeoutSignal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(20000) : undefined;
    const doFetch = (authHeaders) => fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
    // 官方支持两种鉴权：先 Bearer，401/403 时改用 api-key 请求头重试一次
    let resp = await doFetch({ 'Authorization': 'Bearer ' + c.apiKey });
    if (resp.status === 401 || resp.status === 403) {
      resp = await doFetch({ 'api-key': c.apiKey });
    }
    if (!resp.ok) {
      const err = new Error('TTS API ' + resp.status);
      err.status = resp.status;
      throw err;
    }
    let j = null;
    try { j = await resp.json(); } catch (e) { j = null; }
    const data = j && j.choices && j.choices[0] && j.choices[0].message &&
      j.choices[0].message.audio && j.choices[0].message.audio.data;
    if (!data) {
      const err = new Error('MiMo TTS 响应缺少音频数据');
      err.status = 502;
      throw err;
    }
    return base64ToBlob(data, 'audio/mpeg');
  }

  async function fetchCloudAudio(text, voice, withSpeed) {
    const c = cfg();
    // 小米 MiMo 分流：chat/completions 格式（无 speed 字段，风格走 user 指令）
    if (isMimoProvider(c)) return fetchMiMoAudio(text, voice);
    // 音色优先级：人设绑定 > 设置默认云端音色
    const voiceName = state.voiceName || c.voice || 'alloy';
    const body = { model: c.model, input: text, voice: voiceName, response_format: 'mp3' };
    if (withSpeed) body.speed = Math.max(0.25, Math.min(4, voice.rate));
    // 20s 超时：云端 TTS 挂起时静默跳过，不让朗读队列卡死
    const timeoutSignal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(20000) : undefined;
    const resp = await fetch(c.baseUrl.replace(/\/+$/, '') + '/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
    if (!resp.ok) {
      const err = new Error('TTS API ' + resp.status);
      err.status = resp.status;
      throw err;
    }
    return await resp.blob();
  }

  /** 云端 TTS 失败时给出可见线索（否则静默吞掉，用户只会看到"没声音"） */
  function reportTtsError(e, text) {
    const msg = (e && e.message) ? e.message : String(e);
    try {
      if (typeof console !== 'undefined' && console.warn) console.warn('[TTS 云端失败]', msg, text && text.slice(0, 30));
    } catch (e2) { /* ignore */ }
    // 若有全局错误钩子（main.js 可接入以弹气泡提示），则通知
    if (global.onTtsError && typeof global.onTtsError === 'function') {
      try { global.onTtsError('TTS 无声音：' + msg); } catch (e3) { /* ignore */ }
    }
  }

  function speakCloud(text, voice, token, done) {
    (async () => {
      let blob;
      try {
        blob = await fetchCloudAudio(text, voice, true);
      } catch (e) {
        // 部分兼容端不支持 speed 字段：去掉 speed 重试一次
        if (e && (e.status === 400 || e.status === 422)) {
          try { blob = await fetchCloudAudio(text, voice, false); } catch (e2) { reportTtsError(e2, text); done(); return; }
        } else { reportTtsError(e, text); }
        done(); return;
      }
      if (token !== state.token) { done(); return; }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); if (token === state.token) done(); };
      audio.onerror = () => { URL.revokeObjectURL(url); if (token === state.token) done(); };
      try { await audio.play(); } catch (e) { URL.revokeObjectURL(url); done(); }
    })();
  }

  /* ---------- 队列驱动 ---------- */
  function next(token) {
    if (token !== state.token) return;
    if (!state.queue.length) { state.speaking = false; return; }
    const text = state.queue.shift();
    if (!text || !text.trim()) { next(token); return; }
    state.speaking = true;
    const voice = voiceOf(state.voice);
    if (state.activeEngine === 'cloud') speakCloud(text, voice, token, () => next(token));
    else speakBrowser(text, voice, token, () => next(token));
  }

  function enqueue(sentences) {
    if (!sentences.length) return;
    state.queue.push(...sentences.filter(s => s && s.trim()));
    if (!state.speaking) next(state.token);
  }

  /* ---------- 对外接口 ---------- */
  const TTS = {
    /** 自动配音总开关是否开启（气泡手动重读不受此限制） */
    isEnabled() { return cfg().enabled; },

    /** 棋风 → 音色参数 */
    styleVoice(style) { return STYLE_VOICE[style] || STYLE_VOICE.balanced; },

    /** 系统全部中文语音（设置/人设下拉用） */
    getBrowserVoices,

    /** 云端 TTS 服务商预设列表 */
    getProviders() { return TTS_PROVIDERS; },

    getProvider(id) { return TTS_PROVIDERS.find(p => p.id === id) || TTS_PROVIDERS[TTS_PROVIDERS.length - 1]; },

    /** 全部预设音色（人设下拉的云端分组用） */
    getAllPresetVoices,

    /** 开始一段新朗读：打断旧朗读并锁定音色（voice 可含 name = 人设绑定音色） */
    begin(voice) {
      TTS.stop();
      state.voice = voiceOf(voice);
      state.voiceName = (voice && voice.name) || '';
      const c = cfg();
      state.activeEngine = (c.engine === 'cloud' && cloudReady(c)) ? 'cloud' : 'browser';
      state.buffer = '';
    },

    /** 流式增量喂入：完整句立即入队朗读 */
    feed(text) {
      if (!text) return;
      state.buffer += text;
      const { sentences, rest } = splitSentences(state.buffer);
      state.buffer = rest;
      enqueue(sentences);
    },

    /** 收尾：把残段（无句尾标点的尾巴）读出 */
    flush() {
      if (state.buffer && state.buffer.trim()) {
        enqueue([state.buffer]);
      }
      state.buffer = '';
    },

    /** 停止一切朗读并清空队列 */
    stop() {
      state.token++;
      state.queue = [];
      state.buffer = '';
      state.speaking = false;
      if (global.speechSynthesis) { try { global.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
    },

    /** 完整文本一次性朗读（点气泡重读/试听用，不受总开关限制） */
    speakText(text, voice) {
      if (!text || !text.trim()) return;
      TTS.begin(voice);
      TTS.feed(text);
      TTS.flush();
    },

    /** 试听（设置弹窗） */
    preview(voice) {
      TTS.speakText('你好，我是你的象棋对手，来杀一盘？', voice);
    },
  };

  global.TTS = TTS;
})(typeof window !== 'undefined' ? window : globalThis);
