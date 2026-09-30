import { config } from '../lib/config.js';
import { q, q1 } from '../lib/db.js';
import {
  parseUrl, parseCookies, setCookie, readBody, sendHtml, redirect, sendDownload,
  h, sign, safeEqual, fmtLocal, durationStr, toIso,
} from '../lib/http.js';
import { groupCounts, chooseGroup, splitWords } from '../lib/experiment.js';

const ADMIN_COOKIE = 'spr_admin';
const ADMIN_HOURS = 12;

/* ------------------------------------------------------------ auth */

function adminCookieValid(v) {
  if (!v || !config.adminPassword) return false;
  const [exp, sig] = String(v).split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, sign('admin:' + exp));
}

function csrfFor(cookieVal) {
  return sign('csrf:' + cookieVal).slice(0, 32);
}

/* ---------------------------------------------------------- handler */

export default async function handler(req, res) {
  try {
    const url = parseUrl(req);
    const ck = parseCookies(req.headers.cookie);

    if (!config.adminPassword) {
      return sendHtml(res, 500, layout('Chưa cấu hình', false, `<div class="login"><div class="panel"><h1>Chưa đặt mật khẩu</h1>
        <p>Thêm biến môi trường <code>ADMIN_PASSWORD</code> trong Vercel → Settings → Environment Variables, rồi Redeploy.</p></div></div>`));
    }

    // ----- đăng nhập
    if (!adminCookieValid(ck[ADMIN_COOKIE])) {
      let err = '';
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body.do === 'login' && body.password && safeEqual(body.password, config.adminPassword)) {
          const exp = Math.floor(Date.now() / 1000) + ADMIN_HOURS * 3600;
          setCookie(req, res, ADMIN_COOKIE, `${exp}.${sign('admin:' + exp)}`, { maxAge: ADMIN_HOURS * 3600 });
          return redirect(res, '/admin');
        }
        await new Promise((r) => setTimeout(r, 800));
        err = 'Sai mật khẩu.';
      }
      return sendHtml(res, err ? 401 : 200, layout('Đăng nhập', false, `
        <div class="login"><form method="post" action="/admin" class="panel">
          <h1>Quản trị thí nghiệm</h1>
          ${err ? `<p class="err">${h(err)}</p>` : ''}
          <input type="hidden" name="do" value="login">
          <label>Mật khẩu<input type="password" name="password" autofocus required></label>
          <button class="btn primary">Đăng nhập</button>
        </form></div>`));
    }

    const csrf = csrfFor(ck[ADMIN_COOKIE]);

    // ----- hành động
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.csrf || !safeEqual(body.csrf, csrf)) {
        return sendHtml(res, 403, 'CSRF token không hợp lệ. Tải lại trang.');
      }
      const id = Number(body.id || 0);
      if (body.do === 'logout') {
        setCookie(req, res, ADMIN_COOKIE, '', { maxAge: 0 });
        return redirect(res, '/admin');
      }
      if (body.do === 'exclude' || body.do === 'include') {
        await q('UPDATE participants SET excluded = $1 WHERE id = $2', [body.do === 'exclude' ? 1 : 0, id]);
        return redirect(res, `/admin?view=p&id=${id}`);
      }
      if (body.do === 'delete') {
        await q('DELETE FROM participants WHERE id = $1', [id]);   // trials + sessions xoá theo (CASCADE)
        return redirect(res, '/admin');
      }
      return redirect(res, '/admin');
    }

    // ----- export
    const exp = url.searchParams.get('export');
    if (exp) return exportCsv(req, res, exp);

    // ----- trang
    if (url.searchParams.get('view') === 'p') {
      return sendHtml(res, 200, await viewParticipant(Number(url.searchParams.get('id') || 0), csrf));
    }
    return sendHtml(res, 200, await viewHome(url, csrf));
  } catch (e) {
    console.error(e);
    return sendHtml(res, 500, layout('Lỗi', false, `<div class="panel"><h1>Lỗi máy chủ</h1><pre>${h(e.message || e)}</pre></div>`));
  }
}

/* ---------------------------------------------------------- layout */

function layout(title, loggedIn, content, csrf = '') {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${h(title)} · SPR Admin</title>
<link rel="stylesheet" href="/assets/admin.css?v=4">
</head>
<body>
${loggedIn ? `<header class="top">
  <a class="brand" href="/admin">SPR Admin</a>
  <nav>
    <a href="/admin">Tổng quan</a>
    <span class="dd">
      <a href="#" onclick="return false">Xuất CSV ▾</a>
      <span class="dd-menu">
        <a href="/admin?export=words">Theo từng từ (long format)</a>
        <a href="/admin?export=trials">Theo từng câu</a>
        <a href="/admin?export=participants">Theo người tham gia</a>
      </span>
    </span>
    <form method="post" action="/admin" class="inline">
      <input type="hidden" name="csrf" value="${h(csrf)}">
      <button name="do" value="logout" class="link">Đăng xuất</button>
    </form>
  </nav>
</header>` : ''}
<main class="wrap">
${content}
</main>
</body>
</html>`;
}

function statusInfo(p) {
  if (p.status === 'completed') return ['Hoàn thành', 'ok'];
  if (p.status === 'in_progress') {
    const active = new Date(p.last_seen_at) >= new Date(Date.now() - config.abandonMinutes * 60000);
    return active ? ['Đang làm', 'live'] : ['Bỏ dở', 'warn'];
  }
  return ['Chưa bắt đầu', 'mute'];
}

const pctClass = (pct) => (pct === null ? 'mute' : pct >= 80 ? 'ok' : pct >= 60 ? 'warn' : 'bad');
const pctOf = (a) => (a.answered > 0 ? Math.round((1000 * a.correct) / a.answered) / 10 : null);
const fmtN = (n) => Math.round(n).toLocaleString('en-US');
const badge = (g, lg = false) => (g ? `<span class="badge g${h(g)}${lg ? ' lg' : ''}">${lg ? 'Nhóm ' : ''}${h(g)}</span>` : '—');

const ACC_JOIN = `
  LEFT JOIN (
    SELECT participant_id,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS done,
      COUNT(*) FILTER (WHERE question IS NOT NULL AND answer IS NOT NULL)::int AS answered,
      COUNT(*) FILTER (WHERE is_correct = 1)::int AS correct,
      COUNT(*) FILTER (WHERE question IS NOT NULL)::int AS total_q
    FROM trials GROUP BY participant_id
  ) a ON a.participant_id = p.id`;

/* ------------------------------------------------------------- home */

async function viewHome(url, csrf) {
  const c = await groupCounts();
  const next = await chooseGroup();
  const target = config.targetPerGroup;
  const diff = Math.abs(c.A.completed - c.B.completed);
  const newCount = (await q1("SELECT COUNT(*)::int AS n FROM participants WHERE status = 'new'")).n;

  const fg = ['A', 'B'].includes(url.searchParams.get('g')) ? url.searchParams.get('g') : '';
  let fs = url.searchParams.get('s') || '';
  const where = [];
  const args = [];
  const cutoff = () => { args.push(config.abandonMinutes); return `now() - make_interval(mins => $${args.length})`; };
  if (fg) { args.push(fg); where.push(`p.grp = $${args.length}`); }
  switch (fs) {
    case 'completed': where.push("p.status = 'completed' AND p.excluded = 0"); break;
    case 'active': where.push(`p.status = 'in_progress' AND p.last_seen_at >= ${cutoff()}`); break;
    case 'abandoned': where.push(`p.status = 'in_progress' AND p.last_seen_at < ${cutoff()}`); break;
    case 'new': where.push("p.status = 'new'"); break;
    case 'excluded': where.push('p.excluded = 1'); break;
    default: fs = '';
  }
  const rows = await q(`SELECT p.*, COALESCE(a.total,0) AS total, COALESCE(a.done,0) AS done,
      COALESCE(a.answered,0) AS answered, COALESCE(a.correct,0) AS correct
    FROM participants p ${ACC_JOIN}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 1000`, args);

  const card = (g) => {
    const x = c[g];
    return `<div class="panel grp grp-${g}">
      <div class="grp-head"><span class="badge g${g}">Nhóm ${g}</span></div>
      <div class="big">${x.completed}${target ? `<small> / ${target}</small>` : ''}</div>
      <div class="lbl">người hoàn thành</div>
      <div class="sub">Đang làm: <b>${x.active}</b> · Bỏ dở: <b>${x.abandoned}</b> · Đã loại: <b>${x.excluded}</b></div>
    </div>`;
  };

  const opt = (v, label, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${label}</option>`;
  const trs = rows.map((p) => {
    const [sl, sc] = statusInfo(p);
    const pct = pctOf(p);
    return `<tr onclick="location.href='/admin?view=p&id=${p.id}'">
      <td><a href="/admin?view=p&id=${p.id}" class="mono">${h(p.code)}</a>${p.external_id ? `<div class="tiny">${h(p.external_id)}</div>` : ''}</td>
      <td>${badge(p.grp)}</td>
      <td><span class="st ${sc}">${sl}</span>${p.excluded ? ' <span class="st bad">Đã loại</span>' : ''}</td>
      <td class="r">${p.total ? `${p.done}/${p.total}` : '—'}</td>
      <td class="r"><span class="pct ${pctClass(pct)}">${pct === null ? '—' : pct + '%'}</span>${p.answered ? `<div class="tiny">${p.correct}/${p.answered}</div>` : ''}</td>
      <td class="r">${h(p.age ?? '')}</td>
      <td>${h(p.city ?? '')}</td>
      <td>${h(p.state ?? '')}</td>
      <td>${h(p.country ?? '')}${p.demo_status === 'skipped' ? '<span class="tiny">(bỏ qua)</span>' : ''}</td>
      <td class="nowrap">${h(fmtLocal(p.assigned_at || p.created_at))}</td>
      <td class="r">${h(durationStr(p.assigned_at, p.completed_at))}</td>
    </tr>`;
  }).join('');

  return layout('Tổng quan', true, `
    <h1>Tổng quan</h1>
    <section class="balance">
      ${card('A')}${card('B')}
      <div class="panel">
        <div class="lbl">Chênh lệch hoàn thành A–B</div>
        <div class="big ${diff <= 1 ? 'ok-t' : 'warn-t'}">${diff}</div>
        <div class="sub">Người tiếp theo sẽ vào: <b>${next ? 'Nhóm ' + next : 'đã đủ người'}</b></div>
        <div class="sub">Mới vào, chưa bắt đầu: <b>${newCount}</b></div>
      </div>
    </section>
    <p class="note">Cân bằng nhóm: người mới được đưa vào nhóm có (hoàn thành + đang làm) ít hơn. Người im lặng quá ${config.abandonMinutes} phút bị coi là bỏ dở và nhường chỗ; người bị <em>loại</em> không được tính.</p>

    ${await typeSummary()}

    <h2>Người tham gia</h2>
    <form class="filters" method="get" action="/admin">
      <select name="g" onchange="this.form.submit()">
        ${opt('', 'Tất cả nhóm', fg)}${opt('A', 'Nhóm A', fg)}${opt('B', 'Nhóm B', fg)}
      </select>
      <select name="s" onchange="this.form.submit()">
        ${opt('', 'Tất cả trạng thái', fs)}${opt('completed', 'Hoàn thành', fs)}${opt('active', 'Đang làm', fs)}${opt('abandoned', 'Bỏ dở', fs)}${opt('new', 'Chưa bắt đầu', fs)}${opt('excluded', 'Đã loại', fs)}
      </select>
      <span class="count">${rows.length} người</span>
    </form>
    <div class="table-wrap">
    <table class="list">
      <thead><tr>
        <th>ID</th><th>Nhóm</th><th>Trạng thái</th><th class="r">Tiến độ</th><th class="r">% đúng</th>
        <th class="r">Tuổi</th><th>Thành phố</th><th>Bang</th><th>Quốc gia</th><th>Bắt đầu</th><th class="r">Thời gian</th>
      </tr></thead>
      <tbody>${trs || '<tr><td colspan="11" class="empty">Chưa có dữ liệu.</td></tr>'}</tbody>
    </table>
    </div>`, csrf);
}

async function typeSummary() {
  const rows = await q(`SELECT t.env_type, t.type_order, p.grp, t.rts
    FROM trials t JOIN participants p ON p.id = t.participant_id
    WHERE p.status = 'completed' AND p.excluded = 0 AND t.rts IS NOT NULL`);
  if (!rows.length) return '';
  const agg = new Map();
  for (const r of rows) {
    const rts = r.rts || [];
    if (!agg.has(r.env_type)) agg.set(r.env_type, { order: r.type_order, A: { sum: 0, n: 0, s: 0 }, B: { sum: 0, n: 0, s: 0 } });
    const a = agg.get(r.env_type)[r.grp];
    a.sum += rts.reduce((x, y) => x + y, 0); a.n += rts.length; a.s += 1;
  }
  const list = [...agg.entries()].sort((x, y) => x[1].order - y[1].order);
  return `<h2>Tổng hợp theo Types of environment</h2>
    <div class="table-wrap"><table class="list compact">
      <thead><tr><th>Types of environment</th><th class="r">Nhóm A · ms/từ</th><th class="r">Số câu</th><th class="r">Nhóm B · ms/từ</th><th class="r">Số câu</th></tr></thead>
      <tbody>${list.map(([type, a]) => `<tr class="static"><td>${h(type)}</td>
        ${['A', 'B'].map((g) => `<td class="r mono">${a[g].n ? fmtN(a[g].sum / a[g].n) : '—'}</td><td class="r muted">${a[g].s}</td>`).join('')}
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="note">Trung bình thời gian đọc mỗi từ, chỉ tính người đã hoàn thành và chưa bị loại.</p>`;
}

/* ------------------------------------------------------ participant */

async function viewParticipant(id, csrf) {
  const p = await q1('SELECT * FROM participants WHERE id = $1', [id]);
  if (!p) return layout('Không tìm thấy', true, '<p>Không tìm thấy người tham gia. <a href="/admin">Quay lại</a></p>', csrf);
  const trials = await q('SELECT * FROM trials WHERE participant_id = $1 ORDER BY type_order, item_order', [id]);
  const acc = await q1(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS done,
      COUNT(*) FILTER (WHERE question IS NOT NULL AND answer IS NOT NULL)::int AS answered,
      COUNT(*) FILTER (WHERE is_correct = 1)::int AS correct,
      COUNT(*) FILTER (WHERE question IS NOT NULL)::int AS total_q
    FROM trials WHERE participant_id = $1`, [id]);
  const pct = pctOf(acc);
  const [sl, sc] = statusInfo(p);

  const all = [];
  let restarts = 0, hidden = 0;
  for (const t of trials) {
    t.rt_arr = t.rts || [];
    t.words = splitWords(t.sentence);
    all.push(...t.rt_arr);
    if (t.attempts > 1) restarts++;
    hidden += t.hidden_count;
  }
  all.sort((a, b) => a - b);
  const qt = (f) => (all.length ? all[Math.floor(f * (all.length - 1))] : 0);
  const lo = qt(0.1), hi = Math.max(lo + 1, qt(0.9)), median = qt(0.5);
  const mean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;

  const byType = new Map();
  for (const t of trials) {
    if (!byType.has(t.env_type)) byType.set(t.env_type, []);
    byType.get(t.env_type).push(t);
  }

  const sections = [...byType.entries()].map(([type, list]) => {
    let sum = 0, n = 0;
    list.forEach((t) => { sum += t.rt_arr.reduce((a, b) => a + b, 0); n += t.rt_arr.length; });
    const rowsHtml = list.map((t) => {
      const done = t.completed_at !== null;
      const words = t.words.map((w, i) => {
        const rt = t.rt_arr[i];
        const crit = /^(totally|definitely)\b/i.test(w);
        const alpha = rt == null ? 0 : Math.max(0, Math.min(1, (rt - lo) / (hi - lo)));
        const bg = rt == null ? '' : ` style="background:rgba(214,120,40,${(0.06 + 0.5 * alpha).toFixed(2)})"`;
        return `<span class="wd${crit ? ' crit' : ''}"${bg}><span class="t">${h(w)}</span><span class="ms">${rt == null ? '·' : rt}</span></span>`;
      }).join('');
      const tot = t.rt_arr.reduce((a, b) => a + b, 0);
      const flags = [];
      if (t.attempts > 1) flags.push(`<span class="flag">Đọc lại ${t.attempts - 1} lần (thoát giữa chừng)</span>`);
      if (t.hidden_count > 0) flags.push(`<span class="flag">Rời tab ${t.hidden_count} lần</span>`);
      if (!done) flags.push('<span class="flag mute">Chưa đọc</span>');
      const qCell = t.question
        ? `<div>${h(t.question)}</div><div class="tiny">Đáp án đúng: <b>${h(cap(t.correct_answer))}</b>${t.answer
          ? ` · Trả lời: <b>${h(cap(t.answer))}</b> <span class="mark ${t.is_correct ? 'ok' : 'bad'}">${t.is_correct ? '✓' : '✗'}</span>${t.answer_rt != null ? ' · ' + fmtN(t.answer_rt) + ' ms' : ''}`
          : ''}</div>`
        : '<span class="muted">—</span>';
      return `<tr class="${done ? '' : 'pending'}">
        <td class="r mono muted">${t.position}</td>
        <td class="mono tiny nowrap">${h(t.item_id)}</td>
        <td><div class="words">${words}</div>${flags.length ? `<div class="flags">${flags.join('')}</div>` : ''}</td>
        <td class="r mono">${t.rt_arr.length ? fmtN(tot) : ''}</td>
        <td class="r mono">${t.rt_arr.length ? fmtN(tot / t.rt_arr.length) : ''}</td>
        <td class="q">${qCell}</td>
      </tr>`;
    }).join('');
    return `<section class="type">
      <h2>${h(type)} <span class="muted">· ${list.length} câu${n ? ' · TB ' + fmtN(sum / n) + ' ms/từ' : ''}</span></h2>
      <div class="table-wrap"><table class="trials">
        <colgroup><col style="width:48px"><col style="width:74px"><col><col style="width:78px"><col style="width:70px"><col style="width:270px"></colgroup>
        <thead><tr><th class="r">#</th><th>Mã</th><th>Câu · ms từng từ</th><th class="r">Tổng</th><th class="r">TB/từ</th><th>Câu hỏi kiểm tra</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>
    </section>`;
  }).join('');

  return layout(p.code, true, `
    <p class="crumb"><a href="/admin">← Tổng quan</a></p>
    <div class="p-head">
      <div>
        <h1><span class="mono">${h(p.code)}</span> ${p.grp ? badge(p.grp, true) : ''} <span class="st ${sc}">${sl}</span>
          ${p.excluded ? '<span class="st bad">Đã loại khỏi phân tích</span>' : ''}</h1>
        <p class="meta">Tuổi: <b>${h(p.age ?? '—')}</b> · Thành phố: <b>${h(p.city ?? '—')}</b> · Bang: <b>${h(p.state ?? '—')}</b> · Quốc gia: <b>${h(p.country ?? '—')}</b>
          ${p.demo_status === 'skipped' ? ' <span class="tiny">(đã bỏ qua phần thông tin)</span>' : ''}</p>
        <p class="meta tiny">Vào lần đầu: ${h(fmtLocal(p.created_at))} · Bắt đầu: ${h(fmtLocal(p.assigned_at) || '—')} ·
          Hoàn thành: ${h(fmtLocal(p.completed_at) || '—')} · Thời gian làm: ${h(durationStr(p.assigned_at, p.completed_at) || '—')}
          ${p.external_id ? ` · External ID: <b>${h(p.external_id)}</b>` : ''}
          <br>Thiết bị: ${h(p.screen ?? '')} · ${h(String(p.user_agent || '').slice(0, 140))}</p>
      </div>
      <div class="p-actions">
        <form method="post" action="/admin" class="inline">
          <input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="id" value="${p.id}">
          ${p.excluded
    ? '<button class="btn" name="do" value="include">Khôi phục vào phân tích</button>'
    : '<button class="btn" name="do" value="exclude" title="Không tính vào cân bằng nhóm và bảng tổng hợp">Loại khỏi phân tích</button>'}
        </form>
        <form method="post" action="/admin" class="inline" onsubmit="return confirm('Xoá vĩnh viễn ${h(p.code)} và toàn bộ dữ liệu?')">
          <input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="id" value="${p.id}">
          <button class="btn danger" name="do" value="delete">Xoá</button>
        </form>
      </div>
    </div>

    <section class="stats">
      <div class="panel"><div class="lbl">% trả lời đúng câu kiểm tra</div>
        <div class="big ${pctClass(pct)}-t">${pct === null ? '—' : pct + '%'}</div>
        <div class="sub">${acc.correct} đúng / ${acc.answered} đã trả lời (tổng ${acc.total_q} câu hỏi)</div></div>
      <div class="panel"><div class="lbl">Tiến độ</div><div class="big">${acc.done}<small>/${acc.total}</small></div><div class="sub">câu đã đọc</div></div>
      <div class="panel"><div class="lbl">Thời gian đọc / từ</div><div class="big">${fmtN(mean)}<small> ms</small></div><div class="sub">trung vị ${fmtN(median)} ms</div></div>
      <div class="panel"><div class="lbl">Cảnh báo chất lượng</div><div class="big">${restarts + hidden}</div>
        <div class="sub">${restarts} câu phải đọc lại · ${hidden} lần rời tab</div></div>
    </section>

    <p class="legend">Các câu được sắp xếp theo <b>Types of environment</b> (thứ tự trong file Excel). Cột “#” là thứ tự người này thực sự được xem (ngẫu nhiên).
      Số dưới mỗi từ là mili giây từ lúc từ hiện ra đến lúc bấm Space. Màu càng đậm = đọc càng chậm (so với chính người này).</p>
    ${sections}
    ${trials.length ? '' : '<p class="muted">Người này chưa bắt đầu phần đọc nên chưa được chia nhóm.</p>'}`, csrf);
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

/* ---------------------------------------------------------- export */

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (arr) => arr.map(csvCell).join(',') + '\r\n';

async function exportCsv(req, res, kind) {
  const names = { words: 'spr_words', trials: 'spr_trials', participants: 'spr_participants' };
  if (!names[kind]) return sendHtml(res, 400, 'Loại export không hợp lệ');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1_');
  const filename = `${names[kind]}_${stamp}.csv`;
  const pcols = ['participant', 'group', 'status', 'excluded', 'age', 'city', 'state', 'country', 'external_id'];
  const pvals = (p) => [p.code, p.grp, p.status, p.excluded, p.age, p.city, p.state, p.country, p.external_id];
  let out = '﻿';

  if (kind === 'participants') {
    out += csvRow([...pcols, 'sentences_done', 'sentences_total', 'questions_answered', 'questions_correct', 'accuracy_pct',
      'mean_rt_per_word_ms', 'restarted_sentences', 'tab_leaves', 'created_at_utc', 'started_at_utc', 'completed_at_utc', 'duration_sec', 'screen', 'user_agent']);
    const ps = await q(`SELECT p.*, COALESCE(a.total,0) AS total, COALESCE(a.done,0) AS done, COALESCE(a.answered,0) AS answered,
        COALESCE(a.correct,0) AS correct FROM participants p ${ACC_JOIN} ORDER BY p.id`);
    const tr = await q('SELECT participant_id, rts, attempts, hidden_count FROM trials');
    const stat = new Map();
    for (const t of tr) {
      const s = stat.get(t.participant_id) || { sum: 0, n: 0, rs: 0, hd: 0 };
      const r = t.rts || [];
      s.sum += r.reduce((a, b) => a + b, 0); s.n += r.length;
      if (t.attempts > 1) s.rs++;
      s.hd += t.hidden_count;
      stat.set(t.participant_id, s);
    }
    for (const p of ps) {
      const s = stat.get(p.id) || { sum: 0, n: 0, rs: 0, hd: 0 };
      const dur = p.assigned_at && p.completed_at ? Math.round((new Date(p.completed_at) - new Date(p.assigned_at)) / 1000) : '';
      out += csvRow([...pvals(p), p.done, p.total, p.answered, p.correct, pctOf(p), s.n ? Math.round((10 * s.sum) / s.n) / 10 : '',
        s.rs, s.hd, toIso(p.created_at), toIso(p.assigned_at), toIso(p.completed_at), dur, p.screen, p.user_agent]);
    }
    return sendDownload(req, res, filename, 'text/csv; charset=utf-8', out);
  }

  const rows = await q(`SELECT t.*, p.code, p.grp, p.status, p.excluded, p.age, p.city, p.state, p.country, p.external_id
    FROM trials t JOIN participants p ON p.id = t.participant_id
    ORDER BY p.id, t.type_order, t.item_order`);
  const tcols = ['env_type', 'item_id', 'is_filler', 'presentation_order', 'sentence'];
  const qcols = ['question', 'correct_answer', 'answer', 'is_correct', 'answer_rt_ms', 'attempts', 'tab_leaves', 'completed_at_utc'];
  const tvals = (t) => [t.env_type, t.item_id, t.is_filler, t.position, t.sentence];
  const qvals = (t) => [t.question, t.correct_answer, t.answer, t.is_correct, t.answer_rt, t.attempts, t.hidden_count, toIso(t.completed_at)];

  if (kind === 'trials') {
    out += csvRow([...pcols, ...tcols, 'n_words', 'total_rt_ms', 'mean_rt_ms', 'word_rts_ms', ...qcols]);
    for (const t of rows) {
      const r = t.rts || [];
      const tot = r.reduce((a, b) => a + b, 0);
      out += csvRow([...pvals(t), ...tvals(t), splitWords(t.sentence).length, r.length ? tot : '',
        r.length ? Math.round((10 * tot) / r.length) / 10 : '', r.join(' '), ...qvals(t)]);
    }
    return sendDownload(req, res, filename, 'text/csv; charset=utf-8', out);
  }

  out += csvRow([...pcols, ...tcols, 'word_index', 'word', 'rt_ms', ...qcols]);
  for (const t of rows) {
    if (!t.rts) continue;
    splitWords(t.sentence).forEach((w, i) => {
      out += csvRow([...pvals(t), ...tvals(t), i + 1, w, t.rts[i] ?? '', ...qvals(t)]);
    });
  }
  return sendDownload(req, res, filename, 'text/csv; charset=utf-8', out);
}
