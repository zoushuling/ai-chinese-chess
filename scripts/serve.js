/* ============================================================
 * serve.js — zero-dependency static file server (needs Node.js)
 * Usage:  double-click "启动游戏.bat"  or run:  node scripts/serve.js
 * Opens the default browser at http://localhost:8800 automatically.
 * Set env SKIP_OPEN=1 to disable auto-opening the browser.
 * Ports tried in order: 8800, 8801, 8802, 8803.
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // 项目根目录（本脚本位于 scripts/ 下）
const PORTS = [8800, 8801, 8802, 8803];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  try {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch (e) {
      res.writeHead(400); res.end('Bad Request'); return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    // 拒绝控制字符（含 null 字节，fs.readFile 遇 \0 会抛 ERR_INVALID_ARG_VALUE 崩溃）
    if (/[\u0000-\u001f\u007f]/.test(urlPath)) {
      res.writeHead(400); res.end('Bad Request'); return;
    }

    const file = path.normalize(path.join(ROOT, urlPath));
    // block path traversal：不能只做 startsWith 前缀比较（会漏掉 ROOT2 这类兄弟目录）
    const rel = path.relative(ROOT, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    // 不对外暴露隐藏目录/工具缓存（.git/.tools/.npm-cache 等）与 node_modules
    const seg = rel.split(/[\\/]/);
    if (seg.some(s => s.startsWith('.') || s === 'node_modules' || /^logs_/.test(s))) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found: ' + urlPath);
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
  } catch (e) {
    // 兜底：任何未预期异常都不应让进程崩溃
    if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error'); }
    else { res.end(); }
  }
});

function tryListen(portIndex) {
  if (portIndex >= PORTS.length) {
    console.log('[ERROR] All ports are busy: ' + PORTS.join(', '));
    console.log('Please close other programs and try again.');
    process.exit(1);
  }
  const port = PORTS[portIndex];
  server.once('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log('[INFO] Port ' + port + ' is in use, trying ' + PORTS[portIndex + 1] + ' ...');
      tryListen(portIndex + 1);
    } else {
      console.log('[ERROR] ' + err.message);
      process.exit(1);
    }
  });
  // 只监听本机回环地址：这是本地启动器，不应把文件服务暴露给局域网
  server.listen(port, '127.0.0.1', () => {
    console.log('==============================================');
    console.log('  AI Chinese Chess is running');
    console.log('  Open in browser: http://localhost:' + port);
    console.log('  Close this window to stop the server.');
    console.log('==============================================');
    if (!process.env.SKIP_OPEN) {
      const cmd = process.platform === 'win32'
        ? 'start "" http://localhost:' + port
        : 'open http://localhost:' + port;
      require('child_process').exec(cmd, () => {});
    }
  });
}

tryListen(0);
