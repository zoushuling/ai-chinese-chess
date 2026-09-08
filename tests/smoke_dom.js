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
    parent: null,
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
    appendChild(c) { if (c) c.parent = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      if (!c) return c;
      c.parent = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c);
      return c;
    },
    remove() {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) {
      // 桩简化：精确按引用移除；监听器覆盖到此就够 init 复用绑定
      const arr = this.listeners[ev] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(ev, e) {
      // 默认 ev.target = 当前元素（便于事件回调里 closest）；同时沿 parent 链冒泡触发祖先监听器
      const ee = Object.assign({ target: this, preventDefault() {} }, e || {});
      let cur = this;
      while (cur) {
        (cur.listeners[ev] || []).forEach(fn => fn(ee));
        cur = cur.parent || null;
      }
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    /** 仅支持 `.xxx` 简单 class 选择器；递归查子树 */
    querySelectorAll(selector) {
      const m = /^\.([\w-]+)$/.exec(selector || '');
      if (!m) return [];
      const cls = m[1];
      const out = [];
      const walk = root => {
        if (!root || !root.children) return;
        for (const c of root.children) {
          if (c._classes && c._classes.has(cls)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    /** 仅支持 `.xxx` 简单 class 选择器；向上找自身或第一个匹配的祖先 */
    closest(selector) {
      const m = /^\.([\w-]+)$/.exec(selector || '');
      if (!m) return null;
      const cls = m[1];
      let cur = this;
      while (cur) {
        if (cur._classes && cur._classes.has(cls)) return cur;
        cur = cur.parent || null;
      }
      return null;
    },
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
  createTextNode: t => ({ nodeType: 3, textContent: String(t) }),
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
require('../js/logger.js');
require('../js/book.js');
require('../js/ai.js');
require('../js/personas.js');
require('../js/affinity.js');
require('../js/llm.js');
require('../js/fc.js');
require('../js/game.js');
require('../js/tts.js');
require('../js/chat.js');
require('../js/settings-tabs.js');
require('../js/sound.js');
require('../js/main.js');

const Eng = globalThis.ChessEngine;
const Game = globalThis.Game;
const RED = Eng.RED, BLACK = Eng.BLACK;
const AppSettings = globalThis.AppSettings;

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  ✔ ' : '  ✘ ') + n + (x !== undefined ? ' → ' + x : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('== 初始化 ==');
  const Aff = globalThis.Affinity;
  ok('全局对象已挂载', !!Eng && !!Game && !!globalThis.Chat && !!globalThis.ChessAI && !!globalThis.AppSettings && !!Aff && !!globalThis.FCTools);
  ok('LLMClient 提供 requestFull（FC）', typeof globalThis.LLMClient.requestFull === 'function', typeof globalThis.LLMClient.requestFull);
  ok('对局已开始（红方）', Game.state && Game.state.turn === 'r');
  ok('当前对手好感度初始 50', Aff.get(AppSettings.get().aiPersonaId) === 50, Aff.get(AppSettings.get().aiPersonaId));
  ok('顶栏好感度徽标显示 💗 50', getEl('affinityBadge').textContent === '💗 50', getEl('affinityBadge').textContent);
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
  // 当前桩几何：cell=60, ox=160, oy=30 → (7,7) 原位置中心 = (580,450)
  ok('移动后原位置有红点标记', layer.children.some(c => c.className === 'last-dot' && c.style.left === '580px' && c.style.top === '450px'),
    layer.children.filter(c => c.className === 'last-dot').map(c => c.style.left + ',' + c.style.top).join('|'));

  console.log('== AI 应招（无 API Key 时降级引擎） ==');
  await sleep(600); // 等待 aiTurn 完成（引擎搜索+降级）
  ok('AI 已走子', Game.state.history.length === 2, Game.state.history.length);
  ok('轮到红方（玩家）', Game.state.turn === 'r');
  ok('聊天出现 AI 走子记录', getEl('chatMessages').children.length > 1, getEl('chatMessages').children.length);
  const ctx = globalThis.Chat.getContext();
  ok('聊天上下文明确 AI 执黑与上一手',
    !!ctx && globalThis.Chat.currentPersonaColor() === 'b' && !!ctx.lastMove && ctx.lastMove.color === 'b',
    JSON.stringify(ctx && { personaColor: globalThis.Chat.currentPersonaColor(), lastMove: ctx.lastMove }));

  console.log('== 提示 ==');
  await globalThis.Chat.quickAction('hint');
  const hintLine = getEl('chatMessages').children
    .map(x => String(x.textContent || ''))
    .find(t => t.includes('💡 提示'));
  ok('提示文字不含 undefined', !!hintLine && !hintLine.includes('undefined'), hintLine);
  ok('提示文字包含推荐走法', !!hintLine && /推荐 .+/.test(hintLine), hintLine);
  const affPid = AppSettings.get().aiPersonaId;
  ok('提示成功消耗好感度（50 → 47）', Aff.get(affPid) === 47, Aff.get(affPid));
  // 低好感拒绝提示：不消耗
  Aff.set(affPid, 30);
  await globalThis.Chat.quickAction('hint');
  const refuseLine = getEl('chatMessages').children
    .map(x => String(x.textContent || ''))
    .find(t => t.includes('拒绝'));
  ok('低好感（30）拒绝提示', !!refuseLine && refuseLine.includes('拒绝'), refuseLine);
  ok('拒绝提示不消耗好感度', Aff.get(affPid) === 30, Aff.get(affPid));
  Aff.set(affPid, 50); // 恢复，便于后续断言

  console.log('== 悔棋（离线：直接悔棋） ==');
  // 玩家回合悔棋 = 撤回 AI 应手 + 玩家上一手，回到玩家重走
  getEl('btnUndo').dispatch('click');
  await sleep(30);
  ok('悔棋回退到开局（棋谱清空）',
    Game.state.history.length === 0 && Game.state.turn === 'r' && Eng.toFEN(Game.state.board, Game.state.turn) === Eng.START_FEN,
    Game.state.history.length + '/' + Game.state.turn);
  ok('离线悔棋请求同样扣 1 点好感度（50 → 49）', Aff.get(affPid) === 49, Aff.get(affPid));
  ok('悔棋后进入惩罚窗口（4 步内只减不加）', Aff.isUndoPenaltyActive(affPid) === true, Aff.isUndoPenaltyActive(affPid));
  // 惩罚窗口内：好棋 +3 应被抑制（直接验证 adjust 层，防止悔棋 -1 被立即抵消）
  Aff.set(affPid, 49);
  Aff.adjust(affPid, 3);
  ok('惩罚窗口内 +3 被抑制（49 不变）', Aff.get(affPid) === 49, Aff.get(affPid));
  Aff.clearPenalties(); // 清理窗口，避免影响后续用例（好感度保持 49）

  console.log('== 人设管理 ==');
  const Personas = globalThis.Personas;
  ok('内置预设包含雌小鬼「小魅」', Personas.getAll().some(p => p.id === 'mesugaki' && p.name === '小魅'));
  const p0 = Personas.add({ name: '测试对手', emoji: '🧪', desc: '测试', style: 'balanced', taunt: 5, talkative: 5, extra: '' });
  ok('新增自定义人设', Personas.getAll().some(p => p.id === p0.id));
  ok('人设可更新', Personas.update(Object.assign({}, p0, { name: '测试对手2' })) && Personas.get(p0.id).name === '测试对手2');
  ok('人设可删除', Personas.remove(p0.id) && !Personas.getAll().some(p => p.id === p0.id));

  console.log('== 玩法说明 ==');
  ok('首次启动自动展示说明并写入记忆标记', global.localStorage.getItem('aixq_help_seen') === '1',
    global.localStorage.getItem('aixq_help_seen'));

  console.log('== 观战模式 ==');
  const tabs = getEl('modeTabs'); // 桩里 querySelectorAll 返回空，直接调用内部逻辑
  const setMode = globalThis.__testHook || null;
  // 通过点击模拟切换：桩无法挂 tab，改为验证设置持久化路径
  AppSettings.set({ difficulty: 2, playerColor: 'b' });
  ok('设置可保存', AppSettings.get().difficulty === 2 && AppSettings.get().playerColor === 'b');
  getEl('btnRestart').dispatch('click');
  await sleep(600); // 等待执黑新局中红方 AI 先手走子
  ok('玩家执黑后 AI（红）先手走子',
    Game.state.history.length === 1 && Game.state.history[0].move.color === 'r' && Game.state.turn === 'b',
    Game.state.history.length + '/' + Game.state.turn);

  console.log('== 悔棋审批：按钮点击集成（LLM 同意） ==');
  const Chat = globalThis.Chat;
  const realRequest = global.LLMClient.request;
  AppSettings.set({ apiKey: 'test-key', apiBaseUrl: 'https://example.com/v1', apiModel: 'test-model', playerColor: 'r', maxUndo: 2, useFunctionCalling: false });
  global.LLMClient.request = async msgs => {
    const sys = (msgs[0] && msgs[0].content) || '';
    if (sys.includes('悔棋')) return '{"allow":true,"reply":"行，悔就悔吧。"}';
    return '{}'; // aiPick 输出非法 → 自动回退引擎 top1
  };
  getEl('btnRestart').dispatch('click');
  await sleep(50); // 新局：玩家执红，无需 AI 先手
  layer.dispatch('click', { clientX: 574, clientY: 445 });
  layer.dispatch('click', { clientX: 400, clientY: 445 });
  await sleep(700); // 等待 AI 应招
  ok('LLM 模式预备：玩家红走子后 AI 已应招',
    Game.state.history.length === 2 && Game.state.turn === 'r',
    Game.state.history.length + '/' + Game.state.turn);
  getEl('btnUndo').dispatch('click');
  await sleep(200); // LLM 审批 + 执行悔棋
  ok('按钮悔棋经 LLM 同意后执行（回开局）',
    Game.state.history.length === 0 && Game.state.turn === 'r' && Eng.toFEN(Game.state.board, Game.state.turn) === Eng.START_FEN,
    Game.state.history.length + '/' + Game.state.turn);
  ok('悔棋按钮已恢复可用', getEl('btnUndo').disabled === false, getEl('btnUndo').disabled);
  ok('LLM 在线悔棋请求同样扣 1 点（49 → 48）', Aff.get(affPid) === 48, Aff.get(affPid));

  console.log('== 悔棋审批（直接调用 Chat.requestUndo，FC 关闭走旧 JSON 路径） ==');
  AppSettings.set({ apiKey: 'test-key', apiBaseUrl: 'https://example.com/v1', apiModel: 'test-model', playerColor: 'b', maxUndo: 2, useFunctionCalling: false });
  const lastH = Game.state.history[Game.state.history.length - 1];
  Chat.setPosition({
    board: Game.state.board,
    turn: Game.state.turn,
    fen: Eng.toFEN(Game.state.board, Game.state.turn),
    evalSummary: { label: '均势', diff: 0 },
    topMoves: [],
    lastMove: lastH ? Object.assign({}, lastH.move, { notation: lastH.notation }) : null,
    personaId: AppSettings.get().aiPersonaId,
    personaColor: 'r',
    difficulty: 3,
    mode: 'human',
  });
  const affBeforeDirect = Aff.get(affPid);
  global.LLMClient.request = async () => '{"allow":true,"reply":"行，悔就悔吧。","affinityDelta":-2}';
  let v = await Chat.requestUndo({ count: 1, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  ok('LLM 同意悔棋：返回 allow=true', !!(v && v.allow === true && /悔/.test(v.reply)), JSON.stringify(v));
  ok('悔棋批复渲染为 AI 气泡', getEl('chatMessages').children.some(c => c.children && c.children.length && String(c.children[0].textContent || '').includes('行，悔就悔吧')), getEl('chatMessages').children.length);
  ok('LLM 工具 affinityDelta -2 生效（48 → 46）', Aff.get(affPid) === affBeforeDirect - 2, Aff.get(affPid));

  global.LLMClient.request = async () => '{"allow":false,"reply":"驳回，就你这态度还想悔棋？"}';
  v = await Chat.requestUndo({ count: 2, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  ok('LLM 可驳回悔棋：返回 allow=false', !!(v && v.allow === false), JSON.stringify(v));

  // 本地档位兜底：好感度 46（中档），第 3 次超限 → 驳回
  global.LLMClient.request = async () => { throw new Error('模拟网络错误'); };
  v = await Chat.requestUndo({ count: 3, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  ok('LLM 失败且中档次数超限 → 本地兜底驳回', !!(v && v.allow === false && /驳回/.test(v.reply)), JSON.stringify(v));
  // 高好感档：次数超限也同意
  Aff.set(affPid, 80);
  v = await Chat.requestUndo({ count: 3, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  ok('LLM 失败且好感度高 → 本地兜底同意（超次数也准）', !!(v && v.allow === true && /准/.test(v.reply)), JSON.stringify(v));
  Aff.set(affPid, 46);
  Chat.history.push({ role: 'user', content: '你个垃圾，快点下！' });
  v = await Chat.requestUndo({ count: 4, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  ok('LLM 失败且玩家态度差 → 本地兜底驳回', !!(v && v.allow === false && /驳回/.test(v.reply)), JSON.stringify(v));

  console.log('== FC 主路径：走子（play_move 工具 + 非法走法重试） ==');
  AppSettings.set({ apiKey: 'test-key', apiBaseUrl: 'https://example.com/v1', apiModel: 'test-model', playerColor: 'b', difficulty: 1, useFunctionCalling: true });
  globalThis.FCTools.resetFallback();
  const realRequestFull = global.LLMClient.requestFull;
  let fcPickCalls = 0;
  let lastPickSys = '';
  let lastPickUser = '';
  // 动态取引擎当前首选着法：避免把"引擎偏好某个具体着法"写死进断言，
  // 引擎升级后首选会变，这里要测的是"非法坐标→回传重试→采纳合法走法"的机制本身。
  const topPick = globalThis.ChessAI.search(Game.state.board, Game.state.turn, { depth: 1, topN: 5, timeLimit: 1400 });
  const goodCoord = topPick.candidates[0].coord;
  const goodNotation = topPick.candidates[0].notation;
  global.LLMClient.requestFull = async (msgs, opts) => {
    const sys = (msgs[0] && msgs[0].content) || '';
    if (sys.includes('候选走法')) {
      fcPickCalls++;
      lastPickSys = sys;
      lastPickUser = (msgs[1] && msgs[1].content) || '';
      // 第一轮给非法坐标 → 工具结果回传重试；第二轮给引擎首选（保证落在候选列表内）
      if (fcPickCalls === 1) return { content: '', toolCalls: [{ id: 'fc1', name: 'play_move', args: { move: 'z9z9', thought: '乱选' } }], raw: {} };
      return { content: '', toolCalls: [{ id: 'fc2', name: 'play_move', args: { move: goodCoord, thought: '就这一步！' } }], raw: {} };
    }
    return { content: '', toolCalls: [], raw: {} };
  };
  getEl('btnRestart').dispatch('click'); // 玩家执黑 → AI（红）先手 → FC 走子
  await sleep(900);
  ok('FC 走子：非法走法重试后采纳第二轮给出的合法走法',
    Game.state.history.length === 1 && Game.state.history[0].notation === goodNotation,
    Game.state.history.length + '/' + (Game.state.history[0] && Game.state.history[0].notation) + ' 期望:' + goodNotation);
  ok('FC 走子：play_move 被调用 2 次（含 1 次重试）', fcPickCalls === 2, fcPickCalls);

  // —— 提示词结构回归（V0.4.2 起：缓存命中率优化）
  ok('P1+P4: sys head 含【任务】和【输出格式】（系统指令已前置到稳定段）',
    lastPickSys.includes('【任务】') && lastPickSys.includes('【输出格式】') && lastPickSys.includes('【身份】'),
    '');
  ok('P1: 易变内容（局面 FEN + 候选列表）已搬迁到 user message',
    /FEN/.test(lastPickUser) && /候选走法（编号/.test(lastPickUser),
    lastPickUser.slice(0, 80));
  ok('P2: 好感度统一标签【好感度】出现在 sys head（三档同模板）',
    /【好感度】/.test(lastPickSys), '');
  ok('P3: 候选列表定长（坐标 4 位 + 评分 5 位含符号）',
    /\(\s*[a-i]\d[a-i]\d\s*评分[+-]\s*\d+\s*\)/.test(lastPickUser),
    lastPickUser.match(/\d{2}\.\s.+/));
  ok('P4: Personas.systemHead 已挂载（抽出 main.js 到 personas.js）',
    typeof (global.Personas && global.Personas.systemHead) === 'function' &&
    /SYSTEM_PROMPT_COMMON|候选走法/.test(global.Personas.SYSTEM_PROMPT_COMMON || ''),
    '');

  console.log('== FC 主路径：悔棋（answer_undo + affinity_delta） ==');
  AppSettings.set({ playerColor: 'r', useFunctionCalling: true });
  global.LLMClient.requestFull = async (msgs, opts) => {
    const sys = (msgs[0] && msgs[0].content) || '';
    if (sys.includes('候选走法')) return { content: '', toolCalls: [{ id: 'fc3', name: 'play_move', args: { move: 'b2e2', thought: '应一手' } }], raw: {} }; // AI 执黑炮2平5
    if (sys.includes('悔棋')) return { content: '', toolCalls: [{ id: 'fc4', name: 'answer_undo', args: { allow: true, reply: '行，悔就悔吧。', affinity_delta: -2 } }], raw: {} };
    return { content: '', toolCalls: [], raw: {} };
  };
  getEl('btnRestart').dispatch('click');
  await sleep(50);
  layer.dispatch('click', { clientX: 574, clientY: 445 });
  layer.dispatch('click', { clientX: 400, clientY: 445 });
  await sleep(800); // AI 黑应招（FC b2e2）
  ok('FC 悔棋预备：玩家走子 + AI FC 应招',
    Game.state.history.length === 2 && Game.state.turn === 'r',
    Game.state.history.length + '/' + Game.state.turn);
  const affUndoBefore = Aff.get(affPid);
  getEl('btnUndo').dispatch('click');
  await sleep(250);
  ok('FC 悔棋：answer_undo 同意后执行（回开局）',
    Game.state.history.length === 0 && Game.state.turn === 'r' && Eng.toFEN(Game.state.board, Game.state.turn) === Eng.START_FEN,
    Game.state.history.length + '/' + Game.state.turn);
  ok('FC 悔棋：请求 -1 + affinity_delta -2 生效', Aff.get(affPid) === affUndoBefore - 3, Aff.get(affPid) + '/' + affUndoBefore);

  console.log('== FC 主路径：聊天两阶段（adjust_affinity 预判 + 流式正文） ==');
  Aff.clearPenalties(); // 清空上段悔棋留下的惩罚窗口，否则 +2 会被抑制
  global.LLMClient.requestFull = async (msgs, opts) => {
    const last = [...msgs].reverse().find(m => m.role === 'user');
    if (last && String(last.content || '').includes('谢谢')) {
      return { content: '', toolCalls: [{ id: 'fc5', name: 'adjust_affinity', args: { delta: 2, reason: '玩家很礼貌' } }], raw: {} };
    }
    return { content: '', toolCalls: [], raw: {} };
  };
  global.LLMClient.request = async (msgs, opts) => {
    if (opts && opts.onDelta) { opts.onDelta('不客气～'); }
    return '不客气～';
  };
  const affChatBefore = Aff.get(affPid);
  globalThis.Chat.send('谢谢你指点');
  await sleep(350);
  ok('FC 聊天：预判 adjust_affinity +2 生效', Aff.get(affPid) === affChatBefore + 2, Aff.get(affPid) + '/' + affChatBefore);
  const fcChatBubbles = getEl('chatMessages').children
    .map(x => String(x.children && x.children[0] ? x.children[0].textContent : x.textContent || ''));
  ok('FC 聊天：阶段 2 流式正文渲染', fcChatBubbles.some(t => t.includes('不客气')), JSON.stringify(fcChatBubbles.slice(-3)));

  console.log('== FC 模式辱骂硬底线（被骂必掉分） ==');
  AppSettings.set({ useFunctionCalling: true });
  globalThis.FCTools.resetFallback();
  const affInsultBefore = Aff.get(affPid);
  globalThis.Chat.send('你就是个大傻子，长这么大没摸过棋盘吧，等着小爷我略死你吧');
  await sleep(350);
  ok('FC 模式辱骂硬底线：示例1 -8 生效', Aff.get(affPid) === affInsultBefore - 8, Aff.get(affPid) + '/' + affInsultBefore);
  const affInsultBefore2 = Aff.get(affPid);
  globalThis.Chat.send('蠢蛋，王八蛋，变态，杂鱼');
  await sleep(350);
  ok('FC 模式辱骂硬底线：示例2 -8 生效', Aff.get(affPid) === affInsultBefore2 - 8, Aff.get(affPid) + '/' + affInsultBefore2);

  console.log('== FC 降级：400 → 自动回退 JSON + 提示一次 ==');
  AppSettings.set({ useFunctionCalling: true });
  globalThis.FCTools.resetFallback();
  global.LLMClient.requestFull = async () => { throw new Error('API 返回错误 400：tools is not supported'); };
  global.LLMClient.request = async msgs => {
    const sys = (msgs[0] && msgs[0].content) || '';
    if (sys.includes('悔棋')) return '{"allow":true,"reply":"行，悔就悔吧。"}';
    return '{}';
  };
  let v2 = await Chat.requestUndo({ count: 1, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  ok('FC 400 后降级：JSON 路径兜底同意', !!(v2 && v2.allow === true), JSON.stringify(v2));
  ok('FC 400 标记降级状态', globalThis.FCTools.fallback.active === true, globalThis.FCTools.fallback.active);
  const fbHints = getEl('chatMessages').children.filter(x => String(x.textContent || '').includes('已自动降级')).length;
  ok('降级提示出现一次', fbHints >= 1, fbHints);
  v2 = await Chat.requestUndo({ count: 1, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  const fbHints2 = getEl('chatMessages').children.filter(x => String(x.textContent || '').includes('已自动降级')).length;
  ok('降级提示不重复', fbHints2 === fbHints, fbHints2 + '/' + fbHints);
  global.LLMClient.requestFull = realRequestFull;

  console.log('== 流式隐藏调分标记 [♥±n] ==');
  AppSettings.set({ playerColor: 'r', streaming: true, useFunctionCalling: false });
  Aff.clearPenalties(); // 窗口已走完，此段验证标记加分正常生效
  const affBeforeTaunt = Aff.get(affPid);
  global.LLMClient.request = async (msgs, opts) => {
    if (opts && opts.onDelta) {
      opts.onDelta('哼，就这？');
      opts.onDelta('[♥+2]');
    }
    return '哼，就这？[♥+2]';
  };
  await globalThis.Chat.quickAction('taunt');
  const tauntBubbles = getEl('chatMessages').children
    .map(x => String(x.children && x.children[0] ? x.children[0].textContent : x.textContent || ''));
  ok('流式回复渲染剥离 [♥+2] 标记', tauntBubbles.some(t => t.includes('哼，就这？')) && !tauntBubbles.some(t => t.includes('[♥+2]')),
    JSON.stringify(tauntBubbles.slice(-3)));
  ok('流式标记调分 +2（46 → 48）', Aff.get(affPid) === affBeforeTaunt + 2, Aff.get(affPid));
  const lastHist = globalThis.Chat.history[globalThis.Chat.history.length - 1];
  ok('对话历史不含调分标记', !String(lastHist.content || '').includes('[♥+2]'), JSON.stringify(lastHist && lastHist.content));
  global.LLMClient.request = realRequest;

  console.log('== 深度思考：设置白名单与超时字段 ==');
  AppSettings.set({
    llm: {
      human: { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', apiKey: 'k', useFc: true, reasoning: 'high' },
    },
  });
  ok('normalizeLlm 白名单保留 reasoning=high', AppSettings.get().llm.human.reasoning === 'high', AppSettings.get().llm.human.reasoning);
  AppSettings.set({
    llm: {
      human: { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', apiKey: 'k', useFc: true, reasoning: 'turbo' },
    },
  });
  ok('非法档位（turbo）回落到 off', AppSettings.get().llm.human.reasoning === 'off', AppSettings.get().llm.human.reasoning);
  AppSettings.set({ llmTimeout: 45 });
  ok('llmTimeout 顶级字段保存生效', AppSettings.get().llmTimeout === 45, AppSettings.get().llmTimeout);

  console.log('== 运行日志（V0.5.1） ==');
  ok('Logger 已挂载', typeof globalThis.Logger.log === 'function' && typeof globalThis.Logger.export === 'function');
  AppSettings.set({ showDiagnostics: true });
  const lastSetLog = globalThis.Logger.all({ cat: 'settings', level: 'info', limit: 1 })[0];
  ok('AppSettings.set 记 settings.change', !!lastSetLog && lastSetLog.ev === 'change' && /showDiagnostics/.test(lastSetLog.keys || ''),
    lastSetLog && JSON.stringify(lastSetLog));
  ok('showDiagnostics 保存生效', AppSettings.get().showDiagnostics === true, String(AppSettings.get().showDiagnostics));
  ok('日志面板 id 契约（paneLogs/logList/logFilterCat/btnLogExport/setShowDiagnostics）',
    !!getEl('paneLogs') && !!getEl('logList') && !!getEl('logFilterCat') && !!getEl('logFilterLevel') && !!getEl('btnLogExport') && !!getEl('btnLogClear') && !!getEl('setShowDiagnostics'));

  console.log('== 可吃子标记（炮隔子吃） ==');
  AppSettings.set({ playerColor: 'r' });
  const bc = Eng.emptyBoard();
  bc[9][4] = { type: 'K', color: RED };
  bc[0][4] = { type: 'K', color: BLACK };
  bc[5][4] = { type: 'C', color: RED }; // 红炮
  bc[3][4] = { type: 'P', color: BLACK }; // 炮架
  bc[2][4] = { type: 'R', color: BLACK }; // 可被炮吃掉的目标
  Game.state.board = bc;
  Game.state.turn = RED;
  Game.state.over = null;
  Game.state.history = [];
  Game.state.moveCount = 0;
  getEl('piecesLayer').dispatch('click', { clientX: 400, clientY: 329 }); // 选中 (5,4) 红炮
  const capMarks = getEl('piecesLayer').children.filter(c => c.className === 'target-capture');
  ok('炮隔子吃子目标有深色圆环标记',
    capMarks.some(c => c.style.left === (160 + 4 * 60) + 'px' && c.style.top === (30 + 2 * 60) + 'px'),
    capMarks.map(c => c.style.left + ',' + c.style.top).join('|'));

  console.log('== 长将约束 ==');
  const b = Eng.emptyBoard();
  b[9][4] = { type: 'K', color: RED };
  b[0][4] = { type: 'K', color: BLACK };
  b[5][4] = { type: 'R', color: RED };
  b[3][4] = { type: 'P', color: BLACK }; // 红车吃卒后将军
  Game.state.board = b;
  Game.state.turn = RED;
  Game.state.over = null;
  const longMove = { fr: 5, fc: 4, tr: 3, tc: 4 };
  const fenAfter = Eng.toFEN(Eng.makeMove(b, longMove), BLACK);
  Game.state.history = [
    { preFen: fenAfter, move: null, notation: '车三进二吃', check: true },
    { preFen: fenAfter, move: null, notation: '车三进二吃', check: true },
  ];
  ok('识别长将走法', Game.wouldRepeatCheck(longMove) === true);
  ok('applyMove 拒绝长将走法', Game.applyMove(longMove) === false && Game.state.board[5][4] && Game.state.board[5][4].type === 'R');

  console.log('== TTS 配音（Node 无语音环境，验证不抛错） ==');
  const TTS = globalThis.TTS;
  ok('TTS 模块已挂载', !!TTS && typeof TTS.speakText === 'function');
  ok('默认自动配音开启', TTS.isEnabled() === true);
  const sv = TTS.styleVoice('aggressive');
  ok('人设音色映射：aggressive 低沉快速', sv.pitch < 1 && sv.rate > 1, JSON.stringify(sv));
  ok('人设音色映射：未知棋风回退均衡', TTS.styleVoice('nope').pitch === TTS.styleVoice('balanced').pitch);
  ok('TTS 提供系统音色列表接口', Array.isArray(TTS.getBrowserVoices()));
  ok('TTS 提供国内服务商预设（火山方舟/阿里云百炼等）',
    ['openai', 'ark', 'dashscope', 'custom'].every(id => (TTS.getProviders() || []).some(p => p.id === id)),
    JSON.stringify((TTS.getProviders() || []).map(p => p.id)));
  ok('云端预设音色含 alloy 与豆包音色',
    (TTS.getAllPresetVoices() || []).includes('alloy') &&
    (TTS.getAllPresetVoices() || []).includes('zh_female_shuangkuaisisi_mars_bigtts'));
  const Personas2 = globalThis.Personas;
  ok('内置人设绑定专属音色', Personas2.get('mesugaki').voice === 'xiaoyi' && Personas2.get('cute_girl').voice === 'xiaoxiao');
  let spoke = false;
  try { TTS.speakText('你好。这步棋走得好！', sv); spoke = true; } catch (e) { spoke = false; }
  ok('无语音环境下朗读静默不抛错', spoke === true);
  try { TTS.stop(); ok('stop 可安全调用', true); } catch (e) { ok('stop 可安全调用', false); }

  console.log('== TTS 深度测试（桩模拟浏览器语音 + 云端请求） ==');
  const origFetch = global.fetch;
  const origSynth = global.speechSynthesis;
  const origUtterance = global.SpeechSynthesisUtterance;
  const origCreateObjectURL = global.URL && global.URL.createObjectURL;
  const origAudio = global.Audio;
  try {
    // —— 浏览器引擎：中文过滤 + 音色解析链（人设绑定 > 全局默认 > 自动） ——
    const fakeVoices = [
      { name: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', lang: 'zh-CN' },
      { name: 'Microsoft Yunxi Online (Natural) - Chinese (Mainland)', lang: 'zh-CN' },
      { name: 'Google US English', lang: 'en-US' },
    ];
    const spoken = [];
    global.SpeechSynthesisUtterance = function (text) { this.text = text; };
    global.speechSynthesis = {
      getVoices: () => fakeVoices,
      speak: u => { spoken.push(u); if (u.onend) setTimeout(() => u.onend(), 5); },
      cancel: () => {},
    };
    global.AppSettings.set({ ttsEngine: 'browser', ttsBrowserVoice: 'auto', ttsVoice: 'alloy', ttsBaseUrl: '', ttsApiKey: '', ttsModel: '' });
    const bv = TTS.getBrowserVoices();
    ok('浏览器音色列表只含中文语音', bv.length === 2 && bv.every(v => /^zh/i.test(v.lang)), JSON.stringify(bv));
    TTS.speakText('你好，来杀一盘。', { pitch: 1, rate: 1, name: '' });
    await sleep(150); // speakBrowser 内部有 50ms 缓冲
    ok('朗读自动选用中文语音（晓晓）', spoken.length >= 1 && /xiaoxiao/i.test(spoken[0].voice.name), spoken.length && spoken[0].voice && spoken[0].voice.name);
    ok('音调/语速参数已应用', spoken.length >= 1 && spoken[0].pitch === 1 && spoken[0].rate === 1, spoken.length && JSON.stringify({ p: spoken[0].pitch, r: spoken[0].rate }));
    spoken.length = 0;
    TTS.speakText('你好。', { pitch: 0.8, rate: 1.2, name: 'yunxi' });
    await sleep(150);
    ok('人设绑定音色生效（云希）', spoken.length >= 1 && /yunxi/i.test(spoken[0].voice.name), spoken.length && spoken[0].voice && spoken[0].voice.name);
    spoken.length = 0;
    global.AppSettings.set({ ttsBrowserVoice: 'yunxi' });
    TTS.speakText('你好。', { pitch: 1, rate: 1, name: '不存在的音色' });
    await sleep(150);
    ok('未知人设音色回退全局默认（云希）', spoken.length >= 1 && /yunxi/i.test(spoken[0].voice.name), spoken.length && spoken[0].voice && spoken[0].voice.name);
    spoken.length = 0;
    global.AppSettings.set({ ttsBrowserVoice: 'auto' });
    TTS.speakText('你好。', { pitch: 1, rate: 1, name: '不存在的音色' });
    await sleep(150);
    ok('全局自动时回退自动挑选中文语音', spoken.length >= 1 && /^zh/i.test(spoken[0].voice.lang), spoken.length && spoken[0].voice && spoken[0].voice.lang);

    // —— 云端引擎：请求体音色/模型/端点正确性 ——
    const fetched = [];
    global.fetch = async (url, opts) => {
      fetched.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, blob: async () => new Blob(['x']) };
    };
    global.URL.createObjectURL = () => 'blob:fake';
    global.Audio = class {
      constructor(url) { this.url = url; }
      play() { if (this.onended) setTimeout(() => this.onended(), 5); return Promise.resolve(); }
    };
    global.AppSettings.set({ ttsEngine: 'cloud', ttsBaseUrl: 'https://tts.example.com/v1', ttsApiKey: 'key', ttsModel: 'tts-1', ttsVoice: 'nova' });
    TTS.speakText('你好。', { pitch: 1, rate: 1, name: '' });
    await sleep(150);
    ok('云端端点拼接正确', fetched.length >= 1 && fetched[0].url === 'https://tts.example.com/v1/audio/speech', fetched[0] && fetched[0].url);
    ok('云端请求用全局音色 nova 与模型 tts-1', fetched.length >= 1 && fetched[0].body.voice === 'nova' && fetched[0].body.model === 'tts-1', JSON.stringify(fetched[0] && fetched[0].body));
    fetched.length = 0;
    TTS.speakText('你好。', { pitch: 1, rate: 1, name: 'zh_female_shuangkuaisisi_mars_bigtts' });
    await sleep(150);
    ok('云端请求优先人设绑定音色（豆包）', fetched.length >= 1 && fetched[0].body.voice === 'zh_female_shuangkuaisisi_mars_bigtts', JSON.stringify(fetched[0] && fetched[0].body));

    // —— 云端引擎：小米 MiMo（chat/completions 格式，返回 base64 音频） ——
    ok('MiMo 服务商预设已注册（含 mimo_default 音色）',
      (TTS.getProviders() || []).some(p => p.id === 'mimo' && (p.voices || []).indexOf('mimo_default') >= 0));
    global.fetch = async (url, opts) => {
      fetched.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      const b64 = Buffer.from('mimo-audio-bytes').toString('base64');
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', audio: { data: b64 } } }] }) };
    };
    global.AppSettings.set({ ttsEngine: 'cloud', ttsProvider: 'mimo', ttsBaseUrl: 'https://api.xiaomimimo.com/v1', ttsApiKey: 'key', ttsModel: 'mimo-v2.5-tts', ttsVoice: '冰糖' });
    fetched.length = 0;
    TTS.speakText('你好。', { pitch: 1, rate: 1, name: '' });
    await sleep(150);
    ok('MiMo 走 chat/completions 端点', fetched.length >= 1 && fetched[0].url === 'https://api.xiaomimimo.com/v1/chat/completions', fetched[0] && fetched[0].url);
    ok('MiMo 文本进 assistant 消息、音色入 audio.voice', fetched.length >= 1 &&
      fetched[0].body.messages[0].role === 'assistant' && fetched[0].body.messages[0].content === '你好。' &&
      fetched[0].body.audio.voice === '冰糖' && fetched[0].body.model === 'mimo-v2.5-tts',
      JSON.stringify(fetched[0] && fetched[0].body));
    ok('MiMo 请求带 Bearer 鉴权头', fetched.length >= 1 && /Bearer key/.test(fetched[0].headers.Authorization || ''), fetched[0] && JSON.stringify(fetched[0].headers));
    // 人设可能绑定浏览器音色（yunyang/xiaoxiao），但 MiMo 只认预置音色——必须忽略 state.voiceName，改用设置音色
    fetched.length = 0;
    TTS.speakText('你好。', { pitch: 1, rate: 1, name: 'yunyang' });
    await sleep(150);
    ok('MiMo 忽略人设浏览器音色，仍用设置音色冰糖', fetched.length >= 1 && fetched[0].body.audio.voice === '冰糖', JSON.stringify(fetched[0] && fetched[0].body));
    global.AppSettings.set({ ttsEngine: 'browser', ttsBrowserVoice: 'auto', ttsVoice: 'alloy', ttsBaseUrl: '', ttsApiKey: '', ttsModel: '', ttsProvider: 'openai' });
  } finally {
    global.fetch = origFetch;
    global.speechSynthesis = origSynth;
    global.SpeechSynthesisUtterance = origUtterance;
    if (origCreateObjectURL) global.URL.createObjectURL = origCreateObjectURL; else delete global.URL.createObjectURL;
    global.Audio = origAudio;
  }

  console.log('== 双 LLM 配置与会话隔离（V0.4 架构） ==');
  const FCT2 = globalThis.FCTools;
  // 1) 默认三组结构
  const defLlm = AppSettings.get().llm;
  ok('llm 配置含 human/red/black 三组', !!(defLlm && defLlm.human && defLlm.red && defLlm.black),
    JSON.stringify(defLlm && Object.keys(defLlm)));
  // 2) 旧平铺键兼容：写入时归一到 llm.human
  AppSettings.set({ apiKey: 'legacy-key', apiBaseUrl: 'https://legacy.com/v1', apiModel: 'legacy-model', useFunctionCalling: false });
  const lg = AppSettings.get().llm.human;
  ok('旧平铺键写入归一到 llm.human',
    lg.apiKey === 'legacy-key' && lg.baseUrl === 'https://legacy.com/v1' && lg.model === 'legacy-model' && lg.useFc === false,
    JSON.stringify(lg));
  ok('平铺旧键已从 settings 清除', AppSettings.get().apiKey === undefined && AppSettings.get().apiBaseUrl === undefined && AppSettings.get().useFunctionCalling === undefined);
  // 3) 红黑独立配置
  AppSettings.set({
    llm: {
      red: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'red-key', useFc: true },
      black: { provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', apiKey: 'black-key', useFc: false },
    },
  });
  const LLM2 = globalThis.LLMClient;
  ok('红黑 LLM 配置独立生效',
    LLM2.getConfig('red').model === 'deepseek-chat' && LLM2.getConfig('black').model === 'glm-4-flash' && LLM2.getConfig('black').useFc === false);
  ok('fcEnabled 按组判断（红开/黑关）', LLM2.fcEnabled('red') === true && LLM2.fcEnabled('black') === false);
  ok('Chat.configured 按槽判断（红组已配置）', (Chat.use('red'), Chat.configured()) === true);
  // 4) 会话槽历史隔离
  Chat.use('red'); Chat.history.push({ role: 'assistant', content: '红方发言' });
  Chat.use('black'); Chat.history.push({ role: 'assistant', content: '黑方发言' });
  Chat.use('human');
  ok('人机槽不含红黑发言（历史隔离）',
    !Chat.history.some(m => m.content === '红方发言' || m.content === '黑方发言'));
  Chat.use('red');
  ok('红槽保留红方发言且无黑方发言',
    Chat.history.some(m => m.content === '红方发言') && !Chat.history.some(m => m.content === '黑方发言'));
  // 5) 槽派生执子身份
  ok('红槽身份=执红', Chat.currentPersonaColor() === 'r');
  Chat.use('black');
  ok('黑槽身份=执黑', Chat.currentPersonaColor() === 'b');
  Chat.use('human');
  AppSettings.set({ playerColor: 'b' });
  ok('人机槽身份=玩家对面（AI 执红）', Chat.currentPersonaColor() === 'r');
  AppSettings.set({ playerColor: 'r' });
  // 6) LLM 调用携带 profile 与正确身份注入
  let capSys = null, capProfile = null;
  global.LLMClient.request = async (msgs, opts) => {
    capSys = (msgs[0] && msgs[0].content) || '';
    capProfile = opts && opts.profile;
    return '嗯。';
  };
  Chat.use('red');
  await Chat.quickAction('taunt');
  ok('红方会话：system 注入「执红方」且 profile=red',
    /执红方/.test(capSys) && capProfile === 'red', capProfile + '/' + /执(红|黑)方/.exec(capSys));
  Chat.use('black');
  await Chat.quickAction('taunt');
  ok('黑方会话：system 注入「执黑方」且 profile=black',
    /执黑方/.test(capSys) && capProfile === 'black', capProfile + '/' + /执(红|黑)方/.exec(capSys));
  global.LLMClient.request = realRequest;
  // 7) FC 降级按组隔离（smoke 场景复用 human 兼容导出）
  FCT2.resetFallback();
  FCT2.markFallback('red');
  ok('红组降级不影响人机组', FCT2.isFallback('red') === true && FCT2.isFallback('human') === false);
  ok('兼容导出 fallback 指向 human 组', FCT2.fallback.active === false);
  FCT2.resetFallback();
  Chat.use('human');

  console.log('== 设置页签：硬切换与三组表单契约（V0.4.1 UI） ==');
  // a) SettingsTabs 行为
  const tabsRoot = getEl('settingsTabs');
  const paneGeneral = getEl('paneGeneral');
  const paneHuman = getEl('paneHuman');
  const paneSpectate = getEl('paneSpectate');
  // 模拟初始 HTML：人机/观战 pane 默认 hidden
  [paneGeneral, paneHuman, paneSpectate].forEach(p => p._classes.add('hidden'));
  const mkBtn = pane => { const b = makeEl('button'); b._classes.add('stab'); b.dataset.pane = pane; return b; };
  const btnGeneral = mkBtn('general'), btnHuman = mkBtn('human'), btnSpectate = mkBtn('spectate');
  tabsRoot.appendChild(btnGeneral); tabsRoot.appendChild(btnHuman); tabsRoot.appendChild(btnSpectate);
  global.SettingsTabs.init({
    tabsRoot,
    panes: { general: paneGeneral, human: paneHuman, spectate: paneSpectate },
    initial: 'general',
  });
  ok('默认 active = general', global.SettingsTabs.active() === 'general');
  ok('paneGeneral 可见', !paneGeneral._classes.has('hidden'));
  ok('paneHuman/Spectate 默认隐藏', paneHuman._classes.has('hidden') && paneSpectate._classes.has('hidden'));
  // b) init 给 onChange：点击切换应触发；init 的 initial 不触发（已无 onChange，待会儿重 init 再验）
  let lastOnChange = null;
  global.SettingsTabs.init({
    tabsRoot,
    panes: { general: paneGeneral, human: paneHuman, spectate: paneSpectate },
    initial: 'general',
    onChange: k => { lastOnChange = k; },
  });
  ok('重新 init 不应触发 onChange（initial 不触发）', lastOnChange === null, lastOnChange);
  btnHuman.dispatch('click');
  ok('点击 human：active 切换为 human', global.SettingsTabs.active() === 'human');
  ok('点击触发 onChange(human)', lastOnChange === 'human', lastOnChange);
  ok('paneHuman 可见', !paneHuman._classes.has('hidden'));
  ok('btnHuman.active 加上了', btnHuman._classes.has('active'));
  ok('btnGeneral.active 移除了', !btnGeneral._classes.has('active'));
  // c) 程序化切换与非法 key
  global.SettingsTabs.switchTo('red');
  ok('非法 key 静默忽略', global.SettingsTabs.active() === 'human');
  global.SettingsTabs.switchTo('spectate');
  ok('switchTo 切到 spectate', global.SettingsTabs.active() === 'spectate');
  ok('paneSpectate 可见', !paneSpectate._classes.has('hidden'));
  ok('btnSpectate.active', btnSpectate._classes.has('active'));
  // d) 重复点同一 active：不触发 onChange
  lastOnChange = null;
  btnSpectate.dispatch('click');
  ok('重复点同一页签不触发 onChange', lastOnChange === null, lastOnChange);
  // e) DOM id 契约：三组表单 id 全在
  const NEW_IDS = [
    'setHumanProvider', 'setHumanBaseUrl', 'setHumanModel', 'setHumanApiKey', 'setHumanUseFc',
    'setHumanReasoning', 'setHumanReasoningOff', 'setHumanReasoningLow', 'setHumanReasoningMedium', 'setHumanReasoningHigh',
    'btnTestHumanApi', 'apiHumanTestResult',
    'setRedProvider', 'setRedBaseUrl', 'setRedModel', 'setRedApiKey', 'setRedUseFc',
    'setRedReasoning', 'setRedReasoningOff', 'setRedReasoningLow', 'setRedReasoningMedium', 'setRedReasoningHigh',
    'btnTestRedApi', 'apiRedTestResult',
    'setBlackProvider', 'setBlackBaseUrl', 'setBlackModel', 'setBlackApiKey', 'setBlackUseFc',
    'setBlackReasoning', 'setBlackReasoningOff', 'setBlackReasoningLow', 'setBlackReasoningMedium', 'setBlackReasoningHigh',
    'btnTestBlackApi', 'apiBlackTestResult',
    'setLlmTimeout', 'setLlmTimeout30', 'setLlmTimeout60', 'setLlmTimeout90', 'setLlmTimeout120', 'setLlmTimeout180',
  ];
  const missNew = NEW_IDS.filter(id => !elements.has(id));
  ok('24 个三组表单 id 全部存在', missNew.length === 0, missNew.join(','));
  // 旧 7 个 id 全废
  const DEAD_IDS = ['setProvider', 'setBaseUrl', 'setModel', 'setApiKey', 'setUseFc', 'btnTestApi', 'apiTestResult'];
  const aliveDead = DEAD_IDS.filter(id => elements.has(id));
  ok('旧 7 个 id 已废弃', aliveDead.length === 0, aliveDead.join(','));
  // f) 三组配置独立隔离：写一组不影响另外两组（数值已用前段 deepseek/glm 测试补过，这里追加 useFc 也独立）
  AppSettings.set({
    llm: {
      human: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'h-key', useFc: false },
      red:   { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'r-key', useFc: true },
      black: { provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', apiKey: 'b-key', useFc: false },
    },
  });
  const llmV = AppSettings.get().llm;
  ok('human.useFc=false / red.useFc=true / black.useFc=false 全部独立',
    llmV.human.useFc === false && llmV.red.useFc === true && llmV.black.useFc === false);
  ok('human.apiKey=h-key / red=r-key / black=b-key 互不污染',
    llmV.human.apiKey === 'h-key' && llmV.red.apiKey === 'r-key' && llmV.black.apiKey === 'b-key');
  // g) 测试按钮按 profile 调用 LLM.testConnection
  let connProfile = null;
  global.LLMClient.testConnection = async profile => { connProfile = profile; return 'PONG'; };
  // openSettings 的 fillProviders 已在阶段一并就位；这里只校验按钮 click 能传递正确 profile
  getEl('btnTestHumanApi').dispatch('click');
  await sleep(20);
  ok('人机测试按钮调用 LLM.testConnection(human)', connProfile === 'human', connProfile);
  getEl('btnTestRedApi').dispatch('click');
  await sleep(20);
  ok('红方测试按钮调用 LLM.testConnection(red)', connProfile === 'red', connProfile);
  getEl('btnTestBlackApi').dispatch('click');
  await sleep(20);
  ok('黑方测试按钮调用 LLM.testConnection(black)', connProfile === 'black', connProfile);
  global.LLMClient.testConnection = async profile => { connProfile = profile; return 'PONG'; };

  console.log('== 复盘棋谱：回合标注格式（V0.5.1） ==');
  const histBackup = Game.state.history;
  Game.state.history = [
    { move: { color: 'r' }, notation: '炮二平五' },
    { move: { color: 'b' }, notation: '马8进7' },
    { move: { color: 'r' }, notation: '马二进三' },
    { move: { color: 'b' }, notation: '车9平8' },
    { move: { color: 'r' }, notation: '车一平二' },
  ];
  const record = globalThis.Chat.movesRecordText();
  ok('回合号只随双方各走一手递增（1.红…1.黑…2.红…2.黑…3.红…）',
    record === '1.红炮二平五 1.黑马8进7 2.红马二进三 2.黑车9平8 3.红车一平二', record);
  Game.state.history = histBackup;

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('冒烟测试崩溃：', e); process.exit(1); });
