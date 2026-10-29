const http = require('node:http');
const { Duplex } = require('node:stream');

// Send actual HTTP bytes through Node's HTTP parser and the real Express app,
// without binding a TCP port (also works in network-restricted sandboxes).
const injectHttp = (app, { method = 'GET', path = '/', body, token, headers = {}, rawBody, timeoutMs = 2000 } = {}) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({
      read() {},
      write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }
    });
    socket.setTimeout = () => socket;
    socket.setNoDelay = () => socket;
    socket.setKeepAlive = () => socket;
    const server = http.createServer(app);
    const cleanup = () => { clearTimeout(timeout); socket.destroy(); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`${method} ${path} did not respond`)); }, timeoutMs);
    socket.on('error', (error) => { cleanup(); reject(error); });
    server.on('request', (req, res) => res.on('finish', () => {
      const bytes = Buffer.concat(chunks).toString();
      const split = bytes.indexOf('\r\n\r\n');
      const lines = bytes.slice(0, split).split('\r\n');
      const status = Number(lines.shift().split(' ')[1]);
      const responseHeaders = Object.fromEntries(lines.map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      const text = bytes.slice(split + 4);
      let parsed = text;
      if (responseHeaders['content-type']?.includes('application/json')) {
        try { parsed = JSON.parse(text); }
        catch (error) { cleanup(); reject(error); return; }
      }
      cleanup();
      resolve({ status, headers: responseHeaders, body: parsed, text });
    }));
    const payload = rawBody ?? (body === undefined ? '' : JSON.stringify(body));
    const requestHeaders = { Host: 'localhost', Connection: 'close', ...headers };
    if (body !== undefined || rawBody !== undefined) {
      requestHeaders['Content-Type'] ||= 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    server.emit('connection', socket);
    socket.push(`${method} ${path} HTTP/1.1\r\n${Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n${payload}`);
  });

const registeredRoutes = (app) => {
  const result = [];
  const walk = (stack, prefix = '') => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          result.push(`${method.toUpperCase()} ${(prefix + layer.route.path).replace(/\/$/, '') || '/'}`);
        }
      } else if (layer.handle?.stack) {
        const match = layer.regexp.source.match(/^\^((?:\\\/|[a-zA-Z0-9_-])*)/);
        const path = (match?.[1] || '').replace(/\\\//g, '/').replace(/\/$/, '');
        walk(layer.handle.stack, prefix + path);
      }
    }
  };
  walk(app._router.stack);
  return result;
};
module.exports = { injectHttp, registeredRoutes };
