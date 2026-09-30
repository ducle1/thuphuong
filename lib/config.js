/**
 * CẤU HÌNH
 * Mỗi mục có thể sửa mặc định ngay tại đây, hoặc đặt biến môi trường cùng tên
 * trong Vercel → Project → Settings → Environment Variables (rồi Redeploy).
 */
const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export const config = {
  // BẮT BUỘC: mật khẩu trang /admin (đặt trong Environment Variables, không ghi vào code)
  adminPassword: env.ADMIN_PASSWORD || '',

  // Tuỳ chọn: chuỗi bí mật để ký cookie admin (mặc định sinh từ ADMIN_PASSWORD)
  sessionSecret: env.SESSION_SECRET || '',

  // Chuỗi kết nối Postgres — Neon trên Vercel tự thêm DATABASE_URL
  databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',

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

  // Chặn thiết bị chỉ có cảm ứng (không bấm được phím Space)
  requireKeyboard: bool(env.REQUIRE_KEYBOARD, true),

  // Link chuyển về khi hoàn thành (vd. Prolific). Để trống = chỉ hiện mã.
  completionUrl: env.COMPLETION_URL || '',

  // Thời hạn cookie nhận diện người tham gia (ngày)
  cookieDays: num(env.COOKIE_DAYS, 365),
};
