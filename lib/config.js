/**
 * CẤU HÌNH
 * Mỗi mục có thể sửa mặc định ngay tại đây, hoặc đặt biến môi trường cùng tên
 * trong Vercel → Project → Settings → Environment Variables (rồi Redeploy).
 */
const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
// Tìm chuỗi kết nối Postgres: DATABASE_URL, POSTGRES_URL, hoặc có tiền tố tuỳ chọn
// khi kết nối Neon (vd. STORAGE_DATABASE_URL, thuphuong_POSTGRES_URL...)
function findDbUrl() {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.POSTGRES_URL) return env.POSTGRES_URL;
  const keys = Object.keys(env).filter((k) => /(^|_)(DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL)$/i.test(k) && !/UNPOOLED|NON_POOLING/i.test(k) && env[k]);
  return keys.length ? env[keys[0]] : '';
}
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export const config = {
  // BẮT BUỘC: mật khẩu trang /admin (đặt trong Environment Variables, không ghi vào code)
  adminPassword: env.ADMIN_PASSWORD || '',

  // Tuỳ chọn: chuỗi bí mật để ký cookie admin (mặc định sinh từ ADMIN_PASSWORD)
  sessionSecret: env.SESSION_SECRET || '',

  // Chuỗi kết nối Postgres — Neon trên Vercel tự thêm DATABASE_URL
  databaseUrl: findDbUrl(),

  // Múi giờ hiển thị trong trang admin
  timezone: env.TIMEZONE || 'Asia/Ho_Chi_Minh',

  // Không để quá N câu chứa từ này đứng liền nhau khi xáo trộn
  maxConsecutiveWord: env.MAX_CONSECUTIVE_WORD || 'totally',
  maxConsecutive: num(env.MAX_CONSECUTIVE, 2),

  // 'moving_window' (mặc định) hoặc 'center'
  displayMode: env.DISPLAY_MODE || 'moving_window',

  // Không hoạt động quá N phút → coi là bỏ dở (nhường chỗ khi cân bằng nhóm)
  abandonMinutes: num(env.ABANDON_MINUTES, 30),

  // Số người hoàn thành tối đa mỗi nhóm (0 = không giới hạn)
  targetPerGroup: num(env.TARGET_PER_GROUP, 0),

  // true = chặn điện thoại/máy tính bảng (chỉ cho làm bằng bàn phím).
  // false (mặc định) = cho làm trên điện thoại bằng cách chạm màn hình.
  requireKeyboard: bool(env.REQUIRE_KEYBOARD, false),

  // Link chuyển về khi hoàn thành (vd. Prolific). Để trống = chỉ hiện mã.
  completionUrl: env.COMPLETION_URL || '',

  // Thời hạn cookie nhận diện người tham gia (ngày)
  cookieDays: num(env.COOKIE_DAYS, 365),
};
