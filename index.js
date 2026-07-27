const express = require('express');
const { Telegraf } = require('telegraf');
const axios = require('axios');
require('dotenv').config();

const { loadTargets, saveTargets, runWebsiteResearch, initScheduler } = require('./tracker');

// Validate required environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_IDS = [...new Set(
  [process.env.ADMIN_CHAT_ID, process.env.ADMIN_CHAT_IDS]
    .filter(Boolean)
    .join(',')
    .split(/[,;\s]+/)
    .map((value) => value.trim())
    .filter((value) => /^-?\d+$/.test(value))
)];

if (!BOT_TOKEN || ADMIN_CHAT_IDS.length === 0) {
  console.error('CRITICAL: BOT_TOKEN and at least one ADMIN_CHAT_ID or ADMIN_CHAT_IDS value must be set.');
  process.exit(1);
}

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Express Setup
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'bot_prj' });
});

// Telegraf Bot Setup
const bot = new Telegraf(BOT_TOKEN);

// Function to summarize commits using Gemini API
async function summarizeCommits(commits) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.log('Gemini API key is not configured, skipping AI summarization.');
    return null;
  }

  const commitDetails = commits.map((c, i) => {
    const shortHash = c.id?.substring(0, 7) || 'unknown';
    const author = c.author?.name || 'Unknown';
    const message = c.message || 'No commit message';
    return `Commit #${i + 1}:\n- Hash: ${shortHash}\n- Tác giả: ${author}\n- Nội dung: ${message}`;
  }).join('\n\n');

  const prompt = `Bạn là một AI trợ lý phát triển phần mềm chuyên nghiệp. Dưới đây là thông tin về các commit mới được push lên repository:
${commitDetails}

Hãy tóm tắt các thay đổi từ các commit trên một cách thông minh, ngắn gọn và súc tích bằng tiếng Việt.
Yêu cầu định dạng kết quả trả về:
1. Viết hoàn toàn bằng tiếng Việt.
2. Sử dụng các emoji phù hợp để trực quan hóa thông tin.
3. Chỉ sử dụng các thẻ HTML được Telegram hỗ trợ: <b>, <i>, <code>, <a>. Tuyệt đối không dùng cú pháp markdown như **, *, [link](url) hay backticks, hãy chuyển đổi chúng hoàn toàn sang các thẻ HTML tương ứng. Nếu tạo link, hãy dùng thẻ <a href="url">text</a>.
4. Đưa ra phần tóm tắt ngắn gọn của các thay đổi chính (ví dụ: sửa lỗi gì, thêm tính năng gì, ảnh hưởng gì).
`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 12000
      }
    );

    const generatedText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (generatedText) {
      return generatedText.trim();
    }
  } catch (error) {
    console.error('Lỗi khi gọi Gemini API:', error.message);
  }
  return null;
}

// GitHub Webhook Endpoint
app.post('/webhook/github', async (req, res) => {
  const githubEvent = req.headers['x-github-event'];
  console.log(`Received GitHub webhook. Event type: ${githubEvent}`);

  if (githubEvent === 'ping') {
    return res.status(200).json({ message: 'pong' });
  }

  const payload = req.body || {};
  const ref = payload.ref || '';
  const branch = ref.replace('refs/heads/', '') || 'unknown-branch';
  const repoName = payload.repository?.name || 'Unknown Repository';
  const repoUrl = payload.repository?.html_url || '';
  const pusherName = payload.pusher?.name || payload.pusher?.username || 'Unknown Pusher';
  const commits = payload.commits || [];

  if (commits.length === 0) {
    return res.status(200).json({ message: 'No commits to process' });
  }

  try {
    const summaryText = await summarizeCommits(commits);

    let telegramMessage = `🛠️ <b>[Git Push] ${escapeHtml(repoName)}</b>\n`;
    telegramMessage += `🌿 <b>Branch:</b> <code>${escapeHtml(branch)}</code>\n`;
    telegramMessage += `👤 <b>Người đẩy:</b> ${escapeHtml(pusherName)}\n\n`;

    if (summaryText) {
      telegramMessage += `🤖 <b>Tóm tắt thay đổi (AI):</b>\n${summaryText}\n\n`;
    } else {
      telegramMessage += `📝 <b>Danh sách commits:</b>\n`;
      commits.forEach((commit) => {
        const shortHash = commit.id?.substring(0, 7) || 'unknown';
        const author = commit.author?.name || 'Unknown';
        const message = commit.message?.split('\n')[0] || 'No commit message';
        const url = commit.url || '';
        if (url) {
          telegramMessage += `• <a href="${url}">${shortHash}</a> - <b>${escapeHtml(author)}</b>: ${escapeHtml(message)}\n`;
        } else {
          telegramMessage += `• <code>${shortHash}</code> - <b>${escapeHtml(author)}</b>: ${escapeHtml(message)}\n`;
        }
      });
      telegramMessage += '\n';
    }

    if (repoUrl) {
      telegramMessage += `🔗 <a href="${repoUrl}">Xem chi tiết trên Repository</a>`;
    }

    await Promise.all(
      ADMIN_CHAT_IDS.map(chatId => bot.telegram.sendMessage(chatId, telegramMessage, { parse_mode: 'HTML' }))
    );

    return res.status(200).json({ success: true, message: 'GitHub push notification sent to Telegram' });
  } catch (error) {
    console.error('Failed to send GitHub notification to Telegram:', error.message);
    return res.status(500).json({ error: 'Failed to send Telegram notification: ' + error.message });
  }
});

// Bot Command Menu & Handlers
const BOT_COMMANDS = [
  { command: 'research', description: 'Quét & kiểm tra các web phim/truyện ngay lập tức' },
  { command: 'targets', description: 'Danh sách website đang theo dõi' },
  { command: 'id', description: 'Xem Telegram Chat ID của bạn' },
  { command: 'ping', description: 'Kiểm tra trạng thái hoạt động của bot' },
  { command: 'help', description: 'Hướng dẫn sử dụng bot' }
];

const helpText = [
  '🤖 <b>Project & Website Research Bot</b>',
  '',
  '📌 <b>Chức năng chính:</b>',
  '1. Báo Git Push commit từ GitHub bằng AI Gemini.',
  '2. 🌐 Quét & research tự động danh sách web phim/truyện vào <b>07:00 AM hàng ngày</b> (cập nhật domain mới nhất khi sập và tập/chương mới).',
  '',
  '📌 <b>Các lệnh khả dụng:</b>',
  '• <b>/research</b> — Chạy quét ngay danh sách website',
  '• <b>/targets</b> — Xem danh sách các website đang được theo dõi',
  '• <b>/addtarget &lt;tên&gt; &lt;url&gt; [từ_khóa_search]</b> — Thêm web mới cần theo dõi',
  '• <b>/deltarget &lt;tên_hoặc_id&gt;</b> — Xóa web khỏi danh sách theo dõi',
  '• <b>/id</b> — Xem Chat ID hiện tại của bạn',
  '• <b>/ping</b> — Kiểm tra phản hồi bot'
].join('\n');

bot.start((ctx) => ctx.reply(helpText, { parse_mode: 'HTML' }));
bot.help((ctx) => ctx.reply(helpText, { parse_mode: 'HTML' }));

bot.command('id', async (ctx) => {
  const chatId = String(ctx.chat?.id || 'Không xác định');
  const userId = String(ctx.from?.id || 'Không xác định');
  const isConfigured = ADMIN_CHAT_IDS.includes(chatId);
  const status = isConfigured
    ? '✅ Chat ID này đã có trong ADMIN_CHAT_IDS.'
    : '⚠️ Chat ID này chưa có trong ADMIN_CHAT_IDS.';

  return ctx.reply([
    '🆔 <b>Telegram Chat ID Information</b>',
    '',
    'Chat ID: <code>' + escapeHtml(chatId) + '</code>',
    'User ID: <code>' + escapeHtml(userId) + '</code>',
    '',
    status
  ].join('\n'), { parse_mode: 'HTML' });
});

bot.command('ping', (ctx) => ctx.reply('🏓 Pong! Bot đang hoạt động bình thường.'));

// Lệnh quét thủ công danh sách website
bot.command('research', async (ctx) => {
  await ctx.reply('🔎 Đang tiến hành quét và nghiên cứu các website trong danh sách...');
  await runWebsiteResearch(bot, [String(ctx.chat.id)]);
});

// Lệnh xem danh sách website theo dõi
bot.command('targets', (ctx) => {
  const targets = loadTargets();
  if (targets.length === 0) {
    return ctx.reply('⚠️ Danh sách theo dõi hiện đang trống. Dùng /addtarget để thêm web mới.');
  }

  const lines = ['🌐 <b>Danh sách website đang theo dõi:</b>', ''];
  targets.forEach((t, i) => {
    lines.push(`${i + 1}. <b>${escapeHtml(t.name)}</b> (ID: <code>${escapeHtml(t.id)}</code>)`);
    lines.push(`   • URL: ${escapeHtml(t.url)}`);
    if (t.searchKeyword) lines.push(`   • Từ khóa tìm kiếm domain thay thế: <i>${escapeHtml(t.searchKeyword)}</i>`);
    lines.push('');
  });

  lines.push('💡 <b>Cú pháp thêm web:</b>');
  lines.push('<code>/addtarget PhimMoi https://phimmoi.com phimmoi domain mới nhất</code>');
  lines.push('');
  lines.push('💡 <b>Cú pháp xóa web:</b>');
  lines.push('<code>/deltarget phim1</code>');

  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
});

// Lệnh thêm website mới
bot.command('addtarget', (ctx) => {
  const text = String(ctx.message?.text || '').trim();
  const parts = text.split(/\s+/).slice(1);

  if (parts.length < 2) {
    return ctx.reply('⚠️ Cú pháp: <code>/addtarget &lt;tên_web&gt; &lt;url&gt; [từ_khóa_search]</code>\nVí dụ: <code>/addtarget PhimMoi https://phimmoi.com phimmoi domain mới nhất</code>', { parse_mode: 'HTML' });
  }

  const name = parts[0];
  let targetUrl = parts[1];
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
  const searchKeyword = parts.slice(2).join(' ') || `${name} domain moi nhat`;

  const targets = loadTargets();
  const newId = 'web_' + Date.now().toString(36);

  targets.push({
    id: newId,
    name: name,
    url: targetUrl,
    searchKeyword: searchKeyword,
    enabled: true
  });

  saveTargets(targets);
  return ctx.reply(`✅ Đã thêm website <b>${escapeHtml(name)}</b> vào danh sách theo dõi thành công!`, { parse_mode: 'HTML' });
});

// Lệnh xóa website
bot.command('deltarget', (ctx) => {
  const text = String(ctx.message?.text || '').trim();
  const query = text.split(/\s+/)[1];

  if (!query) {
    return ctx.reply('⚠️ Cú pháp: <code>/deltarget &lt;tên_hoặc_id&gt;</code>', { parse_mode: 'HTML' });
  }

  let targets = loadTargets();
  const initialLength = targets.length;
  targets = targets.filter(t => t.id !== query && t.name.toLowerCase() !== query.toLowerCase());

  if (targets.length === initialLength) {
    return ctx.reply(`⚠️ Không tìm thấy website nào khớp với "${escapeHtml(query)}".`);
  }

  saveTargets(targets);
  return ctx.reply(`✅ Đã xóa website khỏi danh sách theo dõi thành công!`);
});

// Configure Telegram command menu
Promise.all([
  bot.telegram.setMyCommands(BOT_COMMANDS),
  bot.telegram.callApi('setChatMenuButton', { menu_button: { type: 'commands' } })
]).then(() => {
  console.log('Telegram command menu configured');
}).catch((error) => {
  console.warn('Failed to configure Telegram command menu:', error.message);
});

// Start Express Server
const server = app.listen(PORT, () => {
  console.log(`Express server running on port ${PORT}`);
});

// Launch Telegraf Bot & Cron Scheduler
bot.launch().then(() => {
  console.log('Telegraf bot launched in polling mode');
  initScheduler(bot, ADMIN_CHAT_IDS);
}).catch((err) => {
  console.error('Failed to launch Telegraf bot:', err);
});

// Graceful Shutdown
const gracefulShutdown = (signal) => {
  console.log(`${signal} received. Shutting down gracefully...`);
  bot.stop(signal);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
};

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
