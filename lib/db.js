import pg from 'pg';
import { config } from './config.js';

let pool = null;
let schemaReady = null;

export function getPool() {
  if (!pool) {
    if (!config.databaseUrl) {
      const dbKeys = Object.keys(process.env).filter((k) => /DATABASE|POSTGRES|PG|NEON/i.test(k));
      throw new Error('Chưa cấu hình DATABASE_URL (thêm Neon Postgres trong Vercel → Storage, rồi Redeploy). '
        + `Môi trường ${process.env.VERCEL_ENV || 'local'} đang có các biến DB: ${dbKeys.join(', ') || '(không có)'}`);
    }
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', () => { /* kết nối rảnh bị đóng — pool tự tạo lại */ });
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS participants (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  token         TEXT NOT NULL UNIQUE,
  grp           TEXT,
  assign_seq    INT,
  status        TEXT NOT NULL DEFAULT 'new',
  excluded      SMALLINT NOT NULL DEFAULT 0,
  demo_status   TEXT,
  age           INT,
  city          TEXT,
  state         TEXT,
  country       TEXT,
  external_id   TEXT,
  user_agent    TEXT,
  screen        TEXT,
  input_mode    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at   TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_p_grp_status ON participants (grp, status);

CREATE TABLE IF NOT EXISTS trials (
  id              SERIAL PRIMARY KEY,
  participant_id  INT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  position        INT NOT NULL,
  item_id         TEXT NOT NULL,
  env_type        TEXT NOT NULL,
  type_order      INT NOT NULL,
  item_order      INT NOT NULL,
  is_filler       SMALLINT NOT NULL,
  sentence        TEXT NOT NULL,
  question        TEXT,
  correct_answer  TEXT,
  answer          TEXT,
  is_correct      SMALLINT,
  answer_rt       INT,
  rts             JSONB,
  attempts        INT NOT NULL DEFAULT 0,
  hidden_count    INT NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  UNIQUE (participant_id, position)
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  participant_id  INT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function initSchema() {
  const p = getPool();
  const { rows } = await p.query(`SELECT to_regclass('public.sessions') AS t,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'participants' AND column_name = 'input_mode') AS has_input`);
  if (rows[0].t && rows[0].has_input) return;
  // Khoá để nhiều function khởi động cùng lúc không tạo bảng chồng lên nhau
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(7300001)');
    await c.query(SCHEMA);
    // Nâng cấp bảng cũ (bản trước chưa có cột thiết bị)
    await c.query('ALTER TABLE participants ADD COLUMN IF NOT EXISTS input_mode TEXT');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export function ready() {
  if (!schemaReady) {
    schemaReady = initSchema().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

export async function q(text, params = []) {
  await ready();
  return (await getPool().query(text, params)).rows;
}

export async function q1(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

/** Chạy fn(client) trong 1 transaction. */
export async function tx(fn) {
  await ready();
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
