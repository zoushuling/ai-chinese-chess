/* ============================================================
 * build-single-file.js — 从多文件源码生成单文件版 ai-chinese-chess.html
 * 用法：node scripts/build-single-file.js
 * 生成逻辑：
 *   1. 读取 index.html
 *   2. 把 <link rel="stylesheet" href="css/style.css"> 内联为 <style>
 *   3. 把所有 <script src="js/xxx.js"></script> 内联为 <script>
 * 注意：ai-chinese-chess.html 由本脚本生成，请勿直接手改。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // 项目根目录（本脚本位于 scripts/ 下）
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

/* ---------- 生成提示 ---------- */
html = html.replace(
  '<!DOCTYPE html>',
  '<!DOCTYPE html>\n<!-- 单文件版由 scripts/build-single-file.js 生成，请勿手改；修改源码后运行 node scripts/build-single-file.js -->'
);

fs.writeFileSync(path.join(ROOT, 'ai-chinese-chess.html'), html, 'utf8');
console.log('Regenerated ai-chinese-chess.html');
