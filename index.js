const express = require('express');
const { Telegraf } = require('telegraf');
const axios = require('axios');
require('dotenv').config();

const { loadTargets, saveTargets, resolveDestinationUrl, checkWebsiteTarget, searchMovieOrManga, runWebsiteResearch, initScheduler } = require('./tracker');
const { processAndSendMedia } = require('./downloader');

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

// Dokploy Deployment Webhook Endpoint
app.post('/webhook/dokploy', async (req, res) => {
  const body = req.body || {};
  console.log('Received Dokploy webhook payload:', JSON.stringify(body, null, 2));

  const title = body.title || body.applicationName || body.name || 'Dokploy Notification';
  const message = body.message || body.description || body.details || '';
  const status = String(body.status || '').toLowerCase();
  const timestamp = body.timestamp || new Date();

  if (!title && !message) {
    return res.status(400).json({ error: 'Missing title and message in payload' });
  }

  try {
    let timeStr = '';
    try {
      const date = timestamp ? new Date(timestamp) : new Date();
      timeStr = date.toLocaleString('vi-VN', { timeZone: 'Asia/Bangkok' });
    } catch (_) {
      timeStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Bangkok' });
    }

    let icon = 'ℹ️';
    const lowerTitle = String(title).toLowerCase();
    const lowerMessage = String(message).toLowerCase();

    if (status === 'success' || lowerTitle.includes('success') || lowerTitle.includes('thành công') || lowerMessage.includes('success')) {
      icon = '🚀';
    } else if (status === 'error' || status === 'failed' || lowerTitle.includes('fail') || lowerTitle.includes('lỗi') || lowerTitle.includes('error') || lowerMessage.includes('error')) {
      icon = '❌';
    } else if (lowerTitle.includes('restart') || lowerTitle.includes('khởi động lại')) {
      icon = '🔄';
    } else if (lowerTitle.includes('warning') || lowerTitle.includes('cảnh báo')) {
      icon = '⚠️';
    }

    let telegramMessage = `${icon} <b>[Dokploy Deployment] ${escapeHtml(title)}</b>\n\n`;
    if (message) {
      telegramMessage += `📝 <b>Chi tiết:</b>\n${escapeHtml(message)}\n\n`;
    }
    telegramMessage += `🕒 <b>Thời gian:</b> ${timeStr}`;

    await Promise.all(
      ADMIN_CHAT_IDS.map(chatId => bot.telegram.sendMessage(chatId, telegramMessage, { parse_mode: 'HTML' }))
    );

    return res.status(200).json({ success: true, message: 'Dokploy notification sent to Telegram' });
  } catch (error) {
    console.error('Failed to send Dokploy notification to Telegram:', error.message);
    return res.status(500).json({ error: 'Failed to send Telegram notification: ' + error.message });
  }
});

// Bot Command Menu & Handlers
const BOT_COMMANDS = [
  { command: 'search', description: 'Tìm kiếm phim/truyện trên Web cụ thể hoặc tất cả web' },
  { command: 'dl', description: 'Tải media/video/truyện trực tiếp vào Telegram: /dl <url>' },
  { command: 'add', description: 'Thêm web mới vào danh sách theo dõi: /add <url>' },
  { command: 'del', description: 'Menu chọn bấm nút để xóa website nhanh' },
  { command: 'list', description: 'Xem danh sách & menu tương tác website' },
  { command: 'research', description: 'Quét & kiểm tra ngay danh sách website' },
  { command: 'id', description: 'Xem Telegram Chat ID của bạn' },
  { command: 'ping', description: 'Kiểm tra phản hồi bot' },
  { command: 'help', description: 'Hướng dẫn sử dụng bot' }
];

const helpText = [
  '🤖 <b>Project & Website Research Bot - Hướng Dẫn Sử Dụng Chi Tiết</b>',
  '========================================',
  '',
  '🌟 <b>1. CÁC CHỨC NĂNG CHÍNH CỦA BOT:</b>',
  '• 🛠️ <b>Báo Commit GitHub:</b> Tự động nhận Webhook từ GitHub & AI Gemini tóm tắt thay đổi code bằng tiếng Việt.',
  '• 🚀 <b>Báo Deploy Dokploy:</b> Tự động gửi thông báo khi Dokploy deploy ứng dụng thành công hoặc thất bại.',
  '• ⏰ <b>Research Website Hàng Ngày (07:00 AM):</b> Tự động kiểm tra danh sách web phim/truyện, báo trạng thái ONLINE/OFFLINE, tìm domain mới khi bị sập và trích xuất tập mới.',
  '• 🧠 <b>AI Smart Search:</b> Tìm kiếm phim/truyện thông minh trên các trang web cụ thể.',
  '• 📥 <b>Telegram Media Downloader:</b> Tải trực tiếp video MP4 hoặc trọn bộ album ảnh chap truyện về Telegram chat.',
  '',
  '========================================',
  '🔍 <b>2. HƯỚNG DẪN TÌM KIẾM PHIM / TRUYỆN (/search, /find, /tim):</b>',
  '• <b>Tìm trên TẤT CẢ web theo dõi:</b>',
  '  👉 <code>/search tiên nghịch</code>',
  '  👉 <code>/tim conan</code>',
  '• <b>Tìm trực tiếp trên 1 WEB CỤ THỂ:</b>',
  '  👉 <code>/search HH3D tiên nghịch</code>',
  '  👉 <code>/search FoxTruyen tiên nghịch</code>',
  '• <b>Dùng Nút Bấm Chọn Web:</b>',
  '  👉 Gõ <code>/search</code> không kèm tham số -> Bot sẽ hiện danh sách nút bấm (bubbles) chọn web.',
  '',
  '========================================',
  '📥 <b>3. HƯỚNG DẪN TẢI PHIM / TRUYỆN VỀ TELEGRAM (/dl, /tai):</b>',
  '• <b>Tải qua lệnh /dl:</b>',
  '  👉 <code>/dl https://foxtruyen2.com/truyen-tranh/ten-truyen/chap-85</code>',
  '  👉 <code>/dl bit.ly/hh3d</code> (Tự động theo vết link rút gọn)',
  '• <b>Tải qua Nút Bấm:</b>',
  '  👉 Khi gõ <code>/search</code>, bấm nút <code>[ 📥 Tải Kếtt quả về Telegram ]</code> ngay bên dưới kết quả.',
  '• 💡 <b>Mẹo Đọc/Xem Offline:</b>',
  '  <i>Khi file/ảnh đã gửi vào Telegram chat, bạn bấm chuyển tiếp (Forward) vào "Saved Messages". Lần sau dù ngắt mạng vẫn có thể mở ra xem/đọc offline 100%!</i>',
  '',
  '========================================',
  '🌐 <b>4. QUẢN LÝ DANH SÁCH WEBSITE THEO DÕI:</b>',
  '• <b>/list</b> (hoặc <code>/targets</code>) — Xem danh sách web theo dõi & menu nút bấm tương tác.',
  '• <b>/add &lt;url&gt;</b> — Thêm web mới (VD: <code>/add bit.ly/hh3d</code> hoặc <code>/add PhimMoi https://phimmoi.com</code>).',
  '• <b>/del</b> — Hiện giao diện nút bấm chọn xóa web nhanh.',
  '• <b>/research</b> — Chạy quét và báo cáo trạng thái các web ngay lập tức.',
  '',
  '========================================',
  '⚙️ <b>5. CẤU HÌNH WEBHOOK & LỆNH KHÁC:</b>',
  '• <b>GitHub Webhook URL:</b> <code>https://domain-cua-ban/webhook/github</code>',
  '• <b>Dokploy Webhook URL:</b> <code>https://domain-cua-ban/webhook/dokploy</code>',
  '• <b>/id</b> — Xem Chat ID Telegram của bạn.',
  '• <b>/ping</b> — Kiểm tra phản hồi bot.'
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

// Lệnh Tải Media Trực Tiếp về Telegram (/dl, /download, /tai)
const DOWNLOAD_INPUT_PROMPT = '📥 Nhập đường dẫn URL phim hoặc tập truyện bạn muốn tải về Telegram:';

async function handleDownloadCommand(ctx) {
  const text = String(ctx.message?.text || '').trim();
  const firstSpaceIndex = text.indexOf(' ');
  const urlArg = firstSpaceIndex === -1 ? '' : text.slice(firstSpaceIndex + 1).trim();

  if (!urlArg) {
    return ctx.reply(DOWNLOAD_INPUT_PROMPT, {
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: 'Ví dụ: https://hh3dvip.net/tap-85'
      }
    });
  }

  return processAndSendMedia(ctx, urlArg);
}

bot.command('download', handleDownloadCommand);
bot.command('dl', handleDownloadCommand);
bot.command('tai', handleDownloadCommand);

// AI Dự đoán từ khóa & Tìm kiếm Phim/Truyện thông minh trên Web Cụ Thể
const SEARCH_TITLE_PROMPT = '🔍 Nhập tên phim/truyện cần tìm:';

function buildSearchSiteKeyboard() {
  const targets = loadTargets();
  const inline_keyboard = [
    [{ text: '🌐 Tìm kiếm trên TẤT CẢ Web theo dõi', callback_data: 'src_site:all' }]
  ];

  targets.forEach((t) => {
    inline_keyboard.push([
      { text: `🔎 Chỉ tìm trên: ${t.name}`, callback_data: `src_site:${t.id}` }
    ]);
  });

  return { reply_markup: { inline_keyboard } };
}

async function runTitleSearch(ctx, queryStr, siteFilter = null) {
  const targetLabel = siteFilter ? ` trên <b>${escapeHtml(siteFilter)}</b>` : ' trên các web theo dõi';
  const statusMsg = await ctx.reply(`🧠 AI đang tìm kiếm: "<b>${escapeHtml(queryStr)}</b>"${targetLabel}...`, { parse_mode: 'HTML' });

  try {
    const searchData = await searchMovieOrManga(queryStr, siteFilter);
    await ctx.deleteMessage(statusMsg.message_id).catch(() => {});

    if (!searchData.results || searchData.results.length === 0) {
      return ctx.reply(`⚠️ Không tìm thấy kết quả phù hợp cho "<code>${escapeHtml(queryStr)}</code>"${targetLabel}.\n👉 <i>Mẹo: Hãy gõ tên không dấu hoặc thử từ khóa ngắn hơn.</i>`, { parse_mode: 'HTML' });
    }

    const lines = [
      `🔍 <b>Kết quả tìm kiếm cho:</b> "<code>${escapeHtml(queryStr)}</code>"${targetLabel}`,
      `🧠 <b>AI Gemini dự đoán từ khóa:</b> <i>"${escapeHtml(searchData.predictedKeyword)}"</i>`,
      ''
    ];

    const inline_keyboard = [];

    searchData.results.forEach((item, index) => {
      const siteTag = item.siteName ? `[${escapeHtml(item.siteName)}] ` : '';
      lines.push(`<b>${index + 1}. ${siteTag}</b><a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>`);
      if (item.snippet) lines.push(`   <i>${escapeHtml(item.snippet)}</i>`);
      lines.push('');

      // Đính kèm Nút Tải về Telegram trực tiếp
      const encodedUrl = Buffer.from(item.url).toString('base64url');
      if (index < 5 && encodedUrl.length < 60) {
        inline_keyboard.push([
          { text: `📥 Tải Kếtt quả ${index + 1} về Telegram`, callback_data: `dl_link:${encodedUrl}` }
        ]);
      }
    });

    return ctx.reply(lines.join('\n').slice(0, 4000), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined
    });
  } catch (err) {
    await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
    console.error('Lỗi khi tìm kiếm phim/truyện:', err);
    return ctx.reply('❌ Lỗi trong quá trình tìm kiếm phim/truyện.');
  }
}

async function handleTitleSearch(ctx) {
  const text = String(ctx.message?.text || '').trim();
  const firstSpaceIndex = text.indexOf(' ');
  const rawQuery = firstSpaceIndex === -1 ? '' : text.slice(firstSpaceIndex + 1).trim();

  if (rawQuery) {
    const parts = rawQuery.split(/\s+/);
    const firstWord = parts[0];
    const targets = loadTargets();
    const matchedTarget = targets.find(t =>
      t.id.toLowerCase() === firstWord.toLowerCase() ||
      t.name.toLowerCase() === firstWord.toLowerCase()
    );

    if (matchedTarget && parts.length > 1) {
      const subQuery = parts.slice(1).join(' ');
      return runTitleSearch(ctx, subQuery, matchedTarget.name);
    }

    return runTitleSearch(ctx, rawQuery, null);
  }

  return ctx.reply('🔍 <b>Chọn trang web bạn muốn tìm kiếm hoặc nhập từ khóa bên dưới:</b>', {
    parse_mode: 'HTML',
    ...buildSearchSiteKeyboard()
  });
}

bot.command('search', handleTitleSearch);
bot.command('find', handleTitleSearch);
bot.command('tim', handleTitleSearch);

// Helper tạo bàn phím tương tác cho /list
function buildListKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔎 Tìm Phim/Truyện', callback_data: 'act:search_menu' },
          { text: '📥 Tải Media', callback_data: 'act:dl_prompt' },
          { text: '➕ Thêm Web', callback_data: 'act:add_prompt' },
          { text: '🗑️ Xóa Web', callback_data: 'act:del_menu' }
        ],
        [
          { text: '⚡ Quét Báo Cáo Ngay (07:00 AM)', callback_data: 'act:research' }
        ]
      ]
    }
  };
}

// Helper tạo bàn phím danh sách nút bấm chọn xóa cho /del
function buildDeleteKeyboard() {
  const targets = loadTargets();
  if (targets.length === 0) return null;

  const inline_keyboard = [];
  targets.forEach((t) => {
    let hostname = t.url;
    try {
      hostname = new URL(t.url).hostname.replace(/^www\./, '');
    } catch (_) {}
    inline_keyboard.push([
      { text: `❌ Xóa: ${t.name} (${hostname})`, callback_data: `del:${t.id}` }
    ]);
  });

  if (targets.length > 1) {
    inline_keyboard.push([
      { text: `🗑️ Xóa TẤT CẢ website`, callback_data: `del_confirm_all` }
    ]);
  }

  return { reply_markup: { inline_keyboard } };
}

// Lệnh xem danh sách website theo dõi (/list hoặc /targets)
function handleListTargets(ctx) {
  const targets = loadTargets();
  if (targets.length === 0) {
    return ctx.reply('⚠️ Danh sách theo dõi hiện đang trống. Gõ <code>/add https://domain.com</code> hoặc bấm nút bên dưới để thêm web mới.', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Thêm Web Mới', callback_data: 'act:add_prompt' }]
        ]
      }
    });
  }

  const lines = ['🌐 <b>Danh sách website đang theo dõi:</b>', ''];
  targets.forEach((t, i) => {
    lines.push(`${i + 1}. <b>${escapeHtml(t.name)}</b> (ID: <code>${escapeHtml(t.id)}</code>)`);
    lines.push(`   • URL: ${escapeHtml(t.url)}`);
    if (t.searchKeyword) lines.push(`   • Từ khóa tìm kiếm mirror: <i>${escapeHtml(t.searchKeyword)}</i>`);
    lines.push('');
  });

  return ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...buildListKeyboard()
  });
}

bot.command('list', handleListTargets);
bot.command('targets', handleListTargets);

// Lệnh thêm website mới (/add hoặc /addtarget)
const ADD_INPUT_PROMPT = '🌐 Nhập URL hoặc [Tên Web + URL] cần thêm vào danh sách theo dõi:';

function parseAddArguments(inputStr) {
  const parts = inputStr.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return null;

  let name = '';
  let url = '';
  let searchKeyword = '';

  if (/^(https?:\/\/|[a-z0-9-]+\.[a-z]{2,})/i.test(parts[0])) {
    url = parts[0];
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const parsed = new URL(url);
      name = parsed.hostname.replace(/^www\./, '').split('.')[0];
      name = name.charAt(0).toUpperCase() + name.slice(1);
    } catch (_) {
      name = parts[0];
    }
    searchKeyword = parts.slice(1).join(' ') || `${name} domain moi nhat`;
  } else if (parts.length >= 2) {
    name = parts[0];
    url = parts[1];
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    searchKeyword = parts.slice(2).join(' ') || `${name} domain moi nhat`;
  } else {
    name = parts[0];
    url = 'https://' + parts[0] + (parts[0].includes('.') ? '' : '.com');
    searchKeyword = `${name} domain moi nhat`;
  }

  return { name, url, searchKeyword };
}

async function runAddTarget(ctx, inputStr) {
  const parsed = parseAddArguments(inputStr);
  if (!parsed || !parsed.url) {
    return ctx.reply('⚠️ Cú pháp không hợp lệ. Ví dụ:\n• <code>/add https://bit.ly/hh3d</code>\n• <code>/add PhimMoi https://phimmoi.com</code>', { parse_mode: 'HTML' });
  }

  const resolvedUrl = await resolveDestinationUrl(parsed.url);
  let finalName = parsed.name;
  if (!finalName || finalName.toLowerCase() === 'bit' || resolvedUrl !== parsed.url) {
    try {
      const hostname = new URL(resolvedUrl).hostname.replace(/^www\./, '').split('.')[0];
      if (hostname) finalName = hostname.charAt(0).toUpperCase() + hostname.slice(1);
    } catch (_) {}
  }

  const targets = loadTargets();
  const newId = 'web_' + Date.now().toString(36);

  targets.push({
    id: newId,
    name: finalName || parsed.name,
    url: resolvedUrl,
    searchKeyword: parsed.searchKeyword || `${finalName || parsed.name} domain moi nhat`,
    enabled: true
  });

  saveTargets(targets);

  return ctx.reply([
    '✅ <b>Đã thêm website vào danh sách theo dõi thành công!</b>',
    '',
    `📌 <b>Tên:</b> ${escapeHtml(finalName || parsed.name)} (ID: <code>${newId}</code>)`,
    `🌐 <b>URL Gốc / Giải Mã:</b> ${escapeHtml(resolvedUrl)}`,
    `🔍 <b>Từ khóa tìm kiếm mirror:</b> <i>${escapeHtml(parsed.searchKeyword)}</i>`
  ].join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...buildListKeyboard() });
}

async function handleAddTarget(ctx) {
  const text = String(ctx.message?.text || '').trim();
  const firstSpaceIndex = text.indexOf(' ');
  const args = firstSpaceIndex === -1 ? '' : text.slice(firstSpaceIndex + 1).trim();

  if (args) return runAddTarget(ctx, args);

  return ctx.reply(ADD_INPUT_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: 'Ví dụ: https://phimmoi.com'
    }
  });
}

bot.command('add', handleAddTarget);
bot.command('addtarget', handleAddTarget);

// Lệnh xóa website có giao diện Nút Bấm chọn (/del hoặc /deltarget)
function handleDeleteTarget(ctx) {
  const text = String(ctx.message?.text || '').trim();
  const firstSpaceIndex = text.indexOf(' ');
  const query = firstSpaceIndex === -1 ? '' : text.slice(firstSpaceIndex + 1).trim();

  if (query) {
    let targets = loadTargets();
    const initialLength = targets.length;
    targets = targets.filter(t => t.id !== query && t.name.toLowerCase() !== query.toLowerCase());

    if (targets.length === initialLength) {
      return ctx.reply(`⚠️ Không tìm thấy website nào khớp với "${escapeHtml(query)}".`);
    }

    saveTargets(targets);
    return ctx.reply(`✅ Đã xóa website khỏi danh sách theo dõi thành công!`);
  }

  const deleteKeyboard = buildDeleteKeyboard();
  if (!deleteKeyboard) {
    return ctx.reply('⚠️ Danh sách theo dõi hiện đang trống, không có website nào để xóa.');
  }

  return ctx.reply('🗑️ <b>Bấm vào nút bên dưới để chọn website cần xóa:</b>', {
    parse_mode: 'HTML',
    ...deleteKeyboard
  });
}

bot.command('del', handleDeleteTarget);
bot.command('deltarget', handleDeleteTarget);

// Callbacks xử lý sự kiện bấm Nút (Bubble Action Callbacks)

// Callback Tải trực tiếp về Telegram
bot.action(/^dl_link:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏬ Đang tải media về Telegram...');
  const encodedUrl = ctx.match[1];
  try {
    const rawUrl = Buffer.from(encodedUrl, 'base64url').toString('utf8');
    return processAndSendMedia(ctx, rawUrl);
  } catch (err) {
    return ctx.reply('❌ Link tải không hợp lệ.');
  }
});

// Search site Callbacks
bot.action(/^src_site:(.+)$/, async (ctx) => {
  const siteId = ctx.match[1];
  await ctx.answerCbQuery();

  if (siteId === 'all') {
    return ctx.reply(SEARCH_TITLE_PROMPT, {
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: 'Ví dụ: tiên nghịch'
      }
    });
  }

  const targets = loadTargets();
  const target = targets.find(t => t.id === siteId);
  const siteName = target ? target.name : siteId;

  return ctx.reply(`🔍 <b>[${escapeHtml(siteName)}]</b> Nhập tên phim hoặc truyện cần tìm trên trang này:`, {
    parse_mode: 'HTML',
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: `Tìm trên ${siteName}...`
    }
  });
});

// 1. Xóa 1 website cụ thể
bot.action(/^del:([a-zA-Z0-9_]+)$/, async (ctx) => {
  const targetId = ctx.match[1];
  let targets = loadTargets();
  const targetToDelete = targets.find(t => t.id === targetId);

  if (!targetToDelete) {
    return ctx.answerCbQuery('⚠️ Website này đã bị xóa trước đó.', { show_alert: true });
  }

  targets = targets.filter(t => t.id !== targetId);
  saveTargets(targets);

  await ctx.answerCbQuery(`✅ Đã xóa ${targetToDelete.name}!`);

  const updatedKeyboard = buildDeleteKeyboard();
  if (updatedKeyboard) {
    return ctx.editMessageReplyMarkup(updatedKeyboard.reply_markup).catch(() => {});
  } else {
    return ctx.editMessageText('✅ Tất cả website đã được xóa khỏi danh sách theo dõi.', { parse_mode: 'HTML' }).catch(() => {});
  }
});

// 2. Xác nhận xóa tất cả
bot.action('del_confirm_all', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.editMessageText('⚠️ <b>XÁC NHẬN:</b> Bạn có chắc chắn muốn XÓA TẤT CẢ website trong danh sách không?', {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Đồng ý xóa hết', callback_data: 'del_all_yes' },
          { text: '❌ Hủy', callback_data: 'del_all_no' }
        ]
      ]
    }
  });
});

bot.action('del_all_yes', async (ctx) => {
  saveTargets([]);
  await ctx.answerCbQuery('Đã xóa tất cả!', { show_alert: true });
  return ctx.editMessageText('🗑️ <b>Đã xóa toàn bộ danh sách website theo dõi.</b>', { parse_mode: 'HTML' });
});

bot.action('del_all_no', async (ctx) => {
  await ctx.answerCbQuery('Đã hủy');
  const deleteKeyboard = buildDeleteKeyboard();
  if (deleteKeyboard) {
    return ctx.editMessageText('🗑️ <b>Bấm vào nút bên dưới để chọn website cần xóa:</b>', {
      parse_mode: 'HTML',
      ...deleteKeyboard
    });
  }
  return ctx.editMessageText('⚠️ Danh sách theo dõi trống.');
});

// 3. Menu tương tác từ /list
bot.action('act:research', async (ctx) => {
  await ctx.answerCbQuery('🔎 Đang tiến hành quét...');
  await ctx.reply('🔎 Đang tiến hành quét và nghiên cứu các website trong danh sách...');
  await runWebsiteResearch(bot, [String(ctx.chat.id)]);
});

bot.action('act:dl_prompt', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(DOWNLOAD_INPUT_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: 'Dán link phim/truyện vào đây...'
    }
  });
});

bot.action('act:search_menu', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('🔍 <b>Chọn trang web bạn muốn tìm kiếm hoặc nhập từ khóa:</b>', {
    parse_mode: 'HTML',
    ...buildSearchSiteKeyboard()
  });
});

bot.action('act:add_prompt', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(ADD_INPUT_PROMPT, {
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: 'Ví dụ: https://phimmoi.com'
    }
  });
});

bot.action('act:del_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const deleteKeyboard = buildDeleteKeyboard();
  if (!deleteKeyboard) {
    return ctx.reply('⚠️ Danh sách theo dõi hiện đang trống, không có website nào để xóa.');
  }

  return ctx.reply('🗑️ <b>Bấm vào nút bên dưới để chọn website cần xóa:</b>', {
    parse_mode: 'HTML',
    ...deleteKeyboard
  });
});

// Xử lý ForceReply tin nhắn
bot.on('text', async (ctx, next) => {
  const replyText = String(ctx.message?.reply_to_message?.text || '').trim();
  const inputText = String(ctx.message?.text || '').trim();

  if (replyText === ADD_INPUT_PROMPT) {
    if (!inputText || inputText.startsWith('/')) {
      return ctx.reply('⚠️ Hãy nhập URL hoặc tên website cần theo dõi.');
    }
    return runAddTarget(ctx, inputText);
  }

  if (replyText === DOWNLOAD_INPUT_PROMPT) {
    if (!inputText || inputText.startsWith('/')) {
      return ctx.reply('⚠️ Hãy nhập link phim/truyện cần tải.');
    }
    return processAndSendMedia(ctx, inputText);
  }

  if (replyText === SEARCH_TITLE_PROMPT) {
    if (!inputText || inputText.startsWith('/')) {
      return ctx.reply('⚠️ Hãy nhập tên phim hoặc truyện cần tìm.');
    }
    return runTitleSearch(ctx, inputText, null);
  }

  if (/🔍\s*\[(.*?)\]\s*Nhập tên phim hoặc truyện cần tìm/i.test(replyText)) {
    const match = replyText.match(/🔍\s*\[(.*?)\]/);
    const siteName = match ? match[1] : null;
    if (!inputText || inputText.startsWith('/')) {
      return ctx.reply('⚠️ Hãy nhập tên phim hoặc truyện cần tìm.');
    }
    return runTitleSearch(ctx, inputText, siteName);
  }

  return next();
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
