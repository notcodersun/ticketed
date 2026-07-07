const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'storage.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

let writeQueue = Promise.resolve();

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, '{}\n');
  }
}

async function readStore() {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function writeStore(store) {
  writeQueue = writeQueue.then(async () => {
    await ensureDataFile();
    const tmp = `${DATA_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n');
    await fs.rename(tmp, DATA_FILE);
  });
  return writeQueue;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function storageKeyFromUrl(url) {
  return decodeURIComponent(url.pathname.slice('/api/storage/'.length));
}

async function handleStorage(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/storage') {
    const prefix = url.searchParams.get('prefix') || '';
    const store = await readStore();
    const keys = Object.keys(store).filter((key) => key.startsWith(prefix));
    sendJson(res, 200, { keys });
    return;
  }

  if (!url.pathname.startsWith('/api/storage/')) {
    sendError(res, 404, 'Not found');
    return;
  }

  const key = storageKeyFromUrl(url);
  if (!key) {
    sendError(res, 400, 'Missing storage key');
    return;
  }

  if (req.method === 'GET') {
    const store = await readStore();
    if (!(key in store)) {
      sendJson(res, 200, null);
      return;
    }
    sendJson(res, 200, { key, value: store[key] });
    return;
  }

  if (req.method === 'PUT') {
    const body = await readJsonBody(req);
    if (typeof body.value !== 'string') {
      sendError(res, 400, 'Expected a string value');
      return;
    }
    const store = await readStore();
    store[key] = body.value;
    await writeStore(store);
    sendJson(res, 200, { key, value: body.value });
    return;
  }

  if (req.method === 'DELETE') {
    const store = await readStore();
    delete store[key];
    await writeStore(store);
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  sendError(res, 405, 'Method not allowed');
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const decodedPath = decodeURIComponent(requestedPath);
  const filePath = path.join(ROOT, decodedPath);
  const relative = path.relative(ROOT, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.startsWith('.git') || relative.startsWith('data')) {
    sendError(res, 404, 'Not found');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      sendError(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    const data = await fs.readFile(filePath);
    res.end(data);
  } catch {
    sendError(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
    } else if (url.pathname.startsWith('/api/storage')) {
      await handleStorage(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    console.error(error);
    sendError(res, 500, 'Server error');
  }
});

server.listen(PORT, () => {
  console.log(`Ticketed server running on http://localhost:${PORT}`);
});
