/* 运行日志模块单元测试（Node）：node tests/test_logger.js
 * 覆盖：环形缓冲裁剪(1000)、localStorage 持久化最近 300（含跨模块重载读取）、
 *       脱敏（apiKey 类字段丢弃、sk-… 打码、超长截断）、all 筛选、clear、export
 */
'use strict';

/* ---------- localStorage 桩（内存实现，供持久化验证） ---------- */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

require('../js/logger.js');
const Logger = globalThis.Logger;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

(async () => {
  console.log('== 基础记录与读取 ==');
  Logger.clear();
  check('挂载在 globalThis', typeof Logger.log === 'function' && typeof Logger.export === 'function');
  const e1 = Logger.info('llm', 'chat_ok', { ms: 42, profile: 'human', model: 'gpt-4o-mini' });
  Logger.warn('llm', 'chat_error', { err: 'timeout' });
  Logger.error('error', 'window_error', { msg: 'boom' });
  check('记录返回带 ts/cat/level/ev', e1.ts > 0 && e1.cat === 'llm' && e1.level === 'info' && e1.ev === 'chat_ok');
  let all = Logger.all();
  check('读取 3 条（新→旧）', all.length === 3 && all[0].ev === 'window_error' && all[2].ev === 'chat_ok', all.map(x => x.ev).join(','));

  console.log('== all 筛选 ==');
  all = Logger.all({ cat: 'llm' });
  check('按类别筛选 llm', all.length === 2 && all.every(e => e.cat === 'llm'), all.map(x => x.cat + '/' + x.ev).join(','));
  all = Logger.all({ level: 'error' });
  check('按级别筛选 error', all.length === 1 && all[0].ev === 'window_error');
  all = Logger.all({ cat: 'llm', level: 'warn' });
  check('类别+级别组合', all.length === 1 && all[0].ev === 'chat_error');
  all = Logger.all({ limit: 2 });
  check('limit=2', all.length === 2);

  console.log('== 脱敏 ==');
  Logger.info('llm', 'sensitive', { apiKey: 'sk-abcdefgh12345678', Authorization: 'Bearer sk-secret-token-xx', model: 'm', note: 'key=sk-abc1234567890 end', long: 'x'.repeat(500) });
  const s = Logger.all({ cat: 'llm', level: 'info' }).find(e => e.ev === 'sensitive');
  check('apiKey/Authorization 字段整体丢弃', s.apiKey === '[REDACTED]' && s.Authorization === '[REDACTED]', JSON.stringify(s));
  check('字符串值内 sk-… 打码', !/sk-[A-Za-z0-9]{8}/.test(s.note) && s.note.includes('[REDACTED]'), s.note);
  check('超长字段截断 300+…', s.long.length <= 303, String(s.long.length));

  console.log('== 环形缓冲裁剪（内存 1000） ==');
  for (let i = 0; i < 1050; i++) Logger.info('app', 'noise', { i });
  all = Logger.all();
  check('内存裁剪到 1000', all.length === 1000, all.length);
  const evs = all.map(e => e.ev);
  check('保留的是最近 1000 条', evs.filter(e => e === 'noise').length === 1000 && evs.includes('chat_ok') === false);

  console.log('== localStorage 持久化（最近 300，跨加载读取） ==');
  // 等待防抖写盘（logger 内部 400ms 定时器）
  await new Promise(r => setTimeout(r, 600));
  const persisted = JSON.parse(store['aixq_logs']);
  check('持久化为最近 300 条', Array.isArray(persisted) && persisted.length === 300, persisted && persisted.length);
  check('持久层不含最老记录', persisted.every(e => e.ev !== 'chat_ok'), persisted && persisted.length);
  // 模拟刷新：重新 require（清 module cache 后重载，读取持久层）
  delete require.cache[require.resolve('../js/logger.js')];
  const Logger2 = (() => { require('../js/logger.js'); return globalThis.Logger; })();
  all = Logger2.all();
  check('重载后读到持久记录（300 条）', all.length === 300, all.length);
  Logger2.info('app', 'after_reload', {});
  all = Logger2.all();
  check('重载后新记录追加且仍在 300+1', all.length === 301 && all[0].ev === 'after_reload', all.length);

  console.log('== clear 与 export ==');
  const json = Logger2.export();
  check('export 为 JSON 数组字符串', typeof json === 'string' && JSON.parse(json).length === 301);
  Logger2.clear();
  check('clear 清空内存', Logger2.all().length === 0);
  await new Promise(r => setTimeout(r, 450));
  check('clear 后持久键已删除', !('aixq_logs' in store), Object.keys(store).join(','));

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
})();
