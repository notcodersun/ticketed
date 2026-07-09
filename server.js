const http = require('http');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const nodemailer = require('nodemailer');

function loadEnvFile(filePath = path.join(__dirname, '.env')) {
  try {
    const raw = require('fs').readFileSync(filePath, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    });
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not load .env: ${error.message}`);
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
function defaultDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try {
    if (require('fs').existsSync('/var/data')) return '/var/data';
  } catch {}
  return path.join(ROOT, 'data');
}
const DATA_DIR = defaultDataDir();
const DATA_FILE = path.join(DATA_DIR, 'storage.json');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const EMAIL_LOG_PREFIX = 'email-log:';
const TEST_EMAIL_LOG_PREFIX = 'test-email-log:';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN || '2026';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'ticketed_admin';
const EMAIL_TEMPLATE_FILE = path.join(ROOT, 'emailjs-ticket-template.html');
const SERVER_EVENT = {
  name: 'M.U.M',
  dateTime: 'Sunday, 26 July 2026 · 3:00 PM',
  venueName: 'Biswas Enclave, Kasba, Kolkata',
  venueMapLink: 'https://maps.app.goo.gl/c61Jdtr5MVm3JkU97',
  price: 199.69
};

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
let mailTransport = null;

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
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

async function writeBackupSnapshot(store, reason = 'write') {
  await ensureDataFile();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReason = String(reason).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'write';
  const file = path.join(BACKUP_DIR, `storage-${stamp}-${safeReason}.json`);
  await fs.writeFile(file, JSON.stringify({ createdAt: new Date().toISOString(), reason, store }, null, 2) + '\n');
  return file;
}

async function pruneBackups(limit = Number(process.env.BACKUP_LIMIT || 120)) {
  try {
    const files = (await fs.readdir(BACKUP_DIR)).filter((name) => name.endsWith('.json')).sort();
    const remove = files.slice(0, Math.max(0, files.length - limit));
    await Promise.all(remove.map((name) => fs.unlink(path.join(BACKUP_DIR, name)).catch(() => {})));
  } catch {}
}

function writeStore(store, reason = 'write') {
  writeQueue = writeQueue.then(async () => {
    await ensureDataFile();
    await writeBackupSnapshot(store, reason);
    await pruneBackups();
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

function formatEmailMoney(amount) {
  return 'INR ' + Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function eventDateParts() {
  const parts = SERVER_EVENT.dateTime.split('·').map((part) => part.trim());
  return { eventDate: parts[0] || SERVER_EVENT.dateTime, doors: parts[1] || '' };
}

function buildQrImageUrl(text, size = 220) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rulesPlainText() {
  return [
    'DO:',
    '- Do scream every lyric like you personally wrote it.',
    "- Do arrive by doors-open. Sound checks don't wait for your fit pic.",
    '- Do hydrate — moshing dehydrates faster than your group chat drama.',
    '- Do make a new friend in the pit. Trauma bonding is a love language.',
    '',
    "DON'T:",
    '- Don\'t ask the bouncer for a "friends and family" rate. The bouncer is a kid.',
    "- Don't crowd-surf if leg day was sometime in 2019.",
    "- Don't film the entire set. You will never, ever watch it back.",
    "- Don't lose this QR. We will not be emotionally available about it.",
    '- Only rule is to not get caught.'
  ].join('\n');
}

function templateParamsForTicket(ticket) {
  const { eventDate, doors } = eventDateParts();
  const ticketIndex = ticket.ticketIndex || 1;
  const ticketTotal = ticket.ticketTotal || 1;
  const qrImage = buildQrImageUrl(ticket.id, 220);
  const recipientEmail = String(ticket.email || '').trim();
  return {
    to_email: recipientEmail,
    email: recipientEmail,
    user_email: recipientEmail,
    recipient_email: recipientEmail,
    reply_to: recipientEmail,
    to_name: ticket.name || '',
    name: ticket.name || '',
    event_name: SERVER_EVENT.name,
    event_datetime: SERVER_EVENT.dateTime,
    event_date: eventDate,
    event_doors: doors,
    venue_name: SERVER_EVENT.venueName,
    venue_link: SERVER_EVENT.venueMapLink,
    ticket_code: ticket.id,
    ticket_index: ticketIndex,
    ticket_total: ticketTotal,
    ticket_label: `${ticketIndex} of ${ticketTotal}`,
    ticket_price: formatEmailMoney(SERVER_EVENT.price),
    qr_image: qrImage,
    qr_url: qrImage,
    rules_text: rulesPlainText()
  };
}

async function renderEmailHtml(ticket) {
  const template = await fs.readFile(EMAIL_TEMPLATE_FILE, 'utf8');
  const params = templateParamsForTicket(ticket);
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => escapeHtml(params[key] || ''));
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function smtpCcRecipients() {
  return String(process.env.SMTP_CC || '42sannay@gmail.com')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

function getMailTransport() {
  if (mailTransport) return mailTransport;
  mailTransport = createMailTransport();
  return mailTransport;
}

function createMailTransport(overrides = {}) {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    family: Number(process.env.SMTP_FAMILY || 4),
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 15000),
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS || ''
    } : undefined,
    ...overrides
  });
}

function shouldRetryGmailSsl(error) {
  const host = String(process.env.SMTP_HOST || '').toLowerCase();
  const port = Number(process.env.SMTP_PORT || 587);
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  return host.includes('gmail') && port !== 465 && (
    message.includes('timeout') ||
    message.includes('enetunreach') ||
    message.includes('econnrefused') ||
    message.includes('etimedout')
  );
}

function summarizeEmailResult(result) {
  const safe = result && typeof result === 'object' ? result : { sent: false, error: 'Unknown email result' };
  return {
    sent: Boolean(safe.sent),
    skipped: Boolean(safe.skipped),
    provider: safe.provider || null,
    messageId: safe.messageId || null,
    reason: safe.reason || null,
    error: safe.error || null,
    networkBlocked: Boolean(safe.networkBlocked)
  };
}

function emailLogPrefixForTicketPrefix(ticketPrefix) {
  return ticketPrefix === 'test-ticket:' ? TEST_EMAIL_LOG_PREFIX : EMAIL_LOG_PREFIX;
}

function emailLogKey(prefix, ticketId) {
  return `${prefix}${new Date().toISOString()}:${ticketId}:${crypto.randomBytes(3).toString('hex')}`;
}

function parseStoreRecord(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function emailLogEntryFor(ticket, result, meta = {}) {
  return {
    at: new Date().toISOString(),
    ticketId: ticket.id,
    ticketCode: ticket.id,
    name: ticket.name || '',
    email: ticket.email || '',
    ticketIndex: ticket.ticketIndex || 1,
    ticketTotal: ticket.ticketTotal || 1,
    requestId: ticket.requestId || null,
    source: meta.source || 'manual',
    result: summarizeEmailResult(result)
  };
}

async function sendAndRecordTicketEmail(store, ticketPrefix, ticket, meta = {}) {
  let result;
  try {
    result = await sendTicketEmailWithNodemailer(ticket);
  } catch (error) {
    result = { sent: false, error: error && error.message ? error.message : String(error) };
  }
  const prefix = emailLogPrefixForTicketPrefix(ticketPrefix);
  const entry = emailLogEntryFor(ticket, result, meta);
  store[emailLogKey(prefix, ticket.id)] = JSON.stringify(entry);
  return { result, entry };
}

function hasSuccessfulEmailLog(store, ticketId, logPrefix) {
  return Object.entries(store).some(([key, value]) => {
    if (!key.startsWith(logPrefix)) return false;
    const entry = parseStoreRecord(value);
    return entry && entry.ticketId === ticketId && entry.result && entry.result.sent;
  });
}

async function sendTicketEmailWithNodemailer(ticket) {
  const recipientEmail = String(ticket.email || '').trim();
  if (!recipientEmail) {
    return { sent: false, error: 'This ticket has no email address on file.' };
  }
  if (!smtpConfigured()) {
    return {
      skipped: true,
      reason: 'Nodemailer is wired, but SMTP is not configured. Set SMTP_HOST and SMTP_FROM, plus SMTP_USER/SMTP_PASS if needed.'
    };
  }
  const html = await renderEmailHtml(ticket);
  const message = {
    from: process.env.SMTP_FROM,
    to: recipientEmail,
    cc: smtpCcRecipients(),
    subject: `Your ticket for ${SERVER_EVENT.name}`,
    html,
    text: [
      `Hi ${ticket.name || 'there'},`,
      '',
      `Here is your admission pass for ${SERVER_EVENT.name}.`,
      `${SERVER_EVENT.dateTime} · ${SERVER_EVENT.venueName}`,
      `Ticket code: ${ticket.id}`,
      '',
      rulesPlainText()
    ].join('\n')
  };
  let info;
  try {
    info = await getMailTransport().sendMail(message);
  } catch (error) {
    if (!shouldRetryGmailSsl(error)) throw error;
    const fallback = createMailTransport({ port: 465, secure: true, family: Number(process.env.SMTP_FAMILY || 4) });
    info = await fallback.sendMail(message);
  }
  return { sent: true, provider: 'nodemailer', messageId: info.messageId };
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

function isEmailLogKey(key) {
  return /^test-email-log:\d{4}-\d{2}-\d{2}T.*:[A-Z0-9]{20}:[a-z0-9]+$/.test(key)
    || /^email-log:\d{4}-\d{2}-\d{2}T.*:[A-Z0-9]{20}:[a-z0-9]+$/.test(key);
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

  if (url.pathname === '/api/admin/export-storage' && req.method === 'GET') {
    if (!isAdmin(req)) {
      sendError(res, 401, 'Admin session required');
      return;
    }
    const store = await readStore();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ticketed-storage-${new Date().toISOString().slice(0,10)}.json"`,
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ exportedAt: new Date().toISOString(), dataDir: DATA_DIR, store }, null, 2));
    return;
  }

  if (url.pathname === '/api/admin/backups' && req.method === 'GET') {
    if (!isAdmin(req)) {
      sendError(res, 401, 'Admin session required');
      return;
    }
    await ensureDataFile();
    const files = (await fs.readdir(BACKUP_DIR)).filter((name) => name.endsWith('.json')).sort().reverse();
    sendJson(res, 200, { dataDir: DATA_DIR, backupDir: BACKUP_DIR, files });
    return;
  }

  if (url.pathname === '/api/admin/send-ticket-email' && req.method === 'POST') {
    if (!isAdmin(req)) {
      sendError(res, 401, 'Admin session required');
      return;
    }
    const body = await readJsonBody(req);
    const ticketPrefix = body.ticketPrefix === 'test-ticket:' ? 'test-ticket:' : 'ticket:';
    const ticketId = String(body.ticketId || '').trim();
    if (!/^[A-Z0-9]{20}$/.test(ticketId)) {
      sendError(res, 400, 'Invalid ticket ID');
      return;
    }
    const store = await readStore();
    const value = store[ticketPrefix + ticketId];
    if (!value) {
      sendError(res, 404, 'Ticket not found');
      return;
    }
    let ticket;
    try { ticket = JSON.parse(value); } catch {
      sendError(res, 500, 'Ticket record is corrupted');
      return;
    }
    const { result, entry } = await sendAndRecordTicketEmail(store, ticketPrefix, ticket, { source: 'single-ticket' });
    await writeStore(store, url.pathname);
    sendJson(res, 200, { ...result, logEntry: entry });
    return;
  }

  if (url.pathname === '/api/admin/send-approved-emails' && req.method === 'POST') {
    if (!isAdmin(req)) {
      sendError(res, 401, 'Admin session required');
      return;
    }
    const body = await readJsonBody(req);
    const ticketPrefix = body.ticketPrefix === 'test-ticket:' ? 'test-ticket:' : 'ticket:';
    const onlyMissing = body.onlyMissing !== false;
    const store = await readStore();
    const logPrefix = emailLogPrefixForTicketPrefix(ticketPrefix);
    const tickets = Object.entries(store)
      .filter(([key]) => key.startsWith(ticketPrefix))
      .map(([, value]) => parseStoreRecord(value))
      .filter((ticket) => ticket && ticket.id && ticket.email)
      .filter((ticket) => !onlyMissing || !hasSuccessfulEmailLog(store, ticket.id, logPrefix));

    const attempts = [];
    for (const ticket of tickets) {
      const { result, entry } = await sendAndRecordTicketEmail(store, ticketPrefix, ticket, { source: onlyMissing ? 'approved-missing' : 'approved-resend' });
      attempts.push({ ticketId: ticket.id, email: ticket.email || '', result, logEntry: entry });
    }
    await writeStore(store, url.pathname);
    sendJson(res, 200, { attempted: attempts.length, onlyMissing, attempts });
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
    } else if (!isRequestKey(key) && !isTicketKey(key) && !isEmailLogKey(key)) {
      sendError(res, 400, 'Invalid storage key');
      return;
    }
    const store = await readStore();
    if (!admin && key in store) {
      sendError(res, 409, 'Submission already exists');
      return;
    }
    store[key] = valueToStore;
    await writeStore(store, url.pathname);
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
    await writeStore(store, url.pathname);
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
  console.log(`Ticketed data file: ${DATA_FILE}`);
  console.log(`Ticketed backup dir: ${BACKUP_DIR}`);
  if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PIN) {
    console.warn('WARNING: using default admin password 2026. Set ADMIN_PASSWORD before sharing the public URL.');
  }
  if (!smtpConfigured()) {
    console.warn('Email sending: Nodemailer enabled but SMTP is not configured. Set SMTP_HOST and SMTP_FROM to send real emails.');
  }
});
