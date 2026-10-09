/* ============================================================
   基于Web平台的人脸表情识别系统 —— 极简静态服务器（Node.js 备用方案）
   ------------------------------------------------------------
   作用：把项目文件夹当成静态网站发布出去。
        真正的识别计算全部在浏览器里完成，与 Node.js 无关。
   用法：node server.js [端口]      默认端口 8000
   说明：当电脑上没有 Python 时，启动脚本会自动改用本文件。
   ============================================================ */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.argv[2] ? Number(process.argv[2]) : 8000;
const ROOT = __dirname;

/* 浏览器加载 .json 和 .bin 时必须给出正确的 Content-Type，否则模型会加载失败 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin':  'application/octet-stream',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);

  // 防止通过 ../ 访问项目目录以外的文件
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + urlPath);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('  [ERROR] Port ' + PORT + ' is already in use. Try: node server.js 8080');
  } else {
    console.error('  [ERROR] ' + err.message);
  }
  process.exit(1);
});

/* 说明：这里的提示故意只用英文。
   Node.js 向 Windows 控制台输出的是 UTF-8 字节，而中文系统的控制台默认是 GBK(936)，
   直接打印中文会变成乱码。英文则完全不受影响。 */
server.listen(PORT, () => {
  console.log('');
  console.log('  ============================================================');
  console.log('     Face Expression Recognition System');
  console.log('     Local static server (Node.js fallback)');
  console.log('  ============================================================');
  console.log('');
  console.log('  URL : http://localhost:' + PORT + '/index.html');
  console.log('');
  console.log('  Keep this window open. Closing it stops the server.');
  console.log('');
});
