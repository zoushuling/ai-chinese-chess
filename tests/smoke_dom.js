/* 冒烟测试：用极简 DOM 桩在 Node 中加载全部脚本，
 * 验证初始化、棋盘点击走子、AI 应招等主流程不抛错。
 * 运行：node tests/smoke_dom.js
 */
'use strict';

/* ---------- DOM 桩 ---------- */
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    _classes: new Set(),
    classList: {
      add: (...cs) => cs.forEach(c => el._classes.add(c)),
      remove: (...cs) => cs.forEach(c => el._classes.delete(c)),
      toggle: (c, force) => {
        const has = el._classes.has(c);
        const want = force === undefined ? !has : force;
        if (want) el._classes.add(c); else el._classes.delete(c);
        return want;
      },
      contains: c => el._classes.has(c),
    },
    value: '',
    checked: false,
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientWidth: 800,
    clientHeight: 600,
    listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    dispatch(ev, e) { (this.listeners[ev] || []).forEach(fn => fn(e || { preventDefault() {} })); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    querySelectorAll() { return []; },
    select() {},
    focus() {},
    setAttribute() {},
    removeAttribute() {},
    getContext() { return ctxProxy; },
  };
  return el;
}
const ctxProxy = new Proxy({}, {
  get(t, k) {
    if (k === 'canvas') return {};
    if (typeof k === 'symbol') return undefined;
    return function () { return undefined; };
  },
  set() { return true; },
});

const elements = new Map();
function getEl(id) {
  if (!elements.has(id)) elements.set(id, makeEl('div'));
  return elements.get(id);
}

const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

global.document = {
  readyState: 'complete',
  getElementById: getEl,
  createElement: t => makeEl(t),
  querySelectorAll: () => [],
  addEventListener() {},
};
Object.defineProperty(global, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});
global.window = globalThis; // 让脚本挂到 globalThis 上
global.devicePixelRatio = 1;
global.addEventListener = () => {};
global.removeEventListener = () => {};

/* ---------- 加载全部脚本 ---------- */
require('../js/engine.js');
require('../js/ai.js');
require('../js/personas.js');
require('../js/llm.js');
require('../js/game.js');
require('../js/chat.js');
require('../js/main.js');

const Eng = globalThis.ChessEngine;
const Game = globalThis.Game;

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  ✔ ' : '  ✘ ') + n + (x !== undefined ? ' → ' + x : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('== 初始化 ==');
  ok('全局对象已挂载', !!Eng && !!Game && !!globalThis.Chat && !!globalThis.ChessAI && !!globalThis.AppSettings);
  ok('对局已开始（红方）', Game.state && Game.state.turn === 'r');
  ok('人机模式：悔棋/认输/提示按钮可见', !getEl('btnUndo').classList.contains('hidden'));
  const status = getEl('statusText').textContent;
  ok('状态栏显示红方走子', status.includes('红方走子'), status);

  console.log('== 模拟玩家走子：选中红炮 (7,7) 再点 (7,4) ==');
  const layer = getEl('piecesLayer');
  // 点击坐标：cell≈58, ox=168, oy=39 → (7,7) → x=574,y=445
  layer.dispatch('click', { clientX: 574, clientY: 445 });
  ok('选中后有目标提示', layer.children.some(c => c.className && String(c.className).includes('target')));
  layer.dispatch('click', { clientX: 400, clientY: 445 }); // (7,4)
  // 同步检查（AI 在微任务里才走子）
  ok('玩家走子成功（炮二平五）', Game.state.history.length === 1 && Game.state.history[0].notation === '炮二平五', Game.state.history[0] && Game.state.history[0].notation);
  ok('轮到黑方（AI 回合）', Game.state.turn === 'b');

  console.log('== AI 应招（无 API Key 时降级引擎） ==');
  await sleep(600); // 等待 aiTurn 完成（引擎搜索+降级）
  ok('AI 已走子', Game.state.history.length === 2, Game.state.history.length);
  ok('轮到红方（玩家）', Game.state.turn === 'r');
  ok('聊天出现 AI 走子记录', getEl('chatMessages').children.length > 1, getEl('chatMessages').children.length);
  const ctx = globalThis.Chat.getContext();
  ok('聊天上下文明确 AI 执黑与上一手',
    !!ctx && ctx.personaColor === 'b' && !!ctx.lastMove && ctx.lastMove.color === 'b',
    JSON.stringify(ctx && { personaColor: ctx.personaColor, lastMove: ctx.lastMove }));

  console.log('== 悔棋 ==');
  // 轮到玩家时悔棋 = 撤回 AI 刚走的一步，回到玩家回合
  getEl('btnUndo').dispatch('click');
  await sleep(30);
  ok('悔棋撤回 AI 一步', Game.state.history.length === 1 && Game.state.turn === 'r', Game.state.history.length + '/' + Game.state.turn);

  console.log('== 人设管理 ==');
  const Personas = globalThis.Personas;
  const p0 = Personas.add({ name: '测试对手', emoji: '🧪', desc: '测试', style: 'balanced', taunt: 5, talkative: 5, extra: '' });
  ok('新增自定义人设', Personas.getAll().some(p => p.id === p0.id));
  ok('人设可更新', Personas.update(Object.assign({}, p0, { name: '测试对手2' })) && Personas.get(p0.id).name === '测试对手2');
  ok('人设可删除', Personas.remove(p0.id) && !Personas.getAll().some(p => p.id === p0.id));

  console.log('== 观战模式 ==');
  const tabs = getEl('modeTabs'); // 桩里 querySelectorAll 返回空，直接调用内部逻辑
  const setMode = globalThis.__testHook || null;
  // 通过点击模拟切换：桩无法挂 tab，改为验证设置持久化路径
  const AppSettings = globalThis.AppSettings;
  AppSettings.set({ difficulty: 2, playerColor: 'b' });
  ok('设置可保存', AppSettings.get().difficulty === 2 && AppSettings.get().playerColor === 'b');
  getEl('btnRestart').dispatch('click');
  await sleep(600); // 等待执黑新局中红方 AI 先手走子
  ok('玩家执黑后 AI（红）先手走子',
    Game.state.history.length === 1 && Game.state.history[0].move.color === 'r' && Game.state.turn === 'b',
    Game.state.history.length + '/' + Game.state.turn);

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('冒烟测试崩溃：', e); process.exit(1); });
