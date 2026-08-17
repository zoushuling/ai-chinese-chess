/* ============================================================
 * gen-board-svg.js — 用真实引擎数据生成 README 棋盘预览图
 * 输出：docs/assets/board-preview.svg（GitHub 原生渲染，可当截图用）
 * 用法：node tools/gen-board-svg.js
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'js', 'engine.js')); // 挂载 globalThis.ChessEngine
const E = globalThis.ChessEngine;
const { parseFEN, START_FEN, RED, PIECE_NAME } = E;

const { board } = parseFEN(START_FEN);

// —— 几何参数（与 css/style.css 配色一致）——
const CELL = 64;
const X0 = 60, Y0 = 150;            // 棋盘左上角
const CHAT_X = X0 + 9 * CELL + 40;  // 右侧聊天面板 x
const CHAT_W = 235;
const W = CHAT_X + CHAT_W + 40;
const H = Y0 + 10 * CELL + 60;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const out = [];
const push = s => out.push(s);

// —— 头部与配色 ——
push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI','Microsoft YaHei',sans-serif">`);
push(`<defs>`);
push(`<radialGradient id="bg" cx="30%" cy="0%" r="95%"><stop offset="0%" stop-color="#3b3055"/><stop offset="100%" stop-color="#2b2438"/></radialGradient>`);
push(`<linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#f0d9a8"/><stop offset="45%" stop-color="#e6c58a"/><stop offset="100%" stop-color="#b98a4e"/></linearGradient>`);
push(`<radialGradient id="piece" cx="35%" cy="30%" r="80%"><stop offset="0%" stop-color="#fff7e0"/><stop offset="55%" stop-color="#f3e2bb"/><stop offset="100%" stop-color="#d9b877"/></radialGradient>`);
push(`</defs>`);
push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);

// 标题
push(`<text x="${X0}" y="84" font-size="34" font-weight="700" fill="#efe9dd">AI 对话象棋</text>`);
push(`<text x="${X0}" y="118" font-size="16" fill="#a89fc0">会聊天、有性格的 AI 棋手 · 纯前端零依赖</text>`);

// —— 棋盘底盘 ——
const BW = 9 * CELL, BH = 10 * CELL;
push(`<rect x="${X0}" y="${Y0}" width="${BW}" height="${BH}" rx="10" fill="url(#wood)"/>`);

const line = (x1, y1, x2, y2, w = 1.5) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#7a4a1f" stroke-width="${w}"/>`;

// 网格线（楚河汉界处断开）
for (let c = 0; c < 9; c++) {
  const x = X0 + c * CELL;
  push(line(x, Y0, x, Y0 + 4 * CELL));
  push(line(x, Y0 + 5 * CELL, x, Y0 + 9 * CELL));
}
for (let r = 0; r < 10; r++) {
  const y = Y0 + r * CELL;
  push(line(X0, y, X0 + 8 * CELL, y));
}
push(`<rect x="${X0}" y="${Y0}" width="${BW}" height="${BH}" fill="none" stroke="#7a4a1f" stroke-width="3"/>`);

// 九宫斜线
const palace = (r0, c0) => {
  const x = X0 + c0 * CELL, y = Y0 + r0 * CELL;
  push(line(x, y, x + 2 * CELL, y + 2 * CELL));
  push(line(x + 2 * CELL, y, x, y + 2 * CELL));
};
palace(0, 3); palace(7, 3);

// 楚河汉界
push(`<text x="${X0 + 2.5 * CELL}" y="${Y0 + 4.5 * CELL + 8}" text-anchor="middle" font-size="30" font-family="KaiTi,'STKaiti',serif" fill="#7a4a1f" opacity="0.85">楚 河</text>`);
push(`<text x="${X0 + 6.5 * CELL}" y="${Y0 + 4.5 * CELL + 8}" text-anchor="middle" font-size="30" font-family="KaiTi,'STKaiti',serif" fill="#7a4a1f" opacity="0.85">汉 界</text>`);

// 炮位 / 兵位角标
const cornerMarks = (r, c) => {
  const x = X0 + c * CELL, y = Y0 + r * CELL, m = 7;
  const mk = (cx, cy, dx, dy) => { push(line(cx, cy, cx + dx, cy)); push(line(cx, cy, cx, cy + dy)); };
  mk(x, y, m, m);                       // 左上
  mk(x + CELL, y, -m, m);               // 右上
  mk(x, y + CELL, m, -m);               // 左下
  mk(x + CELL, y + CELL, -m, -m);       // 右下
};
[[2, 1], [2, 7], [7, 1], [7, 7]].forEach(([r, c]) => cornerMarks(r, c));       // 炮
for (let c = 0; c < 9; c += 2) { cornerMarks(3, c); cornerMarks(6, c); }        // 兵/卒

// —— 棋子（来自真实引擎 START_FEN）——
for (let r = 0; r < 10; r++) {
  for (let c = 0; c < 9; c++) {
    const p = board[r][c];
    if (!p) continue;
    const cx = X0 + c * CELL + CELL / 2;
    const cy = Y0 + r * CELL + CELL / 2;
    const col = p.color === RED ? '#b03a2e' : '#222831';
    const ch = PIECE_NAME[p.type][p.color === RED ? 0 : 1];
    push(`<circle cx="${cx}" cy="${cy}" r="26" fill="url(#piece)" stroke="${col}" stroke-width="2.5"/>`);
    push(`<text x="${cx}" y="${cy + 8}" text-anchor="middle" font-size="24" font-weight="700" fill="${col}" font-family="KaiTi,'STKaiti',serif">${ch}</text>`);
  }
}

// 底部状态条
push(`<rect x="${X0}" y="${Y0 + BH + 16}" width="168" height="30" rx="15" fill="rgba(242,193,78,.14)" stroke="#f2c14e"/>`);
push(`<text x="${X0 + 84}" y="${Y0 + BH + 36}" text-anchor="middle" font-size="13" fill="#f2c14e">轮到你走 · 红方</text>`);

// —— 右侧聊天面板（示意）——
const cxp = CHAT_X, cyp = Y0;
push(`<rect x="${cxp}" y="${cyp}" width="${CHAT_W}" height="${BH}" rx="10" fill="#3a3150"/>`);
push(`<rect x="${cxp}" y="${cyp}" width="${CHAT_W}" height="44" rx="10" fill="#453a5e"/>`);
push(`<text x="${cxp + 14}" y="${cyp + 28}" font-size="15" fill="#efe9dd">💬 对局聊天</text>`);

const bubbles = [
  { who: 'ai', text: '嘿嘿，炮二平五，\n当头炮！敢接吗？' },
  { who: 'me', text: '你也太嚣张了！' },
  { who: 'ai', text: '怕了？要不要我\n放你一马 😏' },
];
let by = cyp + 70;
for (const b of bubbles) {
  const lines = b.text.split('\n');
  const bw = CHAT_W - 28;
  const bht = lines.length * 20 + 16;
  const bx = b.who === 'ai' ? cxp + 14 : cxp + CHAT_W - 14 - bw;
  push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bht}" rx="8" fill="${b.who === 'ai' ? '#453a5e' : '#f2c14e'}"/>`);
  const tc = b.who === 'ai' ? '#efe9dd' : '#3a2a08';
  lines.forEach((ln, i) => push(`<text x="${bx + 10}" y="${by + 18 + i * 20}" font-size="13" fill="${tc}">${esc(ln)}</text>`));
  by += bht + 10;
}
push(`<rect x="${cxp + 10}" y="${cyp + BH - 48}" width="${CHAT_W - 20}" height="32" rx="16" fill="#221d33"/>`);
push(`<text x="${cxp + 24}" y="${cyp + BH - 28}" font-size="12" fill="#a89fc0">输入消息…（回车发送）</text>`);

push(`</svg>`);

const target = path.join(__dirname, '..', 'docs', 'assets', 'board-preview.svg');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out.join('\n'), 'utf8');
console.log('written:', target, '(' + out.join('').length + ' bytes)');
