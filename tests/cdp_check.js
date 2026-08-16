/* CDP 检查：连接 Edge/Chrome 远程调试端口，导航到目标 URL，
 * 收集控制台消息与异常，并评估页面状态。
 * 用法：node tests/cdp_check.js <url> [port]
 */
'use strict';
const port = +(process.argv[3] || 9333);

async function main() {
  let list = null;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const j = await r.json();
      if (Array.isArray(j) && j.length) { list = j; break; }
    } catch (e) { /* not ready */ }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!list || !list.length) { console.log('NO_CDP: 未连接到浏览器'); process.exit(2); }

  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });

  let id = 0;
  const pending = new Map();
  function send(method, params) {
    return new Promise(res => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
  }
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map(a => (a.value !== undefined ? a.value : a.description || '')).join(' ');
      console.log('[console ' + m.params.type + '] ' + args);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      console.log('[exception] ' + d.text + ' ' + (d.exception && d.exception.description || ''));
    } else if (m.method === 'Log.entryAdded') {
      console.log('[log ' + m.params.entry.level + '] ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    } else if (m.method === 'Page.loadEventFired') {
      console.log('[event] load 完成');
    }
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: process.argv[2] });
  await new Promise(r => setTimeout(r, 4500));

  const evalRes = await send('Runtime.evaluate', {
    expression: `({ pieces: document.querySelectorAll('.piece').length,
                  status: (document.getElementById('statusText') || {}).textContent || '',
                  moves: (document.getElementById('moveList') || {}).innerHTML ? '有棋谱容器' : '无',
                  chatMsgs: document.querySelectorAll('.msg').length,
                  ready: document.readyState })`,
    returnByValue: true,
  });
  console.log('[eval] ' + JSON.stringify(evalRes.result && evalRes.result.result && evalRes.result.result.value));
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
