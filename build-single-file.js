/* ============================================================
 * build-single-file.js — 从多文件源码生成单文件版 ai-chinese-chess.html
 * 用法：node build-single-file.js
 * 生成逻辑：
 *   1. 读取 index.html
 *   2. 把 <link rel="stylesheet" href="css/style.css"> 内联为 <style>
 *   3. 把所有 <script src="js/xxx.js"></script> 内联为 <script>
 *   4. 注入单文件版独有的「📖 说明」帮助按钮/弹窗/脚本
 * 注意：ai-chinese-chess.html 由本脚本生成，请勿直接手改。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let html = read('index.html');

/* ---------- 内联 CSS ---------- */
const css = read('css/style.css');
html = html.replace(
  /<link rel="stylesheet" href="css\/style\.css">/,
  `<style>\n${css}\n  </style>`
);

/* ---------- 内联 JS（按 index.html 中的 script 顺序） ---------- */
const scriptSrcRe = /<script src="js\/([^"]+\.js)"><\/script>/g;
html = html.replace(scriptSrcRe, (match, file) => {
  const js = read(path.join('js', file));
  return `  <script>\n${js}\n  </script>`;
});

/* ---------- 单文件版独有的玩法说明 ---------- */
html = html.replace(
  '        <button id="btnPersonas"',
  '        <button id="btnHelp" title="玩法说明">📖 说明</button>\n        <button id="btnPersonas"'
);

const helpModal = `  <!-- ======== 玩法说明弹窗（单文件版额外提供） ======== -->
  <div id="modalHelp" class="modal hidden">
    <div class="modal-box">
      <div class="modal-title">📖 玩法说明</div>
      <div class="modal-body">
        <div class="hint">
          <p style="margin:0 0 8px;">🎮 <b>基本玩法</b>：点击己方棋子（绿色高亮并显示落点提示），再点击目标位置走子；红方先手。</p>
          <p style="margin:0 0 8px;">🤖 <b>人机对战</b>：右上角 ⚙️ 设置 可选择对手人设、玩家执子、AI 棋力、悔棋次数。</p>
          <p style="margin:0 0 8px;">💬 <b>AI 聊天</b>：右侧面板可自由聊天，或使用「分析局面 / 给我提示 / 嘲讽我 / 复盘」快捷指令。</p>
          <p style="margin:0 0 8px;">🎬 <b>AI 观战</b>：顶栏切换到「AI 观战」，看两位 AI 按不同人设对弈并实时解说。</p>
          <p style="margin:0 0 8px;">🔑 <b>API Key</b>：AI 聊天与“有风格”的走子需要在 ⚙️ 设置 中配置 OpenAI 兼容 API Key（仅保存在本机浏览器）。<b>不配置也能玩</b>，AI 会降级为本地引擎。</p>
          <p style="margin:0;">⚠️ <b>提示</b>：若双击本文件后 API 调用失败，可能是浏览器对 file:// 页面的跨域限制，请更换支持 CORS 的服务商，或使用原项目的「启动游戏.bat」本地服务器方式。</p>
        </div>
      </div>
      <div class="modal-foot">
        <button id="btnHelpClose" class="primary">知道了</button>
      </div>
    </div>
  </div>

  <!-- 内联脚本（单文件版） -->`;

html = html.replace(
  '  <!-- 脚本（经典 script 加载，无构建，双击可开） -->',
  '  <!-- 单文件版：所有 CSS/JS 已内联，直接双击运行 -->\n' + helpModal
);

const helpScript = `  <script>
(function () {
  'use strict';
  var show = function (id) { document.getElementById(id).classList.remove('hidden'); };
  var hide = function (id) { document.getElementById(id).classList.add('hidden'); };
  var btn = document.getElementById('btnHelp');
  var close = document.getElementById('btnHelpClose');
  var modal = document.getElementById('modalHelp');
  if (btn) btn.addEventListener('click', function () { show('modalHelp'); });
  if (close) close.addEventListener('click', function () { hide('modalHelp'); });
  if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) hide('modalHelp'); });
})();
  </script>`;

html = html.replace('</body>', helpScript + '\n</body>');

/* ---------- 生成提示 ---------- */
html = html.replace(
  '<!DOCTYPE html>',
  '<!DOCTYPE html>\n<!-- 单文件版由 build-single-file.js 生成，请勿手改；修改源码后运行 node build-single-file.js -->'
);

fs.writeFileSync(path.join(ROOT, 'ai-chinese-chess.html'), html, 'utf8');
console.log('Regenerated ai-chinese-chess.html');
