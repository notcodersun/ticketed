const http = require('http');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'storage.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN || '2026';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'ticketed_admin';

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

function cookieOptions(req, maxAge) {
  const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
  return [
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach((part) => {
    const [name, ...valueParts] = part.trim().split('=');
    if (!name) return;
    cookies[name] = decodeURIComponent(valueParts.join('=') || '');
  });
  return cookies;
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({
    role: 'admin',
    exp: Date.now() + 12 * 60 * 60 * 1000
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function isAdmin(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.role === 'admin' && Number(session.exp) > Date.now();
  } catch {
    return false;
  }
}

function setAdminCookie(req, res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(createSessionToken())}; ${cookieOptions(req, 12 * 60 * 60)}`);
}

function clearAdminCookie(req, res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(req, 0)}`);
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

function isRequestKey(key) {
  return /^test-request:[A-Z0-9]{8}$/.test(key) || /^request:[A-Z0-9]{8}$/.test(key);
}

function isTicketKey(key) {
  return /^test-ticket:[A-Z0-9]{20}$/.test(key) || /^ticket:[A-Z0-9]{20}$/.test(key);
}

function safePublicRequest(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.status !== 'pending') return false;
  if (!record.reqId || !record.name || !record.email || !record.upiref) return false;
  if (!Number.isInteger(Number(record.qty)) || Number(record.qty) < 1 || Number(record.qty) > 8) return false;
  if (record.ticketId || (Array.isArray(record.ticketIds) && record.ticketIds.length > 0)) return false;
  return true;
}

function cleanPublicRequest(record) {
  return {
    reqId: String(record.reqId).toUpperCase(),
    name: String(record.name).trim().slice(0, 120),
    email: String(record.email).trim().toLowerCase().slice(0, 160),
    phone: String(record.phone || '').trim().slice(0, 40),
    upiref: String(record.upiref).trim().slice(0, 60),
    qty: Math.max(1, Math.min(8, Number(record.qty) || 1)),
    sourceBand: String(record.sourceBand || '').trim().slice(0, 80),
    sourceBands: Array.isArray(record.sourceBands) ? record.sourceBands.map((v) => String(v).trim().slice(0, 80)).filter(Boolean).slice(0, 3) : [],
    submittedAt: new Date().toISOString(),
    status: 'pending',
    ticketIds: [],
    note: null
  };
}

function publicTicket(ticket) {
  return {
    id: ticket.id,
    name: ticket.name,
    email: ticket.email || '',
    ticketIndex: ticket.ticketIndex || 1,
    ticketTotal: ticket.ticketTotal || 1
  };
}

async function handleAdmin(req, res, url) {
  if (url.pathname === '/api/admin/me' && req.method === 'GET') {
    sendJson(res, 200, { authenticated: isAdmin(req) });
    return;
  }

  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const password = String(body.password || '');
    const given = Buffer.from(password);
    const expected = Buffer.from(ADMIN_PASSWORD);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) {
      sendError(res, 401, 'Invalid admin password');
      return;
    }
    setAdminCookie(req, res);
    sendJson(res, 200, { authenticated: true });
    return;
  }

  if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
    clearAdminCookie(req, res);
    sendJson(res, 200, { authenticated: false });
    return;
  }

  sendError(res, 404, 'Not found');
}

async function handlePublic(req, res, url) {
  const store = await readStore();

  if (url.pathname === '/api/public/capacity' && req.method === 'GET') {
    const prefix = url.searchParams.get('prefix') || '';
    if (prefix !== 'ticket:' && prefix !== 'test-ticket:') {
      sendError(res, 400, 'Invalid ticket prefix');
      return;
    }
    const sold = Object.keys(store).filter((key) => key.startsWith(prefix)).length;
    sendJson(res, 200, { sold });
    return;
  }

  if (url.pathname === '/api/public/status' && req.method === 'GET') {
    const requestPrefix = url.searchParams.get('requestPrefix') || '';
    const ticketPrefix = url.searchParams.get('ticketPrefix') || '';
    const q = (url.searchParams.get('q') || '').trim();
    if (!q || !['request:', 'test-request:'].includes(requestPrefix) || !['ticket:', 'test-ticket:'].includes(ticketPrefix)) {
      sendError(res, 400, 'Invalid status lookup');
      return;
    }

    const requestRecords = Object.entries(store)
      .filter(([key]) => key.startsWith(requestPrefix))
      .map(([, value]) => {
        try { return JSON.parse(value); } catch { return null; }
      })
      .filter(Boolean);

    let request = requestRecords.find((record) => String(record.reqId || '').toUpperCase() === q.toUpperCase());
    if (!request) {
      const matches = requestRecords.filter((record) => String(record.email || '').toLowerCase() === q.toLowerCase());
      const statusRank = { approved: 2, pending: 1, rejected: 0 };
      matches.sort((a, b) => {
        const rankDiff = (statusRank[b.status] ?? 0) - (statusRank[a.status] ?? 0);
        if (rankDiff !== 0) return rankDiff;
        return new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0);
      });
      request = matches[0];
    }

    if (!request) {
      sendJson(res, 200, { request: null, tickets: [] });
      return;
    }

    const safeRequest = {
      reqId: request.reqId,
      status: request.status,
      note: request.note || null,
      ticketIds: Array.isArray(request.ticketIds) ? request.ticketIds : (request.ticketId ? [request.ticketId] : [])
    };
    const tickets = safeRequest.status === 'approved'
      ? safeRequest.ticketIds.map((id) => {
        const key = ticketPrefix + id;
        try { return store[key] ? JSON.parse(store[key]) : null; } catch { return null; }
      }).filter(Boolean).map(publicTicket)
      : [];
    sendJson(res, 200, { request: safeRequest, tickets });
    return;
  }

  sendError(res, 404, 'Not found');
}

function storageKeyFromUrl(url) {
  return decodeURIComponent(url.pathname.slice('/api/storage/'.length));
}

async function handleStorage(req, res, url) {
  const admin = isAdmin(req);

  if (req.method === 'GET' && url.pathname === '/api/storage') {
    if (!admin) {
      sendError(res, 401, 'Admin session required');
      return;
    }
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
    if (!admin) {
      sendError(res, 401, 'Admin session required');
      return;
    }
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
    let valueToStore = body.value;
    if (!admin) {
      if (!isRequestKey(key)) {
        sendError(res, 401, 'Admin session required');
        return;
      }
      let parsed;
      try { parsed = JSON.parse(body.value); } catch {
        sendError(res, 400, 'Invalid request payload');
        return;
      }
      if (!safePublicRequest(parsed) || key.split(':')[1] !== parsed.reqId) {
        sendError(res, 403, 'Public submissions can only create pending requests');
        return;
      }
      valueToStore = JSON.stringify(cleanPublicRequest(parsed));
    } else if (!isRequestKey(key) && !isTicketKey(key)) {
      sendError(res, 400, 'Invalid storage key');
      return;
    }
    const store = await readStore();
    if (!admin && key in store) {
      sendError(res, 409, 'Submission already exists');
      return;
    }
    store[key] = valueToStore;
    await writeStore(store);
    sendJson(res, 200, { key, value: valueToStore });
    return;
  }

  if (req.method === 'DELETE') {
    if (!admin) {
      sendError(res, 401, 'Admin session required');
      return;
    }
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
    } else if (url.pathname.startsWith('/api/admin')) {
      await handleAdmin(req, res, url);
    } else if (url.pathname.startsWith('/api/public')) {
      await handlePublic(req, res, url);
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
  if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PIN) {
    console.warn('WARNING: using default admin password 2026. Set ADMIN_PASSWORD before sharing the public URL.');
  }
});
