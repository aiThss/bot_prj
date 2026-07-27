# bot_prj - Telegram Bot Notification Service

Telegram Bot chuyên nhận Webhook từ GitHub khi có Git Push, tự động tóm tắt danh sách commit bằng AI (Google Gemini) và gửi thông báo trực tiếp đến Telegram.

## 🚀 Tính năng chính
- 🔔 Nhận GitHub Push Webhook (`/webhook/github`).
- 🤖 Tóm tắt thay đổi trong các commit bằng AI Gemini (tiếng Việt).
- 💬 Gửi tin nhắn đến Telegram cá nhân hoặc nhóm chat.
- 🆔 Lệnh `/id` hỗ trợ tra cứu Chat ID nhanh chóng.

## 🛠️ Biến môi trường (Environment Variables)

| Tên biến | Mô tả | Bắt buộc | Ví dụ |
|---|---|---|---|
| `BOT_TOKEN` | Token Telegram Bot tạo từ `@BotFather` | Có | `123456789:ABCdef...` |
| `ADMIN_CHAT_IDS` | Các Chat ID nhận thông báo (ngăn cách bằng dấu phẩy) | Có | `123456789,-987654321` |
| `GEMINI_API_KEY` | API Key từ Google AI Studio | Không | `AIzaSy...` |
| `PORT` | Cổng HTTP Server cho Webhook | Không (mặc định 3000) | `3000` |

## 🐳 Triển khai với Dokploy (Docker / Git Repository)

1. Tạo Application mới trên Dokploy.
2. Chọn **Provider: GitHub**, chọn Repo `aiThss/bot_prj`, branch `main`.
3. Chọn Build Type: **Dockerfile** (hoặc Nixpacks/Node.js).
4. Thêm các **Environment Variables**:
   ```env
   BOT_TOKEN=...
   ADMIN_CHAT_IDS=...
   GEMINI_API_KEY=...
   PORT=3000
   ```
5. Đặt **Port** thành `3000`.
6. Cấu hình **Domain** trong Dokploy (VD: `bot-prj.yourdomain.com`).
7. Nhấn **Deploy**.

## 🔗 Cấu hình GitHub Webhook
1. Vào repository GitHub bất kỳ mà bạn muốn nhận thông báo.
2. Vào **Settings** -> **Webhooks** -> **Add webhook**.
3. **Payload URL:** `https://your-domain.com/webhook/github`
4. **Content type:** `application/json`
5. **Which events:** Chọn `Just the push event`.
6. Nhấn **Add webhook**.
