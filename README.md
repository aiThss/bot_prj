# bot_prj - Telegram Commit, Dokploy & Website Research Bot

Telegram Bot chuyên nhận Webhook từ GitHub khi có Git Push (tóm tắt bằng Gemini AI), nhận Webhook thông báo **Deployment Successful từ Dokploy**, và tự động Research/Kiểm tra trạng thái domain web phim/truyện hàng ngày lúc 07:00 AM.

## 🚀 Tính năng chính
- 🔔 Nhận GitHub Push Webhook (`/webhook/github`) & tóm tắt AI.
- 🚀 Nhận Dokploy Notification Webhook (`/webhook/dokploy`) báo deploy thành công / lỗi.
- 🕵️‍♂️ Research & Quét tự động danh sách web phim/truyện định kỳ lúc **07:00 AM** hàng ngày.
- 🧠 AI Smart Search: Dự đoán tên & tìm kiếm phim/truyện trực tiếp.
- 🔄 Tự động phát hiện & tìm kiếm **domain thay thế mới nhất** qua DuckDuckGo khi domain cũ bị sập/chặn.
- 💬 Gửi báo cáo định kỳ về Telegram cá nhân hoặc nhóm chat.

## 📌 Các lệnh Telegram:
- `/search <tên>`: AI dự đoán & tìm kiếm phim/truyện trực tiếp.
- `/add <url>`: Thêm web mới vào danh sách theo dõi.
- `/del`: Hiện nút bấm (bubbles) chọn xóa website nhanh.
- `/list`: Xem danh sách & menu nút bấm tương tác.
- `/research`: Chạy quét & kiểm tra ngay danh sách website.
- `/id`: Xem Chat ID Telegram của bạn.
- `/ping`: Kiểm tra độ phản hồi của bot.

## 🛠️ Biến môi trường (Environment Variables)

| Tên biến | Mô tả | Bắt buộc | Ví dụ |
|---|---|---|---|
| `BOT_TOKEN` | Token Telegram Bot tạo từ `@BotFather` | Có | `123456789:ABCdef...` |
| `ADMIN_CHAT_IDS` | Các Chat ID nhận thông báo (ngăn cách bằng dấu phẩy) | Có | `123456789,-987654321` |
| `GEMINI_API_KEY` | API Key từ Google AI Studio | Không | `AIzaSy...` |
| `PORT` | Cổng HTTP Server cho Webhook | Không (mặc định 3000) | `3000` |

## 🚀 Cấu hình Webhook Dokploy (Báo Deployment Success):
- URL Webhook: `https://bot-prj.yourdomain.com/webhook/dokploy`
