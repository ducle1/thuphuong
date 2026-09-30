import crypto from 'node:crypto';
import { config } from './config.js';
import STIMULI_CSV from './stimuli.js';   // sinh từ stimuli.csv (npm run build)
import { q, q1, tx } from './db.js';
import { parseCookies, setCookie, randomHex } from './http.js';

/* ============================================================ Stimuli */

let stimuliCache = null;

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Đọc stimuli.csv. Cột: item_id, type, sentence, group, question, correct_answer
 * group để trống = câu filler (dùng chung A và B).
 */
export function loadStimuli() {
  if (stimuliCache) return stimuliCache;
  const rows = parseCsv(STIMULI_CSV);
  const header = rows.shift().map((x) => x.trim().toLowerCase());
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const typeOrder = new Map();
  const items = [];
  for (const raw of rows) {
    const r = {};
    header.forEach((k, i) => { r[k] = clean(raw[i]); });
    if (!r.sentence) continue;
    const type = r.type || 'Filler sentences';
    if (!typeOrder.has(type)) typeOrder.set(type, typeOrder.size + 1);
    const g = (r.group || '').toUpperCase();
    const ans = (r.correct_answer || '').toLowerCase();
    const n = items.length + 1;
    items.push({
      item_id: r.item_id || `I${n}`,
      type,
      type_order: typeOrder.get(type),
      item_order: n,
      sentence: r.sentence,
      group: g === 'A' || g === 'B' ? g : '',
      is_filler: g === 'A' || g === 'B' ? 0 : 1,
      question: r.question || null,
      correct_answer: ans === 'yes' || ans === 'no' ? ans : null,
    });
  }
  stimuliCache = items;
  return items;
}

export function splitWords(sentence) {
  return String(sentence).trim().split(/\s+/).filter(Boolean);
}

/* ====================================================== Randomization */

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function hasWord(sentence, word) {
  if (!word) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(sentence);
}

export function orderIsValid(items, word, maxRun) {
  let run = 0;
  for (const it of items) {
    run = hasWord(it.sentence, word) ? run + 1 : 0;
    if (run > maxRun) return false;
  }
  return true;
}

/**
 * Câu của nhóm + toàn bộ filler, xáo trộn; không quá maxRun câu chứa `word` liền nhau.
 * Lấy mẫu loại bỏ → mọi thứ tự hợp lệ có xác suất như nhau.
 */
export function buildOrder(group) {
  const pool = loadStimuli().filter((it) => it.is_filler === 1 || it.group === group);
  const word = config.maxConsecutiveWord;
  const maxRun = Math.max(1, config.maxConsecutive);
  const flag = pool.map((it) => hasWord(it.sentence, word));
  const idx = pool.map((_, i) => i);
  for (let t = 0; t < 50000; t++) {
    const perm = shuffle(idx);
    let run = 0, ok = true;
    for (const k of perm) {
      run = flag[k] ? run + 1 : 0;
      if (run > maxRun) { ok = false; break; }
    }
    if (ok) return perm.map((k) => pool[k]);
  }
  // Dự phòng: chèn các câu có `word` vào khe giữa các câu còn lại
  const withW = shuffle(pool.filter((_, i) => flag[i]));
  const without = shuffle(pool.filter((_, i) => !flag[i]));
  const slots = Array.from({ length: without.length + 1 }, () => []);
  for (const it of withW) {
    const free = slots.map((s, i) => (s.length < maxRun ? i : -1)).filter((i) => i >= 0);
    slots[free.length ? free[crypto.randomInt(free.length)] : 0].push(it);
  }
  const out = [];
  slots.forEach((s, i) => { out.push(...s); if (without[i]) out.push(without[i]); });
  return out;
}

/* ====================================================== Group balance */

export const DEVICES = ['keyboard', 'touch'];
export const normDevice = (d) => (d === 'touch' ? 'touch' : 'keyboard');

function countsSql(byDevice) {
  return `
  SELECT g.grp,
    COUNT(p.id) FILTER (WHERE p.status='completed'   AND p.excluded=0)::int AS completed,
    COUNT(p.id) FILTER (WHERE p.status='in_progress' AND p.excluded=0 AND p.last_seen_at >= now() - make_interval(mins => $1))::int AS active,
    COUNT(p.id) FILTER (WHERE p.status='in_progress' AND p.excluded=0 AND p.last_seen_at <  now() - make_interval(mins => $1))::int AS abandoned,
    COUNT(p.id) FILTER (WHERE p.excluded=1)::int AS excluded,
    COUNT(p.id)::int AS assigned
  FROM (VALUES ('A'), ('B')) AS g(grp)
  LEFT JOIN participants p ON p.grp = g.grp ${byDevice ? 'AND p.device = $2' : ''}
  GROUP BY g.grp`;
}

/**
 * completed / active / abandoned / excluded cho A và B (không tính người bị loại).
 * device = 'keyboard' | 'touch' → chỉ đếm người dùng thiết bị đó; null → tất cả.
 */
export async function groupCounts(client = null, device = null) {
  const sql = countsSql(!!device);
  const params = device ? [config.abandonMinutes, device] : [config.abandonMinutes];
  const rows = client ? (await client.query(sql, params)).rows : await q(sql, params);
  const out = {};
  for (const r of rows) out[r.grp] = r;
  return out;
}

/**
 * Chọn nhóm cho người tiếp theo dùng thiết bị `device`.
 * Cân bằng A/B RIÊNG cho từng loại thiết bị (máy tính / điện thoại):
 *  1) Trong cùng thiết bị: nhóm có (hoàn thành + đang làm) ít hơn.
 *  2) Bằng → trong cùng thiết bị: nhóm ít người hoàn thành hơn.
 *  3) Bằng → xét tổng mọi thiết bị theo 2 tiêu chí trên (giữ cả tổng A/B cân bằng).
 *  4) Vẫn bằng → xen kẽ: người lẻ A, người chẵn B.
 * null = cả 2 nhóm đã đủ targetPerGroup (tính trên tổng số người hoàn thành).
 */
export async function chooseGroup(client = null, device = 'keyboard') {
  const all = await groupCounts(client);
  const dev = await groupCounts(client, normDevice(device));
  const target = config.targetPerGroup;
  if (target > 0) {
    const fullA = all.A.completed >= target, fullB = all.B.completed >= target;
    if (fullA && fullB) return null;
    if (fullA) return 'B';
    if (fullB) return 'A';
  }
  for (const c of [dev, all]) {
    const effA = c.A.completed + c.A.active, effB = c.B.completed + c.B.active;
    if (effA !== effB) return effA < effB ? 'A' : 'B';
    if (c.A.completed !== c.B.completed) return c.A.completed < c.B.completed ? 'A' : 'B';
  }
  return (all.A.assigned + all.B.assigned) % 2 === 0 ? 'A' : 'B';
}

/**
 * Gán nhóm + tạo thứ tự câu. Chỉ 1 lần; đã có nhóm thì giữ nguyên.
 * Khoá advisory của Postgres đảm bảo 2 người vào cùng lúc không bị tính trùng.
 */
export async function assignParticipant(pid, device = 'keyboard') {
  device = normDevice(device);
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(7300002)');
    const cur = (await c.query('SELECT grp FROM participants WHERE id = $1 FOR UPDATE', [pid])).rows[0];
    if (!cur) throw new Error('participant not found');
    if (cur.grp) return cur.grp;
    const group = await chooseGroup(c, device);
    if (!group) return null;
    const order = buildOrder(group);
    const values = [];
    const params = [];
    order.forEach((it, i) => {
      const b = params.length;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`);
      params.push(pid, i + 1, it.item_id, it.type, it.type_order, it.item_order, it.is_filler, it.sentence, it.question, it.correct_answer);
    });
    await c.query(`INSERT INTO trials (participant_id, position, item_id, env_type, type_order, item_order, is_filler, sentence, question, correct_answer)
                   VALUES ${values.join(',')}`, params);
    await c.query(`UPDATE participants SET grp = $1, device = $3, status = 'in_progress', assigned_at = now(), last_seen_at = now(),
                     assign_seq = (SELECT COALESCE(MAX(assign_seq), 0) + 1 FROM participants)
                   WHERE id = $2`, [group, pid, device]);
    return group;
  });
}

/* ================================================= Participant identity */

const HEX32 = /^[a-f0-9]{32}$/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode() {
  let s = 'P';
  for (let i = 0; i < 7; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

/**
 * Nhận diện người tham gia bằng 2 lớp:
 *  - spr_sess : cookie phiên → bảng sessions trên server
 *  - spr_pid  : cookie lâu dài (1 năm)
 * Mất 1 trong 2 vẫn nhận ra, và cái còn thiếu được tạo lại.
 * Không có cả hai → tạo ID mới.
 */
export async function currentParticipant(req, res, { externalId = null } = {}) {
  const ck = parseCookies(req.headers.cookie);
  let p = null;
  let fromSession = false;
  const sid = HEX32.test(ck.spr_sess || '') ? ck.spr_sess : null;

  if (sid) {
    p = await q1('SELECT p.* FROM sessions s JOIN participants p ON p.id = s.participant_id WHERE s.id = $1', [sid]);
    fromSession = !!p;
  }
  if (!p && HEX32.test(ck.spr_pid || '')) {
    p = await q1('SELECT * FROM participants WHERE token = $1', [ck.spr_pid]);
  }
  if (!p) {
    const token = randomHex(16);
    const ua = String(req.headers['user-agent'] || '').slice(0, 400);
    for (let i = 0; i < 5 && !p; i++) {
      p = await q1(`INSERT INTO participants (code, token, status, external_id, user_agent)
                    VALUES ($1, $2, 'new', $3, $4) ON CONFLICT (code) DO NOTHING RETURNING *`,
      [newCode(), token, externalId ? String(externalId).slice(0, 120) : null, ua]);
    }
  }
  if (!fromSession) {
    const newSid = randomHex(16);
    await q('INSERT INTO sessions (id, participant_id) VALUES ($1, $2)', [newSid, p.id]);
    setCookie(req, res, 'spr_sess', newSid);             // cookie phiên
    if (Math.random() < 0.02) {
      q("DELETE FROM sessions WHERE created_at < now() - interval '14 days'").catch(() => {});
    }
  }
  if (ck.spr_pid !== p.token) {
    setCookie(req, res, 'spr_pid', p.token, { maxAge: 86400 * config.cookieDays });
  }
  return p;
}

/* ============================================================ State */

export async function nextPosition(pid) {
  const r = await q1('SELECT MIN(position) AS pos FROM trials WHERE participant_id = $1 AND completed_at IS NULL', [pid]);
  return r && r.pos !== null ? Number(r.pos) : null;
}

export async function participantState(p) {
  const total = (await q1('SELECT COUNT(*)::int AS n FROM trials WHERE participant_id = $1', [p.id])).n;
  const state = {
    ok: true,
    code: p.code,
    status: p.status,
    demo_done: p.demo_status !== null,
    total,
    done: 0,
    trials: [],
    display_mode: config.displayMode,
    require_keyboard: config.requireKeyboard,
    completion_url: config.completionUrl,
  };
  if (p.status === 'in_progress') {
    const rows = await q(`SELECT position, sentence, question, attempts FROM trials
                          WHERE participant_id = $1 AND completed_at IS NULL ORDER BY position`, [p.id]);
    state.trials = rows.map((t) => ({
      position: t.position,
      words: splitWords(t.sentence),
      question: t.question,
      resumed: t.attempts > 0,
    }));
    state.done = total - state.trials.length;
  } else if (p.status === 'completed') {
    state.done = total;
  }
  return state;
}
