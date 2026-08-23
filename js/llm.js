/* ============================================================
 * llm.js — OpenAI 兼容 API 客户端（纯前端直连）
 * 支持流式 SSE 输出、JSON 提取、Function Calling（tools）、连接测试
 * 配置来源：AppSettings（localStorage）
 * 对外接口：
 *   LLMClient.request(messages, opts)        返回 content 文本（流式/非流式）
 *   LLMClient.requestFull(messages, opts)    非流式，返回 {content, toolCalls, raw}
 *   LLMClient.extractJSON(text)              降级用的 JSON 提取
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

  function getConfig() {
    const s = (global.AppSettings && global.AppSettings.get()) || {};
    return {
      baseUrl: (s.apiBaseUrl || '').trim(),
      apiKey: (s.apiKey || '').trim(),
      model: (s.apiModel || '').trim(),
    };
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
        if (piece) { full += piece; if (onDelta) onDelta(piece); }
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

  /** 发起 chat/completions 请求（公共：超时/取消/错误处理），返回 fetch Response */
  async function postChat(body, opts) {
    const cfg = getConfig();
    if (!cfg.baseUrl || !cfg.apiKey) throw new Error('未配置 API：请点击右上角「设置」填写接口地址与 API Key');
    if (!cfg.model) throw new Error('未配置模型名称');
    const timeoutMs = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT;
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

  function baseBody(messages, opts) {
    return {
      model: getConfig().model,
      messages,
      stream: !!opts.stream,
      temperature: opts.temperature != null ? opts.temperature : 0.8,
      max_tokens: opts.maxTokens || 1024,
    };
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

  async function testConnection() {
    const r = await request(
      [{ role: 'user', content: '请只回复四个字：连接成功' }],
      { stream: false, maxTokens: 20, temperature: 0 }
    );
    return (r || '').trim();
  }

  global.LLMClient = { PROVIDERS, getConfig, request, requestFull, extractJSON, testConnection };
})(typeof window !== 'undefined' ? window : globalThis);
