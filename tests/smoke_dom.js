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
require('../js/ai.js');
require('../js/personas.js');
require('../js/llm.js');
require('../js/game.js');
require('../js/tts.js');
require('../js/chat.js');
require('../js/sound.js');
require('../js/main.js');

const Eng = globalThis.ChessEngine;
const Game = globalThis.Game;
const RED = Eng.RED, BLACK = Eng.BLACK;

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
    !!ctx && ctx.personaColor === 'b' && !!ctx.lastMove && ctx.lastMove.color === 'b',
    JSON.stringify(ctx && { personaColor: ctx.personaColor, lastMove: ctx.lastMove }));

  console.log('== 提示 ==');
  await globalThis.Chat.quickAction('hint');
  const hintLine = getEl('chatMessages').children
    .map(x => String(x.textContent || ''))
    .find(t => t.includes('💡 提示'));
  ok('提示文字不含 undefined', !!hintLine && !hintLine.includes('undefined'), hintLine);
  ok('提示文字包含推荐走法', !!hintLine && /推荐 .+/.test(hintLine), hintLine);

  console.log('== 悔棋（离线：直接悔棋） ==');
  // 玩家回合悔棋 = 撤回 AI 应手 + 玩家上一手，回到玩家重走
  getEl('btnUndo').dispatch('click');
  await sleep(30);
  ok('悔棋回退到开局（棋谱清空）',
    Game.state.history.length === 0 && Game.state.turn === 'r' && Eng.toFEN(Game.state.board, Game.state.turn) === Eng.START_FEN,
    Game.state.history.length + '/' + Game.state.turn);

  console.log('== 人设管理 ==');
  const Personas = globalThis.Personas;
  ok('内置预设包含雌小鬼「小魅」', Personas.getAll().some(p => p.id === 'mesugaki' && p.name === '小魅'));
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

  console.log('== 悔棋审批：按钮点击集成（LLM 同意） ==');
  const Chat = globalThis.Chat;
  const realRequest = global.LLMClient.request;
  AppSettings.set({ apiKey: 'test-key', apiBaseUrl: 'https://example.com/v1', apiModel: 'test-model', playerColor: 'r', maxUndo: 2 });
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

  console.log('== 悔棋审批（直接调用 Chat.requestUndo） ==');
  AppSettings.set({ apiKey: 'test-key', apiBaseUrl: 'https://example.com/v1', apiModel: 'test-model', playerColor: 'b', maxUndo: 2 });
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
  global.LLMClient.request = async () => '{"allow":true,"reply":"行，悔就悔吧。"}';
  let v = await Chat.requestUndo({ count: 1, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  ok('LLM 同意悔棋：返回 allow=true', !!(v && v.allow === true && /悔/.test(v.reply)), JSON.stringify(v));
  ok('悔棋批复渲染为 AI 气泡', getEl('chatMessages').children.some(c => c.children && c.children.length && String(c.children[0].textContent || '').includes('行，悔就悔吧')), getEl('chatMessages').children.length);

  global.LLMClient.request = async () => '{"allow":false,"reply":"驳回，就你这态度还想悔棋？"}';
  v = await Chat.requestUndo({ count: 2, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  ok('LLM 可驳回悔棋：返回 allow=false', !!(v && v.allow === false), JSON.stringify(v));

  global.LLMClient.request = async () => { throw new Error('模拟网络错误'); };
  v = await Chat.requestUndo({ count: 3, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  ok('LLM 失败且态度尚可 → 本地兜底同意', !!(v && v.allow === true && /悔/.test(v.reply)), JSON.stringify(v));
  Chat.history.push({ role: 'user', content: '你个垃圾，快点下！' });
  v = await Chat.requestUndo({ count: 4, steps: 1, moves: [{ notation: '车1进1', color: 'r', captured: null }] });
  ok('LLM 失败且玩家态度差 → 本地兜底驳回', !!(v && v.allow === false && /驳回/.test(v.reply)), JSON.stringify(v));
  global.LLMClient.request = realRequest;

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
  let spoke = false;
  try { TTS.speakText('你好。这步棋走得好！', sv); spoke = true; } catch (e) { spoke = false; }
  ok('无语音环境下朗读静默不抛错', spoke === true);
  try { TTS.stop(); ok('stop 可安全调用', true); } catch (e) { ok('stop 可安全调用', false); }

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('冒烟测试崩溃：', e); process.exit(1); });
