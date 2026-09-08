/* 深度思考（推理模式）参数构造单元测试（Node）：node tests/test_llm_reasoning.js
 * 覆盖：inferReasoning 纯函数（off 零参数/各家嗅探/强度映射/超时下限）、
 *       baseBody 实际请求体（mock fetch 抓包）、getConfig 读取 reasoning 字段
 */
'use strict';

/* ---------- 桩 ---------- */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
const setLlm = (patch) => {
  const base = {
    baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-4o-mini', useFc: true,
  };
  global.AppSettings = {
    get: () => ({ llm: { human: Object.assign({}, base, patch), red: Object.assign({}, base), black: Object.assign({}, base) } }),
  };
};
setLlm({});

require('../js/llm.js');
const LLM = globalThis.LLMClient;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

(async () => {
  console.log('== inferReasoning：off = 零参数（行为与旧版一致） ==');
  let r = LLM.inferReasoning({ model: 'anything', reasoning: 'off' });
  check('off 返回 params:null', r.params === null, JSON.stringify(r.params));
  check('off 不省略 temperature', r.omitTemp === false);
  check('off 用 max_tokens', r.tokenKey === 'max_tokens');

  console.log('== inferReasoning：各家嗅探 ==');
  r = LLM.inferReasoning({ model: 'deepseek-reasoner', reasoning: 'medium' });
  check('reasoner 无附加参数', r.params === null);
  check('reasoner 保留 temperature', r.omitTemp === false);
  check('reasoner 放大 token 下限', r.tokenFloor === 2048);

  r = LLM.inferReasoning({ model: 'qwen3-235b-a22b-instruct', reasoning: 'high' });
  check('qwen3 enable_thinking', r.params && r.params.enable_thinking === true, JSON.stringify(r.params));
  check('qwen3 保留 temperature', r.omitTemp === false);

  r = LLM.inferReasoning({ model: 'glm-4.6', reasoning: 'low' });
  check('glm-4.6 thinking.type=enabled', r.params && r.params.thinking && r.params.thinking.type === 'enabled', JSON.stringify(r.params));

  r = LLM.inferReasoning({ model: 'o1-mini', reasoning: 'high' });
  check('o1 命中 reasoning_effort', r.params && r.params.reasoning_effort === 'high', JSON.stringify(r.params));
  check('o1 省略 temperature', r.omitTemp === true);
  check('o1 用 max_completion_tokens', r.tokenKey === 'max_completion_tokens');
  check('o1 放大 token 下限', r.tokenFloor === 4096);

  r = LLM.inferReasoning({ model: 'o3-mini', reasoning: 'low' });
  check('o3 命中', r.params && r.params.reasoning_effort === 'low');

  r = LLM.inferReasoning({ model: 'gpt-5', reasoning: 'medium' });
  check('gpt-5 命中', r.params && r.params.reasoning_effort === 'medium');

  r = LLM.inferReasoning({ model: 'gpt-4o-mini', reasoning: 'high' });
  check('未知模型回落到 effort', r.params && r.params.reasoning_effort === 'high', JSON.stringify(r.params));
  check('未知模型省略 temperature（OpenAI 兼容）', r.omitTemp === true);

  console.log('== baseBody 实际请求体（off 与旧版逐字节一致） ==');
  let sentBody = null;
  const mockResp = { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }) };
  global.fetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return mockResp; };

  setLlm({ reasoning: 'off', model: 'gpt-4o-mini' });
  await LLM.request([{ role: 'user', content: 'x' }], {});
  check('off：含 temperature', typeof sentBody.temperature === 'number', JSON.stringify(sentBody.temperature));
  check('off：无推理参数', !('reasoning_effort' in sentBody) && !('enable_thinking' in sentBody), JSON.stringify(sentBody));
  check('off：max_tokens=默认1024', sentBody.max_tokens === 1024, String(sentBody.max_tokens));

  setLlm({ reasoning: 'medium', model: 'o1-mini' });
  await LLM.request([{ role: 'user', content: 'x' }], { maxTokens: 800 });
  check('o1：无 temperature', !('temperature' in sentBody), JSON.stringify(sentBody));
  check('o1：reasoning_effort=medium', sentBody.reasoning_effort === 'medium');
  check('o1：用 max_completion_tokens 且含 floor', sentBody.max_completion_tokens === 4096 && !('max_tokens' in sentBody), JSON.stringify(sentBody.max_completion_tokens));

  setLlm({ reasoning: 'low', model: 'deepseek-reasoner' });
  await LLM.request([{ role: 'user', content: 'x' }], { maxTokens: 100 });
  check('reasoner：temperature 仍在', typeof sentBody.temperature === 'number');
  check('reasoner：max_tokens 放大到 floor', sentBody.max_tokens === 2048, String(sentBody.max_tokens));

  setLlm({ reasoning: 'high', model: 'qwen3-235b' });
  await LLM.request([{ role: 'user', content: 'x' }], {});
  check('qwen3：enable_thinking=true 且 temperature 在', sentBody.enable_thinking === true && typeof sentBody.temperature === 'number', JSON.stringify(sentBody));

  console.log('== requestFull 非流式 content 正常（reasoning_content 不上抛，展示已移除） ==');
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '走', reasoning_content: '嗯，这步要想想……' } }] }) });
  const rf = await LLM.requestFull([{ role: 'user', content: 'x' }], {});
  check('content 正常', rf.content === '走');
  check('不返回 thinking 字段', !('thinking' in rf), JSON.stringify(Object.keys(rf)));

  console.log('== getConfig 读取 reasoning 字段 ==');
  setLlm({ reasoning: 'high' });
  check('读 reasoning=high', LLM.getConfig('human').reasoning === 'high');
  setLlm({});
  check('缺省回落 off', LLM.getConfig('human').reasoning === 'off');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
})();
