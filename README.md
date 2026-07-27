# bot_prj - Telegram Commit & Website Research Bot

Telegram Bot chuyên nhận Webhook từ GitHub khi có Git Push (tóm tắt bằng Gemini AI) và tự động Research/Kiểm tra trạng thái domain web phim/truyện hàng ngày lúc 07:00 AM.

## 🚀 Tính năng chính
- 🔔 Nhận GitHub Push Webhook (`/webhook/github`) & tóm tắt AI.
- 🕵️‍♂️ Research & Quét tự động danh sách web phim/truyện định kỳ lúc **07:00 AM** hàng ngày.
- 🔄 Tự động phát hiện & tìm kiếm **domain thay thế mới nhất** qua DuckDuckGo khi domain cũ bị sập/chặn.
- 🎬 Trích xuất danh sách tập phim / chương truyện mới nhất.
- 💬 Gửi báo cáo định kỳ về Telegram cá nhân hoặc nhóm chat.

## 📌 Các lệnh Telegram:
- `/research`: Chạy quét & kiểm tra ngay danh sách website.
- `/targets`: Xem danh sách website đang được theo dõi.
- `/addtarget <tên> <url> [từ_khóa]`: Thêm website mới vào danh sách.
- `/deltarget <tên_hoặc_id>`: Xóa website khỏi danh sách theo dõi.
- `/id`: Xem Chat ID Telegram của bạn.
- `/ping`: Kiểm tra độ phản hồi của bot.

## 🛠️ Biến môi trường (Environment Variables)

| Tên biến | Mô tả | Bắt buộc | Ví dụ |
|---|---|---|---|
| `BOT_TOKEN` | Token Telegram Bot tạo từ `@BotFather` | Có | `123456789:ABCdef...` |
| `ADMIN_CHAT_IDS` | Các Chat ID nhận thông báo (ngăn cách bằng dấu phẩy) | Có | `123456789,-987654321` |
| `GEMINI_API_KEY` | API Key từ Google AI Studio | Không | `AIzaSy...` |
| `PORT` | Cổng HTTP Server cho Webhook | Không (mặc định 3000) | `3000` |

## 🐳 Triển khai với Dokploy (Docker)

1. Tạo Application mới trên Dokploy.
2. Nguồn Repo `aiThss/bot_prj`, branch `main`, Build Type `Dockerfile`.
3. Đặt các Environment Variables và Port `3000`.
4. Deploy ứng dụng.
