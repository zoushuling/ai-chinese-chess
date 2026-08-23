/* 好感度系统单元测试（Node）：node tests/test_affinity.js
 * 覆盖：数值/clamp、档位划分、提示消耗公式、持久化、
 *       防污染过滤、本地自动调分、隐藏标记剥离、onChange 回调
 */
'use strict';

/* ---------- localStorage 桩 ---------- */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

require('../js/affinity.js');
const A = globalThis.Affinity;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

console.log('== 数值与 clamp ==');
check('默认值 50', A.get('p1') === 50);
check('clamp 下限 0', A.set('p1', -10) === 0);
check('clamp 上限 100', A.set('p1', 200) === 100);
check('set 返回新值', A.set('p1', 20) === 20);
const adj5 = A.adjust('p1', 5);
check('adjust +5（20 → 25）', adj5.after === 25, adj5.after);
check('adjust 越界 clamp 到 0', A.adjust('p1', -100).after === 0);
check('adjust 0 返回 null', A.adjust('p1', 0) === null);
check('adjust 非法值返回 null', A.adjust('p1', 'abc') === null);
check('adjust 返回前后值', (() => { const r = A.adjust('p1', 30); return r.before === 0 && r.after === 30 && r.delta === 30; })());

console.log('== 档位划分 ==');
check('39 → low', A.tier(39) === 'low');
check('40 → mid', A.tier(40) === 'mid');
check('69 → mid', A.tier(69) === 'mid');
check('70 → high', A.tier(70) === 'high');
check('0 → low', A.tier(0) === 'low');
check('100 → high', A.tier(100) === 'high');
check('档位中文标签', A.tierLabel(39) === '冷淡' && A.tierLabel(50) === '一般' && A.tierLabel(90) === '友好');

console.log('== 提示消耗公式 max(1, 5 - floor(v/25)) ==');
check('100 → 1', A.hintCost(100) === 1);
check('75 → 2', A.hintCost(75) === 2);
check('50 → 3', A.hintCost(50) === 3);
check('25 → 4', A.hintCost(25) === 4);
check('0 → 5', A.hintCost(0) === 5);
check('下限 1（200 也按 1）', A.hintCost(200) === 1);

console.log('== 持久化 ==');
A.reset('p2');
check('reset 后为 50', A.get('p2') === 50);
A.adjust('p2', 10);
check('写入 localStorage（60）', JSON.parse(store['aixq_affinity']).p2 === 60);
A.remove('p2');
check('remove 清理记录', !('p2' in JSON.parse(store['aixq_affinity'])) && A.get('p2') === 50);
A.resetAll();
check('resetAll 清空全部', Object.keys(JSON.parse(store['aixq_affinity'])).length === 0);

console.log('== 防污染（危险键过滤） ==');
// 直接写入含危险键的 JSON 字符串（__proto__/constructor 作为普通键存在）
store['aixq_affinity'] = '{"__proto__":{"x":1},"constructor":{"y":2},"p3":70}';
check('正常键 p3 被读取', A.get('p3') === 70, A.get('p3'));
check('危险键读取安全（回默认 50）', A.get('__proto__') === 50 && A.get('constructor') === 50);
check('对象原型未被污染', ({ }).x === undefined && ({ }).y === undefined && Object.prototype.x === undefined);
check('调分不污染原型', A.adjust('__proto__', 10) === null || A.get('__proto__') === 50);

console.log('== 本地自动调分（辱骂/礼貌） ==');
check('辱骂 -8', A.detectLocalDelta('你个垃圾！') === -8);
check('礼貌 +2', A.detectLocalDelta('谢谢大佬指点') === +2);
check('辱骂优先于礼貌', A.detectLocalDelta('谢谢你，不过你就是个废物') === -8);
check('中性语句 0', A.detectLocalDelta('这步棋怎么走') === 0);
check('英文辱骂命中', A.detectLocalDelta('you are stupid') === -8);

console.log('== 隐藏调分标记剥离 [♥±n] ==');
let s = A.stripAffinityMarkers('这步不错[♥+2]');
check('剥离末尾 [♥+2]', s.text === '这步不错' && s.delta === 2, JSON.stringify(s));
s = A.stripAffinityMarkers('哼[♥-3]');
check('剥离末尾 [♥-3]', s.text === '哼' && s.delta === -3);
s = A.stripAffinityMarkers('文本[♥+5]尾部');
check('任意位置标记也剥离', s.text === '文本尾部' && s.delta === 5);
s = A.stripAffinityMarkers('未闭合[♥');
check('尾部未闭合暂存 pending', s.text === '未闭合' && s.delta === 0 && s.pending === '[♥', JSON.stringify(s));
s = A.stripAffinityMarkers('无标记');
check('无标记原样返回', s.text === '无标记' && s.delta === 0 && s.pending === '');
s = A.stripAffinityMarkers('[♥+1][♥+2]');
check('多个标记累加', s.text === '' && s.delta === 3);

console.log('== onChange 回调 ==');
const events = [];
A.onChange = info => events.push(info);
A.set('p4', 80);
A.adjust('p4', -5);
check('set/adjust 均触发回调', events.length === 2 && events[0].after === 80 && events[1].delta === -5, JSON.stringify(events));
A.adjust('p4', 0);
check('delta 0 不触发回调', events.length === 2);
A.onChange = null;

console.log('== 悔棋惩罚窗口（4 步内只减不加） ==');
A.reset('p5');
A.startUndoPenalty('p5');
check('窗口激活', A.isUndoPenaltyActive('p5') === true);
check('窗口内 +3 被抑制', A.adjust('p5', 3) === null && A.get('p5') === 50, A.get('p5'));
check('窗口内 -1 照常', A.adjust('p5', -1).after === 49, A.get('p5'));
A.tickPenalties();
A.tickPenalties();
check('步进 2 步后仍激活', A.isUndoPenaltyActive('p5') === true);
A.tickPenalties();
A.tickPenalties();
check('步进 4 步后窗口解除', A.isUndoPenaltyActive('p5') === false);
check('解除后 +3 生效', A.adjust('p5', 3).after === 52, A.get('p5'));
check('set 不受窗口抑制', (A.startUndoPenalty('p5'), A.set('p5', 80) === 80 && A.get('p5') === 80));
check('多玩家窗口独立', (A.startUndoPenalty('p5'), A.startUndoPenalty('p7'), A.isUndoPenaltyActive('p5') === true && A.isUndoPenaltyActive('p7') === true));
A.tickPenalties();
check('tick 对所有窗口递减', A.isUndoPenaltyActive('p5') === true && A.isUndoPenaltyActive('p7') === true);
A.clearPenalties();
check('clearPenalties 全部清空', A.isUndoPenaltyActive('p5') === false && A.isUndoPenaltyActive('p7') === false);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
