/**
 * @req REQ-204 / REQ-303 — PKE PWA + 同步 API 同源入口。
 * 静态 dist + /api 反代到 127.0.0.1:3000。
 */
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');

const app = express();
const WEB_ROOT = process.env.PKE_WEB_ROOT || '/opt/pke-web';
const API_PORT = Number(process.env.PKE_API_PORT || 3000);
const PORT = Number(process.env.PKE_WEB_PORT || 8080);
// 默认只绑回环；要直接暴露到 tailnet 时可设 PKE_WEB_HOST=100.x.y.z（不要用 0.0.0.0）。
const HOST = process.env.PKE_WEB_HOST || '127.0.0.1';

// PKE_WEB_LOG=1 时打印访问日志（排查客户端到底请求了哪些资源）。
if (process.env.PKE_WEB_LOG === '1') {
  app.use((req, _res, next) => {
    const ua = String(req.headers['user-agent'] || '').replace(/\s+/g, ' ').slice(0, 50);
    console.log(`${new Date().toISOString()} ${req.method} ${req.url.slice(0, 90)} :: ${ua}`);
    next();
  });
}

app.use('/api', (req, res) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: API_PORT,
      path: req.originalUrl,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` }
    },
    (response) => {
      const headers = { ...response.headers };
      const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      const isJson = String(response.headers['content-type'] || '').includes('application/json');
      if (wantsGzip && isJson) {
        // 笔记正文可能内联 base64 图片（几百 KB）；慢速链路上压缩 + 去掉定长头。
        delete headers['content-length'];
        headers['content-encoding'] = 'gzip';
        headers['vary'] = 'Accept-Encoding';
        res.writeHead(response.statusCode || 502, headers);
        const gzip = zlib.createGzip({ level: 6 });
        gzip.on('error', () => res.end());
        response.pipe(gzip).pipe(res);
        return;
      }
      res.writeHead(response.statusCode || 502, headers);
      response.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).json({ ok: false, error: 'sync upstream unavailable' });
    else res.end();
  });
  req.pipe(upstream);
});

// 文本资源 gzip：手机走公网中继时首包体积是主要瓶颈，压缩后约为原来的 1/3~1/4。
const GZIP_TYPES = /\.(js|css|svg|json|html)$/i;
const gzipCache = new Map();

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
  if (!GZIP_TYPES.test(req.path)) return next();
  const target = path.join(WEB_ROOT, decodeURIComponent(req.path));
  if (!target.startsWith(WEB_ROOT)) return next();
  fs.readFile(target, (error, buffer) => {
    if (error) return next();
    let compressed = gzipCache.get(target);
    if (!compressed) {
      compressed = zlib.gzipSync(buffer, { level: 9 });
      gzipCache.set(target, compressed);
    }
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type(path.extname(target));
    res.end(compressed);
  });
});

app.use(express.static(WEB_ROOT, { index: false, maxAge: '1h' }));
app.use((_req, res) => {
  res.sendFile(path.join(WEB_ROOT, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`PKE web listening on http://${HOST}:${PORT}`);
});
