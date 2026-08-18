/* ============================================================
 * llm.js — OpenAI 兼容 API 客户端（纯前端直连）
 * 支持流式 SSE 输出、JSON 提取、连接测试
 * 配置来源：AppSettings（localStorage）
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

  async function request(messages, opts) {
    opts = opts || {};
    const cfg = getConfig();
    if (!cfg.baseUrl || !cfg.apiKey) throw new Error('未配置 API：请点击右上角「设置」填写接口地址与 API Key');
    if (!cfg.model) throw new Error('未配置模型名称');
    const body = {
      model: cfg.model,
      messages,
      stream: !!opts.stream,
      temperature: opts.temperature != null ? opts.temperature : 0.8,
      max_tokens: opts.maxTokens || 1024,
    };
    // 组合外部取消信号 + 内置超时，避免 API 挂起导致对局永远卡在"思考中"
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
    if (!opts.stream) {
      const j = await resp.json();
      const content = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
      return content || '';
    }
    return parseSSE(resp, opts.onDelta);
  }

  /** 从模型输出中稳健提取 JSON 对象 */
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

  global.LLMClient = { PROVIDERS, getConfig, request, extractJSON, testConnection };
})(typeof window !== 'undefined' ? window : globalThis);
