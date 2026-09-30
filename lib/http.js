import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from './config.js';

export function parseUrl(req) {
  return new URL(req.url || '/', 'http://localhost');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || !!req.socket?.encrypted;
}

/**
 * Thêm 1 cookie vào response (không ghi đè cookie khác).
 * maxAge = null → cookie phiên (mất khi đóng trình duyệt).
 */
export function setCookie(req, res, name, value, { maxAge = null, httpOnly = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (maxAge !== null) c += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) c += '; HttpOnly';
  if (isHttps(req)) c += '; Secure';
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : [c]);
}

/** Đọc body: dùng helper req.body của Vercel nếu có, không thì tự đọc stream (chạy local). */
export async function readBody(req) {
  let b;
  try { b = req.body; } catch { return {}; }
  if (b !== undefined && b !== null) {
    if (typeof b === 'object' && !Buffer.isBuffer(b)) return b;
    return parseRaw(String(b), req.headers['content-type']);
  }
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > 1_000_000) break;
    chunks.push(ch);
  }
  return parseRaw(Buffer.concat(chunks).toString('utf8'), req.headers['content-type']);
}

function parseRaw(raw, type = '') {
  if (!raw) return {};
  if (String(type).includes('application/json')) {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  if (String(type).includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return {};
}

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.end(html);
}

export function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/** Gửi file (nén gzip nếu trình duyệt hỗ trợ — giữ dưới giới hạn 4.5 MB của Vercel). */
export function sendDownload(req, res, filename, contentType, text) {
  let body = Buffer.from(text, 'utf8');
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    body = zlib.gzipSync(body, { level: 6 });
    res.setHeader('Content-Encoding', 'gzip');
  }
  res.setHeader('Content-Length', body.length);
  res.end(body);
}

export function h(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function secret() {
  return config.sessionSecret || crypto.createHash('sha256').update('spr-admin:' + config.adminPassword).digest('hex');
}

export function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const dtf = () => new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function fmtLocal(d) {
  if (!d) return '';
  return dtf().format(new Date(d)).replace(',', '');
}

export function durationStr(from, to) {
  if (!from || !to) return '';
  const s = Math.round((new Date(to) - new Date(from)) / 1000);
  if (s < 0) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function toIso(d) {
  return d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '';
}
