import { q, q1 } from '../lib/db.js';
import { parseUrl, readBody, sendJson } from '../lib/http.js';
import {
  currentParticipant, participantState, assignParticipant, nextPosition, splitWords,
} from '../lib/experiment.js';

/** Chống CSRF: chỉ nhận POST dạng JSON có header X-SPR, cùng nguồn gốc. */
function postAllowed(req) {
  if (req.headers['x-spr'] !== '1') return false;
  if (!String(req.headers['content-type'] || '').includes('application/json')) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
      if (new URL(origin).host !== host) return false;
    } catch { return false; }
  }
  return true;
}

const reload = (id) => q1('SELECT * FROM participants WHERE id = $1', [id]);

export default async function handler(req, res) {
  try {
    const url = parseUrl(req);
    const action = url.searchParams.get('action') || '';
    const isPost = req.method === 'POST';
    let body = {};
    if (isPost) {
      if (!postAllowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      body = await readBody(req);
    }

    const p = await currentParticipant(req, res, { externalId: url.searchParams.get('ext') });
    await q('UPDATE participants SET last_seen_at = now() WHERE id = $1', [p.id]);

    switch (action) {
      case 'state': {
        const screen = url.searchParams.get('screen');
        if (screen) await q('UPDATE participants SET screen = $1 WHERE id = $2', [screen.slice(0, 40), p.id]);
        return sendJson(res, 200, await participantState(p));
      }

      case 'demographics': {
        if (!isPost) return sendJson(res, 405, { ok: false });
        if (p.demo_status !== null) return sendJson(res, 200, await participantState(p));
        const skip = !!body.skip;
        let age = null;
        if (!skip && body.age !== undefined && body.age !== '' && /^\d+$/.test(String(body.age))) {
          const a = Number(body.age);
          age = a >= 1 && a <= 120 ? a : null;
        }
        const clean = (k) => (skip ? null : (String(body[k] ?? '').trim().slice(0, 120) || null));
        const filled = !skip && (age !== null || clean('city') || clean('state') || clean('country'));
        await q('UPDATE participants SET demo_status = $1, age = $2, city = $3, state = $4, country = $5 WHERE id = $6',
          [filled ? 'filled' : 'skipped', age, clean('city'), clean('state'), clean('country'), p.id]);
        return sendJson(res, 200, await participantState(await reload(p.id)));
      }

      case 'start': {
        if (!isPost) return sendJson(res, 405, { ok: false });
        const input = body.input === 'touch' ? 'touch' : body.input === 'keyboard' ? 'keyboard' : null;
        if (input) await q('UPDATE participants SET input_mode = COALESCE(input_mode, $1) WHERE id = $2', [input, p.id]);
        if (p.status === 'new') {
          const device = input || (p.input_mode === 'touch' ? 'touch' : 'keyboard');
          const g = await assignParticipant(p.id, device);
          if (g === null) return sendJson(res, 200, { ok: true, status: 'full' });
        }
        return sendJson(res, 200, await participantState(await reload(p.id)));
      }

      case 'trial_start': {
        const pos = Number(body.position || 0);
        if (p.status === 'in_progress' && pos === await nextPosition(p.id)) {
          await q(`UPDATE trials SET attempts = attempts + 1, started_at = COALESCE(started_at, now())
                   WHERE participant_id = $1 AND position = $2 AND completed_at IS NULL`, [p.id, pos]);
        }
        return sendJson(res, 200, { ok: true });
      }

      case 'trial': {
        if (!isPost || p.status !== 'in_progress') {
          return sendJson(res, 409, { ok: false, error: 'not_in_progress' });
        }
        const pos = Number(body.position || 0);
        const next = await nextPosition(p.id);
        if (next === null || pos < next) return sendJson(res, 200, { ok: true, duplicate: true });
        if (pos !== next) return sendJson(res, 409, { ok: false, error: 'out_of_order' });

        const t = await q1('SELECT * FROM trials WHERE participant_id = $1 AND position = $2', [p.id, pos]);
        const words = splitWords(t.sentence);
        let rts = body.rts;
        if (!Array.isArray(rts) || rts.length !== words.length) {
          return sendJson(res, 422, { ok: false, error: 'bad_rts' });
        }
        rts = rts.map((v) => Math.max(0, Math.min(3_600_000, Math.round(Number(v) || 0))));

        let answer = null, isCorrect = null, answerRt = null;
        if (t.question !== null) {
          answer = String(body.answer || '').toLowerCase();
          if (answer !== 'yes' && answer !== 'no') return sendJson(res, 422, { ok: false, error: 'answer_required' });
          isCorrect = t.correct_answer !== null ? Number(answer === t.correct_answer) : null;
          answerRt = body.answer_rt != null ? Math.max(0, Math.round(Number(body.answer_rt) || 0)) : null;
        }
        const hidden = Math.max(0, Math.floor(Number(body.hidden) || 0));
        const upd = await q(`UPDATE trials SET rts = $1::jsonb, answer = $2, is_correct = $3, answer_rt = $4,
                               hidden_count = hidden_count + $5, attempts = GREATEST(attempts, 1),
                               started_at = COALESCE(started_at, now()), completed_at = now()
                             WHERE id = $6 AND completed_at IS NULL RETURNING id`,
        [JSON.stringify(rts), answer, isCorrect, answerRt, hidden, t.id]);
        if (!upd.length) return sendJson(res, 200, { ok: true, duplicate: true });

        const input = body.input === 'touch' ? 'touch' : body.input === 'keyboard' ? 'keyboard' : null;
        if (input && p.input_mode !== input && p.input_mode !== 'mixed') {
          // đổi thiết bị giữa chừng → đánh dấu "mixed"
          await q(`UPDATE participants SET input_mode = CASE WHEN input_mode IS NULL THEN $1 ELSE 'mixed' END WHERE id = $2`, [input, p.id]);
        }
        const finished = (await nextPosition(p.id)) === null;
        if (finished) {
          await q("UPDATE participants SET status = 'completed', completed_at = now() WHERE id = $1 AND status <> 'completed'", [p.id]);
        }
        return sendJson(res, 200, { ok: true, finished });
      }

      default:
        return sendJson(res, 400, { ok: false, error: 'unknown_action' });
    }
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { ok: false, error: 'server', message: String(e.message || e).slice(0, 200) });
  }
}
