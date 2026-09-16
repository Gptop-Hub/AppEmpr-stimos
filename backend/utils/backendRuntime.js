const http = require('http');
const net = require('net');
const path = require('path');

const BACKEND_SERVICE_ID = 'app-emprestimos-backend';

function normalizeComparablePath(value) {
  if (!value) return '';
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isExpectedBackendHealth(payload, expectedAppDataDir = null) {
  if (!payload || payload.ok !== true || typeof payload !== 'object') return false;
  if (payload.service !== BACKEND_SERVICE_ID) return false;
  if (!payload.appDataDir || !payload.dbPath) return false;
  if (!expectedAppDataDir) return true;

  const expected = normalizeComparablePath(expectedAppDataDir);
  const actualAppData = normalizeComparablePath(payload.appDataDir);
  const actualDb = normalizeComparablePath(payload.dbPath);
  const expectedPrefix = `${expected}${path.sep}`;

  return actualAppData === expected && actualDb.startsWith(expectedPrefix);
}

function requestBackendHealth({ host = '127.0.0.1', port, timeout = 800 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { method: 'GET', host, port, path: '/health', timeout },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length <= 64 * 1024) body += chunk;
        });
        res.on('end', () => {
          const contentType = String(res.headers['content-type'] || '').toLowerCase();
          if (res.statusCode !== 200 || !contentType.includes('application/json')) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function isPortAvailable({ host = '127.0.0.1', port } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function isPortReachable({ host = '127.0.0.1', port, timeout = 500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function selectBackendPort({
  host = '127.0.0.1',
  preferredPort = 3001,
  expectedAppDataDir = null,
  maxAttempts = 20,
} = {}) {
  const preferred = Number(preferredPort) || 3001;
  const candidates = [
    preferred,
    ...Array.from({ length: maxAttempts }, (_, index) => 3001 + index),
  ].filter((port, index, list) => port > 0 && port < 65536 && list.indexOf(port) === index);
  const conflicts = [];

  for (const port of candidates) {
    const health = await requestBackendHealth({ host, port, timeout: 600 });
    if (isExpectedBackendHealth(health, expectedAppDataDir)) {
      return { port, reuse: true, health, conflicts };
    }

    if (await isPortReachable({ host, port })) {
      conflicts.push({
        port,
        reason: health ? 'backend_de_outro_banco' : 'porta_ocupada_por_outro_servico',
      });
      continue;
    }

    if (await isPortAvailable({ host, port })) {
      return { port, reuse: false, health: null, conflicts };
    }

    conflicts.push({
      port,
      reason: health ? 'backend_de_outro_banco' : 'porta_ocupada_por_outro_servico',
    });
  }

  throw new Error('Nenhuma porta livre foi encontrada para iniciar o backend.');
}

module.exports = {
  BACKEND_SERVICE_ID,
  normalizeComparablePath,
  isExpectedBackendHealth,
  requestBackendHealth,
  isPortAvailable,
  isPortReachable,
  selectBackendPort,
};
