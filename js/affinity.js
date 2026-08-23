/* ============================================================
 * affinity.js — 对手好感度系统（本地量化 + LLM 工具调分）
 * 数值：0~100 整数，初始 50，按人设 id 持久化到 localStorage
 * 用途：
 *   - 悔棋审批的本地量化标准（档位兜底）与 LLM 裁决参考
 *   - 「提示」的门槛（低好感拒绝）与使用消耗
 *   - 认输/复盘的语气分档（低/中/高）
 *   - 本地自动调分（辱骂/礼貌/好棋/臭棋/悔棋） + LLM 隐藏标记 [♥±n]
 * 对外接口：
 *   Affinity.get(personaId) / set / adjust / reset / resetAll / remove
 *   Affinity.tier(v) / tierLabel(v)
 *   Affinity.hintCost(v)
 *   Affinity.getAll()
 *   Affinity.detectLocalDelta(text)        辱骂/礼貌 → ±分
 *   Affinity.stripAffinityMarkers(text)    剥离 [♥±n] 标记 → {text, delta, pending}
 *   Affinity.onChange(info)                调分回调（main.js 注册 UI）
 * ============================================================ */
(function (global) {
  'use strict';

  const LS_KEY = 'aixq_affinity';
  const DEFAULT_VALUE = 50;
  const MIN = 0, MAX = 100;
  const HINT_REFUSE_THRESHOLD = 35; // 好感度低于此值拒绝「提示」
  // 档位：低 <40 / 中 40~69 / 高 ≥70
  const TIER_LOW_MAX = 39, TIER_MID_MAX = 69;

  /* ---------- 本地自动调分关键词（重度 -8 / 轻度 -3 / 礼貌 +2） ---------- */
  // 重度辱骂：明确人身攻击/辱骂/威胁，命中 -8
  const RUDE_KEYWORDS = [
    '傻逼', '煞笔', '沙比', '弱智', '智障', '白痴', '脑残', '蠢货', '笨蛋',
    '垃圾', '废物', '菜鸡', '菜逼', '猪脑子', '狗东西', '去死', '滚蛋',
    '混蛋', '王八蛋', '妈的', '操你', '草泥马', 'fuck', 'shit', 'idiot', 'stupid',
    // 扩充：常见辱骂/人身攻击/威胁
    '大傻子', '傻子', '蠢蛋', '蠢猪', '变态', '人渣', '废柴', '渣渣', '狗屎',
    '傻叉', '二百五', '低能', '草包', '饭桶', '窝囊废', '孬种', '杂种', '贱人',
    '贱货', '婊子', '不要脸', '缺德', '傻狗', '菜狗', '杂碎', '畜生', '禽兽',
    '猪头', '闭嘴', '放屁', '狗屁', '弄死', '打死', '虐死', '略死', '神经病', '蠢狗',
  ];
  // 轻度挑衅：轻蔑/嘲讽/嫌弃，命中 -3（"杂鱼"是「小魅」人设口头禅，不计入）
  const MILD_INSULT_KEYWORDS = [
    '菜鸟', '傻瓜', '笨猪', '呆子', '二愣子', '傻乎乎', '傻帽', '不开窍',
    '榆木疙瘩', '臭棋', '臭棋篓子', '辣鸡', '手残', '蠢笨', '菜得抠脚',
  ];
  // 礼貌用语：命中 +2
  const POLITE_KEYWORDS = [
    '谢谢', '感谢', '多谢', '辛苦', '拜托', '请教', '承让', '佩服',
    '大佬', '大师', '高人', '您',
  ];

  /* ---------- 悔棋惩罚窗口（内存态，不持久化） ---------- */
  // 悔棋后 4 步内好感度只减不加，防止悔棋 -1 被紧接着的好棋/礼貌/LLM 加分立即抵消
  const UNDO_PENALTY_STEPS = 4;
  const penalties = {}; // personaId -> 剩余步数
  function isPenalized(personaId) { return (penalties[personaId] || 0) > 0; }

  // 每次从 localStorage 读取（无内存缓存）：数据量极小，保证外部修改/测试可见
  function load() {
    const s = {};
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(raw)) {
          // 过滤危险键，防止被篡改的 localStorage 污染原型
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          const v = +raw[k];
          if (Number.isFinite(v)) s[k] = clamp(v);
        }
      }
    } catch (e) { /* 损坏数据按空处理 */ }
    return s;
  }
  function persist(data) { try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ } }
  function clamp(v) {
    v = Math.round(+v);
    if (!Number.isFinite(v)) return DEFAULT_VALUE;
    return Math.max(MIN, Math.min(MAX, v));
  }
  function notify(info) {
    if (info && global.Affinity && typeof global.Affinity.onChange === 'function') {
      try { global.Affinity.onChange(info); } catch (e) { /* ignore */ }
    }
  }

  const Affinity = {
    DEFAULT_VALUE, MIN, MAX, HINT_REFUSE_THRESHOLD,
    RUDE_KEYWORDS, MILD_INSULT_KEYWORDS, POLITE_KEYWORDS,
    onChange: null,

    get(personaId) {
      const s = load();
      return s[personaId] != null ? clamp(s[personaId]) : DEFAULT_VALUE;
    },
    set(personaId, v) {
      const s = load();
      const before = Affinity.get(personaId);
      const after = clamp(v);
      s[personaId] = after;
      persist(s);
      if (after !== before) notify({ personaId, before, after, delta: after - before });
      return after;
    },
    /** 加减分（clamp 到 0~100）。delta 为 0 或非法时返回 null；
     *  悔棋惩罚窗口内正 delta 被抑制（只减不加），负 delta 照常 */
    adjust(personaId, delta) {
      delta = Math.round(+delta);
      if (!Number.isFinite(delta) || delta === 0) return null;
      if (delta > 0 && isPenalized(personaId)) return null;
      const s = load();
      const before = Affinity.get(personaId);
      const after = clamp(before + delta);
      s[personaId] = after;
      persist(s);
      const info = { personaId, before, after, delta: after - before };
      notify(info);
      return info;
    },

    /** 好感度档位：low <40 / mid 40~69 / high ≥70 */
    tier(v) {
      v = clamp(v);
      if (v < 40) return 'low';
      if (v <= 69) return 'mid';
      return 'high';
    },
    tierLabel(v) {
      return { low: '冷淡', mid: '一般', high: '友好' }[Affinity.tier(v)];
    },

    /** 「提示」消耗：max(1, 5 - floor(好感/25))，好感越低消耗越狠 */
    hintCost(v) {
      return Math.max(1, 5 - Math.floor(clamp(v) / 25));
    },

    /* ---------- 悔棋惩罚窗口：悔棋后 4 步内只减不加 ---------- */
    UNDO_PENALTY_STEPS,
    /** 悔棋请求（扣 -1）时启动：此后 4 步内该对手好感度只减不加 */
    startUndoPenalty(personaId) { penalties[personaId] = UNDO_PENALTY_STEPS; },
    isUndoPenaltyActive(personaId) { return isPenalized(personaId); },
    /** 每走一步调用：所有惩罚窗口递减 1，归零后自动移除 */
    tickPenalties() {
      for (const k of Object.keys(penalties)) {
        penalties[k] -= 1;
        if (penalties[k] <= 0) delete penalties[k];
      }
    },
    /** 新开对局/切换模式时清空惩罚窗口 */
    clearPenalties() { for (const k of Object.keys(penalties)) delete penalties[k]; },

    reset(personaId) { return Affinity.set(personaId, DEFAULT_VALUE); },
    resetAll() {
      const s = load();
      for (const k of Object.keys(s)) {
        if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') delete s[k];
      }
      persist(s);
      notify({ personaId: null, before: 0, after: DEFAULT_VALUE, delta: 0, all: true });
    },
    /** 删除人设时清理其好感度记录 */
    remove(personaId) {
      const s = load();
      if (personaId in s) { delete s[personaId]; persist(s); return true; }
      return false;
    },
    getAll() {
      const s = load();
      return Object.keys(s).map(k => ({ personaId: k, value: clamp(s[k]) }));
    },

    /** 本地自动调分：重度辱骂 -8（优先）> 轻度挑衅 -3 > 礼貌 +2；均未命中返回 0 */
    detectLocalDelta(text) {
      const t = String(text || '').toLowerCase();
      for (const k of RUDE_KEYWORDS) if (t.includes(k)) return -8;
      for (const k of MILD_INSULT_KEYWORDS) if (t.includes(k)) return -3;
      for (const k of POLITE_KEYWORDS) if (t.includes(k)) return +2;
      return 0;
    },

    /** 剥离 LLM 回复中的隐藏调分标记 [♥+n] / [♥-n]（可能出现在任意位置，
     *  但约定放在末尾）。返回 { text, delta, pending }，
     *  pending 为尾部未闭合的 '[♥…'（流式跨 chunk 时暂存）。 */
    stripAffinityMarkers(text) {
      let delta = 0;
      let clean = String(text || '').replace(/\[♥([+-]\d+)\]\s*/g, (m, n) => { delta += parseInt(n, 10); return ''; });
      let pending = '';
      const idx = clean.lastIndexOf('[♥');
      if (idx >= 0 && clean.indexOf(']', idx) === -1) {
        pending = clean.slice(idx);
        clean = clean.slice(0, idx);
      }
      return { text: clean, delta, pending };
    },
  };

  global.Affinity = Affinity;
})(typeof window !== 'undefined' ? window : globalThis);
