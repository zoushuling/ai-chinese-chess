/* 模式一「本地 CoT 引导（提示词工程）」单元测试（Node）：node tests/test_cot_guide.js
 * 覆盖：buildCoTGuide 纯函数（off 零文本 / 档位步数与字数 / move 走 thought 字段 / 非法档位回落）、
 *       getConfig 读取 cotGuide、
 *       两种深度思考模式的语义独立性（CoT 开关不影响推理参数、超时放大策略不同）
 *
 * 设计前提：CoT 引导 = 本地给模型一段「思考脚手架」提示词，思考仍由模型完成，
 *          本地只控制"按几步想、每步多长、要不要写进正文"。
 *          与模式二（推理模型 reasoning 参数下发）互不干涉，各自独立开关。
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
/** 数一下脚手架里实际列出几步（行首 "N. " 的行数） */
const stepCount = t => (t.match(/^\d+\. /gm) || []).length;

(async () => {
  console.log('== buildCoTGuide：off 必须返回 null（关闭时 prompt 逐字节不变） ==');
  ['move', 'analyze', 'taunt', 'good', 'review', 'undo', 'comment', 'chat'].forEach(k => {
    check(`off/${k} 返回 null`, LLM.buildCoTGuide('off', k) === null);
  });
  check('未传档位返回 null', LLM.buildCoTGuide(undefined, 'move') === null);
  check('非法档位返回 null', LLM.buildCoTGuide('ultra', 'move') === null);
  check('非法 kind 回落 chat 模板而非 null', typeof LLM.buildCoTGuide('standard', '不存在的kind') === 'string');

  console.log('== buildCoTGuide：各档位步数 ==');
  check('brief = 2 步', stepCount(LLM.buildCoTGuide('brief', 'move')) === 2, stepCount(LLM.buildCoTGuide('brief', 'move')));
  check('standard = 3 步', stepCount(LLM.buildCoTGuide('standard', 'move')) === 3, stepCount(LLM.buildCoTGuide('standard', 'move')));
  check('deep = 4 步', stepCount(LLM.buildCoTGuide('deep', 'move')) === 4, stepCount(LLM.buildCoTGuide('deep', 'move')));

  console.log('== buildCoTGuide：每步字数上限写进指令 ==');
  check('brief 含 12 字上限', /不超过 12 字/.test(LLM.buildCoTGuide('brief', 'move')));
  check('standard 含 20 字上限', /不超过 20 字/.test(LLM.buildCoTGuide('standard', 'analyze')));
  check('deep 含 30 字上限', /不超过 30 字/.test(LLM.buildCoTGuide('deep', 'review')));

  console.log('== buildCoTGuide：步数不超出模板长度（good 模板只有 3 步） ==');
  check('good/deep 最多 3 步', stepCount(LLM.buildCoTGuide('deep', 'good')) === 3, stepCount(LLM.buildCoTGuide('deep', 'good')));
  check('undo/deep 最多 3 步', stepCount(LLM.buildCoTGuide('deep', 'undo')) === 3, stepCount(LLM.buildCoTGuide('deep', 'undo')));

  console.log('== buildCoTGuide：move 走 thought 字段，其余要求不写进正文 ==');
  const mv = LLM.buildCoTGuide('standard', 'move');
  check('move 提到 thought 字段', /thought/.test(mv), mv.slice(0, 60));
  check('move 要求不写进正文', /不要写进正文/.test(mv));
  const ch = LLM.buildCoTGuide('standard', 'chat');
  check('chat 不提 thought 字段', !/thought/.test(ch));
  check('chat 要求不写进回答正文', /不要写进回答正文/.test(ch));

  console.log('== buildCoTGuide：输出形态 ==');
  check('返回字符串', typeof LLM.buildCoTGuide('brief', 'taunt') === 'string');
  check('首行是【思考方式】', /^【思考方式】/.test(LLM.buildCoTGuide('brief', 'taunt')));
  check('含换行分步', /\n1\. /.test(LLM.buildCoTGuide('brief', 'taunt')));

  console.log('== getConfig 读取 cotGuide ==');
  setLlm({ cotGuide: 'deep' });
  check('读 cotGuide=deep', LLM.getConfig('human').cotGuide === 'deep');
  setLlm({ cotGuide: 'brief' });
  check('读 cotGuide=brief', LLM.getConfig('human').cotGuide === 'brief');
  setLlm({});
  check('缺省回落 off', LLM.getConfig('human').cotGuide === 'off');
  setLlm({ cotGuide: '瞎写的' });
  check('脏值不校验（由 normalizeLlm 兜底）', typeof LLM.getConfig('human').cotGuide === 'string');

  console.log('== 两种模式语义独立：开 CoT 不应产生任何推理参数 ==');
  setLlm({ cotGuide: 'deep', reasoning: 'off' });
  let r = LLM.inferReasoning({ model: 'gpt-4o-mini', reasoning: LLM.getConfig('human').reasoning });
  check('CoT 开启时推理参数仍为 null', r.params === null, JSON.stringify(r.params));
  check('CoT 开启时仍下发 temperature', r.omitTemp === false);
  check('CoT 开启时 tokenKey 仍为 max_tokens', r.tokenKey === 'max_tokens');

  console.log('== 两种模式语义独立：开推理模型不应改变 CoT 脚手架 ==');
  setLlm({ cotGuide: 'off', reasoning: 'high' });
  check('仅开推理时脚手架仍为 null', LLM.buildCoTGuide(LLM.getConfig('human').cotGuide, 'move') === null);
  setLlm({ cotGuide: 'standard', reasoning: 'high' });
  check('两者同开时脚手架照常产出', typeof LLM.buildCoTGuide(LLM.getConfig('human').cotGuide, 'move') === 'string');

  console.log('== effectiveTimeout：两种模式的超时放大策略不同 ==');
  setLlm({ cotGuide: 'off', reasoning: 'off' });
  global.AppSettings.get = () => ({ llm: { human: { baseUrl: 'u', apiKey: 'k', model: 'gpt-4o-mini', cotGuide: 'off', reasoning: 'off' } }, llmTimeout: 60 });
  check('都关 = 60 秒', LLM.effectiveTimeout('human') === 60000, LLM.effectiveTimeout('human'));

  global.AppSettings.get = () => ({ llm: { human: { baseUrl: 'u', apiKey: 'k', model: 'gpt-4o-mini', cotGuide: 'deep', reasoning: 'off' } }, llmTimeout: 60 });
  check('仅 CoT = 60+10 秒（思考本地可控，无需 90 秒下限）', LLM.effectiveTimeout('human') === 70000, LLM.effectiveTimeout('human'));

  global.AppSettings.get = () => ({ llm: { human: { baseUrl: 'u', apiKey: 'k', model: 'gpt-4o-mini', cotGuide: 'off', reasoning: 'high' } }, llmTimeout: 60 });
  check('仅推理模型 = 抬到 90 秒', LLM.effectiveTimeout('human') === 90000, LLM.effectiveTimeout('human'));

  global.AppSettings.get = () => ({ llm: { human: { baseUrl: 'u', apiKey: 'k', model: 'gpt-4o-mini', cotGuide: 'deep', reasoning: 'high' } }, llmTimeout: 120 });
  check('两者同开按更严格的推理模型：120 秒', LLM.effectiveTimeout('human') === 120000, LLM.effectiveTimeout('human'));

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
})();
