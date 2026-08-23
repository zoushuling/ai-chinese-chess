/* Function Calling 单元测试（Node）：node tests/test_fc.js
 * 覆盖：requestFull 结构化响应/tool_calls 解析、args 容错、
 *       请求体 tools/tool_choice、降级状态（markFallback/ensureNotified/判定）
 */
'use strict';

/* ---------- 桩 ---------- */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.AppSettings = {
  get: () => ({ apiBaseUrl: 'https://api.example.com/v1', apiKey: 'test-key', apiModel: 'test-model' }),
};

require('../js/llm.js');
require('../js/fc.js');
const LLM = globalThis.LLMClient;
const FCT = globalThis.FCTools;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

(async () => {
  console.log('== 工具 schema 结构 ==');
  check('play_move schema', FCT.PLAY_MOVE.function.name === 'play_move' &&
    FCT.PLAY_MOVE.function.parameters.required.includes('move') &&
    FCT.PLAY_MOVE.function.parameters.required.includes('thought'));
  check('answer_undo schema', FCT.ANSWER_UNDO.function.name === 'answer_undo' &&
    FCT.ANSWER_UNDO.function.parameters.required.join(',') === 'allow,reply' &&
    FCT.ANSWER_UNDO.function.parameters.properties.affinity_delta.type === 'integer');
  check('adjust_affinity schema', FCT.ADJUST_AFFINITY.function.name === 'adjust_affinity' &&
    FCT.ADJUST_AFFINITY.function.parameters.required.join(',') === 'delta,reason');
  check('ALL 含三个工具', FCT.ALL.length === 3);

  console.log('== requestFull：tool_calls 解析 ==');
  let mockResp = { ok: true, json: async () => ({ choices: [{ message: {
    role: 'assistant',
    content: '我走这步',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'play_move', arguments: '{"move":"h9e9","thought":"就这？"}' } }],
  } }] }) };
  global.fetch = async () => mockResp;
  let r = await LLM.requestFull([{ role: 'user', content: '走棋' }], { tools: [FCT.PLAY_MOVE] });
  check('解析 content', r.content === '我走这步', r.content);
  check('解析 toolCalls 数量', r.toolCalls.length === 1, r.toolCalls.length);
  check('解析工具名与参数', r.toolCalls[0].name === 'play_move' && r.toolCalls[0].args.move === 'h9e9' && r.toolCalls[0].args.thought === '就这？', JSON.stringify(r.toolCalls[0]));

  console.log('== requestFull：args 容错（markdown 包裹/损坏 JSON） ==');
  mockResp = { ok: true, json: async () => ({ choices: [{ message: {
    role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'answer_undo', arguments: '\`\`\`json\\n{"allow":true,"reply":"行"}\
\`\`\`' } }],
  } }] }) };
  r = await LLM.requestFull([{ role: 'user', content: 'x' }], { tools: [FCT.ANSWER_UNDO] });
  check('markdown 包裹的 arguments 可解析', r.toolCalls[0].args.allow === true && r.toolCalls[0].args.reply === '行', JSON.stringify(r.toolCalls[0].args));
  mockResp = { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'adjust_affinity', arguments: 'not json at all' } }] } }] }) };
  r = await LLM.requestFull([{ role: 'user', content: 'x' }], { tools: [FCT.ADJUST_AFFINITY] });
  check('损坏 arguments 回退空对象', r.toolCalls[0].args && typeof r.toolCalls[0].args === 'object' && Object.keys(r.toolCalls[0].args).length === 0, JSON.stringify(r.toolCalls[0].args));

  console.log('== requestFull：无工具调用/空响应 ==');
  mockResp = { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '正常回复' } }] }) };
  r = await LLM.requestFull([{ role: 'user', content: 'x' }], { tools: [FCT.PLAY_MOVE] });
  check('无 tool_calls 返回空数组', r.toolCalls.length === 0 && r.content === '正常回复');

  console.log('== 请求体：tools / tool_choice / 非流式 ==');
  let sentBody = null;
  global.fetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return mockResp; };
  await LLM.requestFull([{ role: 'user', content: 'x' }], { tools: [FCT.PLAY_MOVE], toolChoice: 'auto' });
  check('请求体含 tools', sentBody.tools && sentBody.tools.length === 1 && sentBody.tools[0].function.name === 'play_move');
  check('请求体 tool_choice', sentBody.tool_choice === 'auto');
  check('requestFull 强制非流式', sentBody.stream === false);

  console.log('== request 兼容（返回 content 文本） ==');
  mockResp = { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '你好' } }] }) };
  const txt = await LLM.request([{ role: 'user', content: 'x' }], { stream: false });
  check('request 返回文本', txt === '你好', txt);

  console.log('== 降级状态 ==');
  FCT.resetFallback();
  check('初始未降级', FCT.fallback.active === false && FCT.fallback.notified === false);
  FCT.markFallback();
  check('markFallback 生效', FCT.fallback.active === true);
  check('ensureNotified 首次 true', FCT.ensureNotified() === true);
  check('ensureNotified 再次 false', FCT.ensureNotified() === false);
  check('isFcUnsupportedError：400', FCT.isFcUnsupportedError(new Error('API 返回错误 400：tools is not supported')) === true);
  check('isFcUnsupportedError：tools 字样', FCT.isFcUnsupportedError(new Error('function calling not supported')) === true);
  check('isFcUnsupportedError：网络错误不算', FCT.isFcUnsupportedError(new Error('网络请求失败：fetch failed')) === false);
  check('isFcUnsupportedError：超时不算', FCT.isFcUnsupportedError(new Error('请求超时（30 秒）')) === false);
  FCT.resetFallback();
  check('resetFallback 恢复', FCT.fallback.active === false && FCT.fallback.notified === false);

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FC 测试崩溃：', e); process.exit(1); });
