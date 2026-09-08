/* ============================================================
 * fc.js — Function Calling 工具定义与降级状态
 * 工具（OpenAI tools schema，仅供 LLM 调用；纯文本回复仍走 content）：
 *   play_move(move, thought)         AI 走子
 *   answer_undo(allow, reply, affinity_delta?)  悔棋裁决
 *   adjust_affinity(delta, reason)   好感度调分（聊天两阶段预判用）
 * 降级：FC 请求被服务商拒绝（400/tools 不支持）后，本次会话内该 LLM
 *       配置组（human/red/black 相互隔离）自动回退到 JSON 提取 /
 *       [♥±n] 标记机制，每组首次降级提示一次。
 * ============================================================ */
(function (global) {
  'use strict';

  const PLAY_MOVE = {
    type: 'function',
    function: {
      name: 'play_move',
      description: '选择并提交你（AI 棋手）要走的一步棋。move 必须是候选走法列表中的坐标字符串（列字母 a-i 左到右 + 行数字 0-9 上到下，如 h7e7 表示红方二路炮平五）；thought 是你走这步时的心理活动/垃圾话，口语化、符合人设。',
      parameters: {
        type: 'object',
        properties: {
          move: { type: 'string', description: '走法坐标，如 h9e9' },
          thought: { type: 'string', description: '一句符合人设的心理活动/垃圾话，不要书面分析' },
        },
        required: ['move', 'thought'],
        additionalProperties: false,
      },
    },
  };

  const ANSWER_UNDO = {
    type: 'function',
    function: {
      name: 'answer_undo',
      description: '裁决玩家刚刚提出的悔棋请求。allow 为 true 表示同意悔棋，false 表示驳回；reply 是你对玩家说的话（口语化、符合人设，1~3 句）；affinity_delta 可选，表示这次互动后你对玩家好感的增减（整数，范围 -5 ~ 5，0 表示不变）。',
      parameters: {
        type: 'object',
        properties: {
          allow: { type: 'boolean', description: '是否同意悔棋' },
          reply: { type: 'string', description: '对玩家的回复，1~3 句口语，不要 Markdown' },
          affinity_delta: { type: 'integer', description: '好感度增减（可选，-5 ~ 5）' },
        },
        required: ['allow', 'reply'],
        additionalProperties: false,
      },
    },
  };

  const ADJUST_AFFINITY = {
    type: 'function',
    function: {
      name: 'adjust_affinity',
      description: '根据玩家最近的言行调整你对他的好感度（0~100，初始 50）。delta 为增减值（整数，-10 ~ 10，不含 0）；reason 说明原因（内部记录用，不会显示给玩家）。只在玩家态度明显变好或变差时调用。',
      parameters: {
        type: 'object',
        properties: {
          delta: { type: 'integer', description: '好感度增减（-10 ~ 10，不含 0）' },
          reason: { type: 'string', description: '调整原因，一句话即可' },
        },
        required: ['delta', 'reason'],
        additionalProperties: false,
      },
    },
  };

  /* ---------- 降级状态（会话内存态，按 LLM 配置组隔离） ---------- */
  // human = 人机对战组；red/black = 观战红/黑 AI 组。
  // 不同组可能接不同服务商，某组降级不应连累其他组。
  const fallbacks = {
    human: { active: false, notified: false },
    red: { active: false, notified: false },
    black: { active: false, notified: false },
  };
  function fb(profile) { return fallbacks[profile] || fallbacks.human; }
  function markFallback(profile) {
    fb(profile).active = true;
    // 降级事件入日志（cat=llm，供「日志」页签追溯）
    const L = global.Logger;
    if (L) L.warn('llm', 'fc_fallback', { profile });
  }
  function resetFallback(profile) {
    // 不带参数：全部重置（保存设置等整体刷新场景）
    if (!profile) {
      Object.keys(fallbacks).forEach(k => { fallbacks[k].active = false; fallbacks[k].notified = false; });
      return;
    }
    fb(profile).active = false;
    fb(profile).notified = false;
  }
  /** 首次降级返回 true（调用方应提示用户一次），后续静默 */
  function ensureNotified(profile) {
    const f = fb(profile);
    if (!f.notified) { f.notified = true; return true; }
    return false;
  }
  /** 该组当前是否处于 FC 降级状态 */
  function isFallback(profile) { return fb(profile).active; }
  /** 判断错误是否因服务商不支持 tools（400/Bad Request/tools 相关） */
  function isFcUnsupportedError(e) {
    const msg = String((e && e.message) || e);
    return /400|bad request|tools|function calling|not support|unsupported/i.test(msg);
  }

  global.FCTools = {
    PLAY_MOVE, ANSWER_UNDO, ADJUST_AFFINITY,
    ALL: [PLAY_MOVE, ANSWER_UNDO, ADJUST_AFFINITY],
    // 兼容导出：fallback 指向 human 组的活引用（旧代码 FCTools.fallback.active 仍可读）
    fallback: fallbacks.human,
    markFallback, resetFallback, ensureNotified, isFallback, isFcUnsupportedError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
