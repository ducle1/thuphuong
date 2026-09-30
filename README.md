# Thí nghiệm Self-Paced Reading — bản Vercel

Cùng tính năng với bản PHP, nhưng chạy được trên Vercel:

- **Giao diện** (`public/`): HTML/CSS/JS tĩnh, Vercel phục vụ qua CDN
- **Backend** (`api/`): Vercel Functions viết bằng Node.js
- **Dữ liệu**: Postgres trên **Neon** (có gói miễn phí, thêm bằng 1 lần bấm trong Vercel)

> Vì sao không dùng thẳng bản PHP? Vercel không chạy PHP, và mỗi request là một máy chủ tạm thời —
> file SQLite hay session PHP ghi xuống đĩa sẽ mất. Nên dữ liệu phải nằm ở một database bên ngoài.

---

## 1. Cấu trúc

```
spr-vercel/
├── public/                 giao diện người tham gia (index.html + assets/)
├── api/
│   ├── participant.js      API: tạo ID, chia nhóm, lưu từng câu
│   └── admin.js            trang /admin + xuất CSV
├── lib/                    logic chung (config, db, cân bằng nhóm, xáo trộn…)
│   ├── config.js           ★ cấu hình mặc định
│   └── stimuli.js          (tự sinh từ stimuli.csv — đừng sửa tay)
├── stimuli.csv             ★ danh sách câu (sửa bằng Excel)
├── scripts/build-stimuli.mjs
├── vercel.json
└── package.json
```

## 2. Đưa lên Vercel (qua GitHub — khuyên dùng)

**Bước 1 — Đưa code lên GitHub**
Tạo repo mới (có thể để Private) → *Add file → Upload files* → kéo toàn bộ nội dung thư mục `spr-vercel` vào → Commit.

**Bước 2 — Tạo project trên Vercel**
1. Vào [vercel.com](https://vercel.com) → **Add New… → Project** → chọn repo vừa tạo → **Import**.
2. *Framework Preset* để **Other** (vercel.json đã cấu hình sẵn, không cần sửa gì).
3. Mở **Environment Variables**, thêm:
   | Name | Value |
   |---|---|
   | `ADMIN_PASSWORD` | mật khẩu trang admin (tự đặt, đủ mạnh) |
4. Bấm **Deploy**.

**Bước 3 — Thêm database Neon**
1. Trong project → tab **Storage** → **Create Database** → chọn **Neon** (Serverless Postgres) → **Continue**.
2. Chọn region **Washington, D.C. / US East (iad1)** — trùng region mặc định của Vercel Functions nên nhanh nhất, lại gần người tham gia ở Mỹ.
3. Chọn gói Free → Create → **Connect** vào project (để mặc định cả Production, Preview, Development).
   Vercel tự thêm biến `DATABASE_URL`.
4. Tab **Deployments** → bản mới nhất → **⋯ → Redeploy** (để function nhận biến mới).

**Bước 4 — Kiểm tra**
- `https://<tên-project>.vercel.app/` → làm thử 1 lượt
- `https://<tên-project>.vercel.app/admin` → đăng nhập bằng `ADMIN_PASSWORD`
- Bảng dữ liệu được **tự tạo ở lần truy cập đầu tiên**, không cần chạy SQL.
- Làm thử xong: vào admin, bấm **Xoá** từng người chạy thử.

> Gửi cho người tham gia **link Production** (`…vercel.app` hoặc tên miền riêng).
> Link Preview (có chuỗi ngẫu nhiên trong tên) mặc định bị Vercel yêu cầu đăng nhập.

### Cách khác: dùng Vercel CLI
```bash
npm i -g vercel
cd spr-vercel
vercel                       # đăng nhập + tạo project
vercel env add ADMIN_PASSWORD
# thêm Neon trong dashboard (Bước 3), rồi:
vercel --prod
```

### Tên miền riêng (tuỳ chọn)
Project → **Settings → Domains** → thêm vd. `study.tenmien.com`, rồi tạo bản ghi DNS theo hướng dẫn Vercel hiển thị.

---

## 3. Sửa danh sách câu

Mở `stimuli.csv` bằng Excel → sửa → lưu dạng **CSV UTF-8** → upload/commit lên GitHub.
Vercel tự build lại và tự sinh `lib/stimuli.js` từ file CSV.

| cột | ý nghĩa |
|---|---|
| `item_id` | mã câu (duy nhất) |
| `type` | Types of environment (thứ tự xuất hiện = thứ tự trong admin) |
| `sentence` | câu |
| `group` | `A` / `B`; **để trống = filler** (dùng chung) |
| `question` | câu hỏi kiểm tra (để trống nếu không có) |
| `correct_answer` | `yes` / `no` |

Thay đổi chỉ áp dụng cho người **mới**; ai đã bắt đầu giữ nguyên bộ câu của họ.

## 4. Cấu hình

Đặt trong **Settings → Environment Variables** (rồi Redeploy), hoặc sửa mặc định trong `lib/config.js`:

| biến | mặc định | |
|---|---|---|
| `ADMIN_PASSWORD` | — | **bắt buộc** |
| `DATABASE_URL` | — | Neon tự thêm |
| `TARGET_PER_GROUP` | 0 | số người hoàn thành tối đa mỗi nhóm (0 = không giới hạn) |
| `ABANDON_MINUTES` | 30 | im lặng quá N phút → coi là bỏ dở, nhường chỗ |
| `DISPLAY_MODE` | `moving_window` | hoặc `center` |
| `MAX_CONSECUTIVE_WORD` / `MAX_CONSECUTIVE` | `totally` / 2 | ràng buộc xáo trộn |
| `ORDER_MODE` | `fixed` | `fixed` = mọi người cùng 1 thứ tự (A/B song song); `random` = mỗi người ngẫu nhiên riêng |
| `ORDER_SEED` | `spr-order-1` | đổi chuỗi này → ra thứ tự cố định khác |
| `REQUIRE_KEYBOARD` | false | `true` = chặn điện thoại/máy tính bảng, chỉ cho làm bằng bàn phím |
| `COMPLETION_URL` | — | link chuyển về khi xong (vd. Prolific) |
| `TIMEZONE` | `Asia/Ho_Chi_Minh` | múi giờ hiển thị trong admin |
| `SESSION_SECRET` | (sinh từ mật khẩu) | chuỗi bí mật ký cookie admin |

Link có `?PROLIFIC_PID=…` (hoặc `?pid=…`) sẽ được lưu vào cột `external_id`.

---

## 5. Cách hoạt động (giống bản PHP)

- **ID + nhóm cố định**: vào trang là có ID. Nhận diện bằng 2 lớp: cookie `spr_pid` (1 năm) và cookie phiên `spr_sess` gắn với bảng `sessions` trên server. Mất 1 trong 2 vẫn nhận ra và tự khôi phục cái còn lại.
- **Chia nhóm** khi bắt đầu, **cân bằng A/B riêng cho từng thiết bị** (máy tính / điện thoại): trong mỗi thiết bị, vào nhóm có (hoàn thành + đang làm) ít hơn → hoà thì nhóm ít hoàn thành hơn → hoà nữa thì giữ tổng A/B cân bằng → cuối cùng lẻ A, chẵn B. Thiết bị lúc chia nhóm được lưu cố định ở cột `device`. Dùng khoá của Postgres (`pg_advisory_xact_lock`) nên nhiều người bắt đầu cùng lúc vẫn chia đều (đã thử 100 người đồng thời: 60 máy tính + 40 điện thoại → 30/30 và 20/20). `TARGET_PER_GROUP` tính trên tổng số người hoàn thành của mỗi nhóm.
- **56 câu/người**: 28 câu của nhóm + 28 filler, xen kẽ, **không quá 2 câu "totally" liền nhau**. 10 câu hỏi kiểm tra Yes/No bắt buộc.
- **Thứ tự câu cố định** (mặc định): mọi người trong cùng nhóm thấy **cùng một thứ tự**, và nhóm A với B **song song** — filler giống hệt nhau ở cùng vị trí, câu cùng Types of environment ở cùng vị trí, câu hỏi kiểm tra của A và B cũng ở cùng vị trí. Xem/tải thứ tự ở admin → **Thứ tự câu**. Đổi sang một thứ tự cố định khác: đặt `ORDER_SEED`; quay lại kiểu mỗi người ngẫu nhiên riêng: `ORDER_MODE=random`.
- **Thời gian mỗi từ** đo ngay trong trình duyệt (`performance.now()`), nên tốc độ mạng hay độ trễ server **không ảnh hưởng** tới số ms.
- **Thoát giữa chừng** → mở lại link, tiếp tục đúng câu đang dở (đọc lại câu đó từ đầu, admin đánh dấu "đọc lại").
- **Admin** `/admin`: cân bằng A/B, bảng ms/từ theo Types of environment × nhóm, danh sách người tham gia với % đúng, chi tiết từng người (sắp theo Types of environment, ms dưới từng từ), Loại/Khôi phục/Xoá, xuất CSV (theo từ / theo câu / theo người).

**Điện thoại / máy tính bảng**: tự nhận ra thiết bị chỉ có cảm ứng. Khi đó người tham gia **chạm bất kỳ đâu trên màn hình** thay cho phím Space (màn đọc chiếm toàn màn hình, không cuộn/zoom được); các nút Start/Continue/Yes/No to, dễ bấm. Câu hỏi Yes/No bị khoá 0,4 giây đầu để cú chạm cuối câu không bấm nhầm. Thiết bị lúc chia nhóm lưu ở cột `device` (dùng để cân bằng A/B); thiết bị thực dùng lưu ở `input_mode` (`keyboard` / `touch` / `mixed` nếu đổi thiết bị giữa chừng); trang admin có bộ lọc **Thiết bị** và bảng tổng hợp lọc theo thiết bị. Nên phân tích riêng hai nhóm thiết bị, vì thời gian chạm màn hình và bấm phím không so sánh trực tiếp được.

**Lưu ý về Neon gói Free**: database tự "ngủ" khi không ai truy cập một lúc; người đầu tiên vào sau đó có thể chờ thêm khoảng 1 giây ở màn hình Loading. Việc này không ảnh hưởng dữ liệu đo.

## 6. Chạy thử trên máy

Cần Node 20+ và một Postgres (có thể dùng luôn chuỗi kết nối Neon):
```bash
npm install
DATABASE_URL="postgres://…" ADMIN_PASSWORD="test" npm run dev
# mở http://localhost:3000  và  http://localhost:3000/admin
```
