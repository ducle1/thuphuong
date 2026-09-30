/* Self-paced reading — participant client */
(() => {
  'use strict';

  const API = '/api/participant';
  // Mã người tham gia từ nền tảng tuyển (vd. Prolific) nếu có trong link
  const EXT_ID = (() => {
    const sp = new URLSearchParams(location.search);
    for (const k of ['PROLIFIC_PID', 'workerId', 'participant', 'pid']) if (sp.get(k)) return sp.get(k);
    return '';
  })();
  const GAP_MS = 400;           // khoảng trống giữa 2 câu
  const HINT_TRIALS = 3;        // hiện dòng nhắc "Press Space" ở vài câu đầu

  const US_STATES = ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','District of Columbia','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming','Puerto Rico','Guam','U.S. Virgin Islands','American Samoa','Northern Mariana Islands'];

  const COUNTRIES = ['Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina','Armenia','Australia','Austria','Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan','Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cabo Verde','Cambodia','Cameroon','Canada','Central African Republic','Chad','Chile','China','Colombia','Comoros','Congo','Costa Rica',"Côte d'Ivoire",'Croatia','Cuba','Cyprus','Czechia','Democratic Republic of the Congo','Denmark','Djibouti','Dominica','Dominican Republic','Ecuador','Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Fiji','Finland','France','Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea','Guinea-Bissau','Guyana','Haiti','Honduras','Hong Kong','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo','Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg','Macau','Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania','Mauritius','Mexico','Micronesia','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nauru','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia','Norway','Oman','Pakistan','Palau','Palestine','Panama','Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal','Qatar','Romania','Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines','Samoa','San Marino','Sao Tome and Principe','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia','Slovenia','Solomon Islands','Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan','Suriname','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo','Tonga','Trinidad and Tobago','Tunisia','Turkey','Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan','Vanuatu','Vatican City','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe'];

  const $ = (sel) => document.querySelector(sel);

  let S = null;            // state từ server
  let queue = [];          // các câu còn lại
  let mode = 'loading';
  let cur = null;          // câu đang làm
  let away = false;

  /* ---------------------------------------------------------- helpers */

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }

  function eventTime(e) {
    const now = performance.now();
    const ts = e && e.timeStamp;
    return (ts > 0 && ts <= now + 5 && now - ts < 2000) ? ts : now;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(action, body) {
    const isPost = body !== undefined;
    let url = API + '?action=' + encodeURIComponent(action);
    if (EXT_ID) url += '&ext=' + encodeURIComponent(EXT_ID);
    if (!isPost) url += '&screen=' + encodeURIComponent(screen.width + 'x' + screen.height) + '&t=' + Date.now();
    const res = await fetch(url, isPost ? {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-SPR': '1' },
      body: JSON.stringify(body),
    } : { credentials: 'same-origin', cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch (_) { /* ignore */ }
    return { status: res.status, data: data || {} };
  }

  function updateProgress() {
    if (!S || !S.total) return;
    $('#progress').hidden = false;
    $('#progress-bar').style.width = (100 * S.done / S.total).toFixed(1) + '%';
  }

  function isTouchOnly() {
    const fine = window.matchMedia && window.matchMedia('(any-pointer: fine)').matches;
    const touch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    return touch && !fine;
  }

  // Điện thoại / máy tính bảng không có bàn phím → chạm màn hình thay cho phím Space
  const TOUCH = isTouchOnly();
  const INPUT = TOUCH ? 'touch' : 'keyboard';
  const ANSWER_LOCK_MS = 400;   // chống cú chạm cuối câu "rơi" nhầm vào nút Yes/No
  document.body.classList.toggle('touch', TOUCH);

  /* ------------------------------------------------------------ flow */

  async function load() {
    mode = 'loading';
    show('s-loading');
    const r = await api('state');
    if (!r.data.ok) return fatal('Could not load the study. Please reload the page.');
    S = r.data;
    route();
  }

  function route() {
    if (S.display_mode === 'center') {
      document.querySelector('.steps li').innerHTML =
        'Words appear one at a time in the centre of the screen. Every time you press the <kbd>Space</kbd> bar, the next word replaces the previous one.';
      $('.demo-line').hidden = true;
    }
    if (S.status === 'completed') return showDone();
    if (S.status === 'full') { mode = 'full'; return show('s-full'); }
    if (S.status === 'in_progress') {
      queue = S.trials.slice();
      updateProgress();
      if (!queue.length) return load();
      if (S.done > 0 || queue[0].resumed) return showResume();
      return showInstructions();
    }
    if (!S.demo_done) return showWelcome();
    return showInstructions();
  }

  function showWelcome() {
    mode = 'welcome';
    const blocked = S.require_keyboard === true && TOUCH;
    $('#kbd-warning').hidden = !blocked;
    $('#btn-welcome').disabled = blocked;
    show('s-welcome');
  }

  function showDemo() {
    mode = 'demo';
    show('s-demo');
  }

  function showInstructions() {
    mode = 'instructions';
    show('s-instructions');
  }

  function showResume() {
    mode = 'resume';
    $('#resume-pos').textContent = 'sentence ' + (S.done + 1) + ' of ' + S.total;
    show('s-resume');
  }

  async function startExperiment() {
    mode = 'starting';
    let r = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        r = await api('start', { input: INPUT });
        if (r.status < 500) break;
      } catch (_) { r = null; }
      await sleep(500 * (attempt + 1));
    }
    if (r && r.data.status === 'full') { mode = 'full'; return show('s-full'); }
    if (!r || !r.data.ok) return fatal('Could not start the study. Please reload the page.');
    S = r.data;
    queue = S.trials.slice();
    updateProgress();
    if (S.status === 'completed') return showDone();
    nextTrial();
  }

  function nextTrial() {
    if (!queue.length) return finish();
    const t = queue[0];
    cur = { trial: t, idx: -1, rts: new Array(t.words.length).fill(null), hidden: 0, onset: 0, qOnset: 0, answer: null, answerRt: null };
    renderMask(t.words);
    $('#trial-hint').style.visibility = S.done < HINT_TRIALS ? 'visible' : 'hidden';
    show('s-trial');
    mode = 'mask';
  }

  /* --------------------------------------------------------- reading */

  let spans = [];

  function renderMask(words) {
    const el = $('#sentence');
    el.innerHTML = '';
    spans = [];
    if (S.display_mode === 'center') {
      el.className = 'sentence center-mode';
      el.textContent = '+';
      return;
    }
    el.className = 'sentence';
    words.forEach((w, i) => {
      const sp = document.createElement('span');
      sp.className = 'w masked';
      sp.textContent = w;
      el.appendChild(sp);
      spans.push(sp);
      if (i < words.length - 1) el.appendChild(document.createTextNode(' '));
    });
  }

  function reveal(i) {
    if (S.display_mode === 'center') {
      $('#sentence').textContent = cur.trial.words[i];
    } else {
      if (i > 0) spans[i - 1].classList.add('masked');
      spans[i].classList.remove('masked');
    }
    cur.onset = performance.now();
  }

  function onSpace(t) {
    if (mode === 'mask') {
      mode = 'reading';
      cur.idx = 0;
      reveal(0);
      // báo server câu này bắt đầu (đếm số lần làm lại nếu thoát giữa chừng)
      api('trial_start', { position: cur.trial.position }).catch(() => {});
      return;
    }
    if (mode === 'reading') {
      cur.rts[cur.idx] = Math.max(0, t - cur.onset);
      cur.idx++;
      if (cur.idx < cur.trial.words.length) {
        reveal(cur.idx);
      } else {
        endReading();
      }
    }
  }

  function endReading() {
    $('#sentence').innerHTML = '';
    if (cur.trial.question) {
      mode = 'question';
      $('#q-text').textContent = cur.trial.question;
      const qs = $('#s-question');
      qs.classList.add('locked');
      setTimeout(() => qs.classList.remove('locked'), ANSWER_LOCK_MS);
      show('s-question');
      cur.qOnset = performance.now();
    } else {
      save();
    }
  }

  function answer(ans, t, viaPointer = false) {
    if (mode !== 'question') return;
    if (viaPointer && t - cur.qOnset < ANSWER_LOCK_MS) return;
    cur.answer = ans;
    cur.answerRt = Math.max(0, t - cur.qOnset);
    show('s-trial');
    save();
  }

  /* ------------------------------------------------------------ save */

  async function save() {
    mode = 'saving';
    const started = performance.now();
    const payload = {
      position: cur.trial.position,
      rts: cur.rts.map((v) => Math.round(v)),
      answer: cur.answer,
      answer_rt: cur.answerRt === null ? null : Math.round(cur.answerRt),
      hidden: cur.hidden,
      input: INPUT,
    };
    let r = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        r = await api('trial', payload);
        if (r.status < 500) break;
      } catch (_) { r = null; }
      await sleep(600 * (attempt + 1));
    }
    if (!r) {
      mode = 'error';
      $('#err-msg').textContent = 'Your last response could not be saved. Please check your internet connection.';
      return show('s-error');
    }
    if (r.status === 409) {        // lệch trạng thái (vd. mở 2 tab) → đồng bộ lại
      return load();
    }
    if (!r.data.ok) {
      mode = 'error';
      $('#err-msg').textContent = 'Something went wrong while saving (' + (r.data.error || r.status) + ').';
      return show('s-error');
    }
    queue.shift();
    S.done = Math.min(S.total, S.done + 1);
    updateProgress();
    if (r.data.finished || !queue.length) return finish();
    mode = 'gap';
    const wait = Math.max(0, GAP_MS - (performance.now() - started));
    setTimeout(nextTrial, wait);
  }

  async function finish() {
    mode = 'done';
    const r = await api('state');
    if (r.data.ok) S = r.data;
    showDone();
  }

  function showDone() {
    mode = 'done';
    $('#progress').hidden = true;
    $('#done-code').textContent = S.code;
    if (S.completion_url) {
      $('#done-link').href = S.completion_url;
      $('#done-actions').hidden = false;
    }
    show('s-done');
  }

  function fatal(msg) {
    mode = 'error';
    $('#err-msg').textContent = msg;
    show('s-error');
  }

  /* ---------------------------------------------------------- events */

  window.addEventListener('keydown', (e) => {
    const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';

    if (mode === 'question') {
      if (isSpace || e.key === 'Enter') { e.preventDefault(); return; }
      if (e.repeat) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'y' || k === 'n') { e.preventDefault(); answer(k === 'y' ? 'yes' : 'no', eventTime(e)); }
      return;
    }
    if (!isSpace) return;
    if (['instructions', 'resume', 'mask', 'reading', 'gap', 'saving', 'starting'].includes(mode)) e.preventDefault();
    if (e.repeat) return;              // giữ phím không tính
    const t = eventTime(e);

    if (mode === 'instructions') return startExperiment();
    if (mode === 'resume') return nextTrial();
    if (mode === 'mask' || mode === 'reading') return onSpace(t);
  }, true);

  document.querySelectorAll('.btn.answer').forEach((b) => {
    b.addEventListener('click', (e) => answer(b.dataset.answer, eventTime(e), true));
  });

  // Cảm ứng: chạm bất kỳ đâu trên màn hình đọc = bấm Space (pointerdown: phản hồi ngay, không trễ 300 ms)
  $('#s-trial').addEventListener('pointerdown', (e) => {
    if (!TOUCH || !e.isPrimary) return;
    if (mode !== 'mask' && mode !== 'reading') return;
    e.preventDefault();
    onSpace(eventTime(e));
  });
  $('#btn-begin').addEventListener('click', () => { if (mode === 'instructions') startExperiment(); });
  $('#btn-resume').addEventListener('click', () => { if (mode === 'resume') nextTrial(); });

  function markAway() {
    if (!away && cur && ['mask', 'reading', 'question'].includes(mode)) cur.hidden++;
    away = true;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) markAway(); else away = false; });
  window.addEventListener('blur', markAway);
  window.addEventListener('focus', () => { away = false; });

  window.addEventListener('beforeunload', (e) => {
    if (['mask', 'reading', 'question', 'saving', 'gap'].includes(mode)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  $('#btn-welcome').addEventListener('click', () => { if (!S.demo_done) showDemo(); else showInstructions(); });

  $('#btn-retry').addEventListener('click', () => {
    if (cur && S && S.status === 'in_progress' && queue.length && cur.trial === queue[0] && cur.idx >= cur.trial.words.length) {
      show('s-trial');
      save();
    } else {
      load();
    }
  });

  /* ---------------------------------------------------- demographics */

  const countrySel = $('#f-country');
  const stateSel = $('#f-state-select');
  const stateTxt = $('#f-state-text');
  countrySel.innerHTML = '<option value="">— Select —</option>' +
    COUNTRIES.map((c) => `<option${c === 'United States' ? ' selected' : ''}>${c}</option>`).join('');
  stateSel.innerHTML = '<option value="">— Select —</option>' + US_STATES.map((s) => `<option>${s}</option>`).join('');

  function syncState() {
    const us = countrySel.value === 'United States';
    stateSel.hidden = !us;
    stateTxt.hidden = us;
    $('#state-label').textContent = us ? 'State' : 'State / province / region';
  }
  countrySel.addEventListener('change', syncState);
  syncState();

  async function submitDemo(skip) {
    const f = $('#demo-form');
    const btns = f.querySelectorAll('button');
    btns.forEach((b) => { b.disabled = true; });
    const us = countrySel.value === 'United States';
    const body = skip ? { skip: true } : {
      age: f.age.value.trim(),
      country: countrySel.value,
      state: us ? stateSel.value : stateTxt.value.trim(),
      city: f.city.value.trim(),
    };
    if (!skip && body.age !== '' && (!/^\d+$/.test(body.age) || +body.age < 1 || +body.age > 120)) {
      btns.forEach((b) => { b.disabled = false; });
      f.age.focus();
      f.age.setCustomValidity('Please enter a valid age, or leave it empty.');
      f.age.reportValidity();
      return;
    }
    const r = await api('demographics', body);
    btns.forEach((b) => { b.disabled = false; });
    if (!r.data.ok) return fatal('Could not save your answers. Please reload the page.');
    S = r.data;
    showInstructions();
  }
  $('#demo-form').addEventListener('submit', (e) => { e.preventDefault(); submitDemo(false); });
  $('#demo-form').age.addEventListener('input', (e) => e.target.setCustomValidity(''));
  $('#btn-skip').addEventListener('click', () => submitDemo(true));

  load().catch(() => fatal('Could not load the study. Please check your connection and reload the page.'));
})();
