/* ============================================================
 * logger.js — 轻量运行日志（V0.5.1）
 * 用途：记录 LLM 调用（成功/失败/降级/耗时）、引擎慢搜索、设置变更、
 *       未捕获错误等，供设置面板「日志」页签查看与导出排障。
 * 设计：
 *   - 环形缓冲：内存保留最近 1000 条；localStorage 持久最近 300 条
 *     （防抖写入，刷新后仍可追溯）。
 *   - 类别 cat：llm / engine / settings / app / error（面板可按类别/级别筛选）
 *   - 级别 level：info / warn / error
 *   - 脱敏：永不记录 apiKey 等密钥；字符串值中的密钥片段（sk-…）一律打码
 *   - 摘要优先：记录结构化字段（profile/model/ms/err），不回存完整请求响应
 * 对外接口：
 *   Logger.info/warn/error(cat, ev, fields)   快捷记录
 *   Logger.log(cat, level, ev, fields)        通用记录
 *   Logger.all({cat, level, limit})           读取（新→旧）
 *   Logger.clear()                            清空内存与持久
 *   Logger.export()                           全部记录 JSON 字符串（脱敏后）
 * ============================================================ */
(function (global) {
  'use strict';

  const MAX_MEM = 1000;        // 内存环形上限
  const PERSIST_MAX = 300;     // localStorage 持久条数
  const LS_KEY = 'aixq_logs';  // 持久化键
  const LEVELS = ['info', 'warn', 'error'];
  const CATS = ['llm', 'engine', 'settings', 'app', 'error'];

  /** localStorage 读取（容错：坏 JSON/被篡改 → 空） */
  function loadPersisted() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(LS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(x => x && typeof x === 'object') : [];
    } catch (e) { return []; }
  }
  let buffer = loadPersisted().slice(-PERSIST_MAX); // 持久记录先入内存，保证跨刷新连续性
  let persistTimer = null;

  function persist() {
    try {
      if (!global.localStorage) return;
      const tail = buffer.slice(-PERSIST_MAX);
      global.localStorage.setItem(LS_KEY, JSON.stringify(tail));
    } catch (e) { /* 配额满/隐私模式：静默丢弃持久层，内存层不受影响 */ }
  }
  function persistSoon() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 400);
  }

  /* ---------- 脱敏 ---------- */
  // 字段名匹配：apiKey/api_key/api-key/Authorization/secret/token/password（不匹配 keys/keyboard 等普通词）
  const SENSITIVE_KEY = /api[_-]?key|authorization|secret|token|password/i;
  const SECRET_PATTERN = /sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}/g;
  /** 字段值消毒：字符串截断 + 密钥打码；危险字段名一律丢弃 */
  function sanitizeValue(k, v) {
    if (SENSITIVE_KEY.test(k)) return '[REDACTED]';
    let s;
    if (v == null) s = '';
    else if (typeof v === 'string') s = v;
    else if (typeof v === 'object') { try { s = JSON.stringify(v); } catch (e) { s = String(v); } }
    else s = String(v);
    s = s.replace(SECRET_PATTERN, '[REDACTED]');
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  }

  /* ---------- 记录 ---------- */
  /** @param {string} cat  llm|engine|settings|app|error
   *  @param {string} level info|warn|error
   *  @param {string} ev    事件名（英文短名，面板直接展示）
   *  @param {Object} fields 结构化字段（自动脱敏；apiKey/token 类字段名丢弃） */
  function log(cat, level, ev, fields) {
    const c = CATS.indexOf(cat) >= 0 ? cat : 'app';
    const lv = LEVELS.indexOf(level) >= 0 ? level : 'info';
    const entry = { ts: Date.now(), cat: c, level: lv, ev: String(ev || '') };
    if (fields && typeof fields === 'object') {
      Object.keys(fields).forEach(k => {
        if (k === 'ts' || k === 'cat' || k === 'level' || k === 'ev') return;
        entry[k] = sanitizeValue(k, fields[k]);
      });
    }
    buffer.push(entry);
    if (buffer.length > MAX_MEM) buffer = buffer.slice(-MAX_MEM);
    persistSoon();
    return entry;
  }

  const Logger = {
    MAX_MEM, PERSIST_MAX,
    log,
    info(cat, ev, fields) { return log(cat, 'info', ev, fields); },
    warn(cat, ev, fields) { return log(cat, 'warn', ev, fields); },
    error(cat, ev, fields) { return log(cat, 'error', ev, fields); },
    /** 读取（新→旧）。opts：{cat, level, limit} */
    all(opts) {
      opts = opts || {};
      let out = buffer.slice();
      if (opts.cat) out = out.filter(e => e.cat === opts.cat);
      if (opts.level) out = out.filter(e => e.level === opts.level);
      out.reverse();
      return opts.limit ? out.slice(0, opts.limit) : out;
    },
    clear() {
      buffer = [];
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      try { if (global.localStorage) global.localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
    },
    export() {
      return JSON.stringify(buffer, null, 2);
    },
  };

  global.Logger = Logger;
})(typeof window !== 'undefined' ? window : globalThis);
