const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const cron = require('node-cron');

const TARGETS_FILE = path.join(__dirname, 'targets.json');

// Khởi tạo file targets.json nếu chưa tồn tại
if (!fs.existsSync(TARGETS_FILE)) {
  const defaultTargets = [
    {
      id: "phim1",
      name: "PhimMoi",
      url: "https://phimmoichill.net",
      searchKeyword: "phimmoichill domain moi nhat",
      enabled: true
    },
    {
      id: "truyen1",
      name: "NetTruyen",
      url: "https://nettruyen.live",
      searchKeyword: "nettruyen domain moi nhat",
      enabled: true
    }
  ];
  fs.writeFileSync(TARGETS_FILE, JSON.stringify(defaultTargets, null, 2), 'utf8');
}

function loadTargets() {
  try {
    const data = fs.readFileSync(TARGETS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Lỗi khi đọc targets.json:', err.message);
    return [];
  }
}

function saveTargets(targets) {
  try {
    fs.writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Lỗi khi lưu targets.json:', err.message);
    return false;
  }
}

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const httpConfig = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
  },
  timeout: 12000,
  maxRedirects: 5,
  httpsAgent: new https.Agent({ rejectUnauthorized: false })
};

// Tìm kiếm domain thay thế mới nhất qua DuckDuckGo khi domain chính bị sập
async function searchLatestMirrorDomain(searchKeyword) {
  try {
    const query = encodeURIComponent(searchKeyword);
    const response = await axios.get(`https://html.duckduckgo.com/html/?q=${query}`, httpConfig);
    const $ = cheerio.load(response.data);
    const discoveredUrls = [];

    $('.result__a, .result-link').each((_, element) => {
      const rawHref = $(element).attr('href');
      if (!rawHref) return;

      try {
        const parsedUrl = new URL(rawHref, 'https://duckduckgo.com');
        const uddg = parsedUrl.searchParams.get('uddg');
        const finalUrl = uddg ? decodeURIComponent(uddg) : parsedUrl.href;
        if (/^https?:\/\//i.test(finalUrl) && !finalUrl.includes('duckduckgo.com')) {
          discoveredUrls.push(finalUrl);
        }
      } catch (_) {}
    });

    return discoveredUrls.slice(0, 3);
  } catch (error) {
    console.warn(`Lỗi khi tìm domain thay thế cho "${searchKeyword}":`, error.message);
    return [];
  }
}

// Kiểm tra 1 website target
async function checkWebsiteTarget(target) {
  const result = {
    name: target.name,
    originalUrl: target.url,
    status: 'UNKNOWN',
    finalUrl: target.url,
    latestUpdates: [],
    suggestedMirrors: [],
    errorMsg: null
  };

  try {
    const response = await axios.get(target.url, httpConfig);
    const resolvedUrl = response.request?.res?.responseUrl || target.url;
    result.finalUrl = resolvedUrl;
    result.status = 'ONLINE';

    const $ = cheerio.load(response.data);

    // Trích xuất các liên kết mới nhất (ví dụ: tập mới, chương mới)
    const updatesSet = new Set();
    $('a[href]').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const href = $(el).attr('href');

      if (text && href && /(tập|chap|chương|episode|season|\b\d+\b)/i.test(text) && text.length < 60) {
        try {
          const absUrl = new URL(href, resolvedUrl).href;
          updatesSet.add({ title: text, url: absUrl });
        } catch (_) {}
      }
    });

    result.latestUpdates = Array.from(updatesSet).slice(0, 4);
  } catch (error) {
    result.status = 'OFFLINE';
    result.errorMsg = error.code === 'ENOTFOUND' ? 'Domain bị sập (DNS Error)' : (error.message || 'Không thể truy cập');

    // Thử tìm domain thay thế mới
    if (target.searchKeyword) {
      result.suggestedMirrors = await searchLatestMirrorDomain(target.searchKeyword);
    }
  }

  return result;
}

// Thực thi quét toàn bộ danh sách website & gửi báo cáo Telegram
async function runWebsiteResearch(bot, adminChatIds) {
  const targets = loadTargets().filter(t => t.enabled !== false);
  if (targets.length === 0) {
    console.log('Không có website nào trong danh sách theo dõi.');
    return;
  }

  console.log(`[Research Tracker] Bắt đầu quét ${targets.length} website...`);

  const nowStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Bangkok' });
  const lines = [
    '🌐 <b>[BÁO CÁO CẬP NHẬT WEBSITE HÀNG NGÀY - 07:00 AM]</b>',
    `🕒 <i>Thời gian thực hiện: ${nowStr}</i>`,
    ''
  ];

  for (const target of targets) {
    lines.push(`📌 <b>${escapeHtml(target.name)}</b>`);

    const res = await checkWebsiteTarget(target);
    if (res.status === 'ONLINE') {
      lines.push(`• <b>Trạng thái:</b> 🟢 <code>ONLINE</code>`);
      lines.push(`• <b>URL:</b> <a href="${escapeHtml(res.finalUrl)}">${escapeHtml(res.finalUrl)}</a>`);

      if (res.latestUpdates.length > 0) {
        lines.push(`• <b>Cập nhật mới nhất:</b>`);
        res.latestUpdates.forEach(item => {
          lines.push(`  - <a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>`);
        });
      } else {
        lines.push(`• <i>Không trích xuất được bài mới tự động.</i>`);
      }
    } else {
      lines.push(`• <b>Trạng thái:</b> 🔴 <code>OFFLINE / BỊ SẬP</code> (${escapeHtml(res.errorMsg)})`);
      lines.push(`• <b>URL cũ:</b> <code>${escapeHtml(res.originalUrl)}</code>`);

      if (res.suggestedMirrors.length > 0) {
        lines.push(`• 🔄 <b>Gợi ý domain thay thế mới phát hiện:</b>`);
        res.suggestedMirrors.forEach(mirror => {
          lines.push(`  - <a href="${escapeHtml(mirror)}">${escapeHtml(mirror)}</a>`);
        });
      } else {
        lines.push(`• ⚠️ <i>Chưa tìm thấy domain thay thế tự động.</i>`);
      }
    }
    lines.push('');
  }

  const messageText = lines.join('\n').slice(0, 4000);

  try {
    await Promise.all(
      adminChatIds.map(chatId => bot.telegram.sendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true }
      }))
    );
    console.log('[Research Tracker] Đã gửi báo cáo Telegram thành công!');
  } catch (err) {
    console.error('[Research Tracker] Lỗi khi gửi báo cáo Telegram:', err.message);
  }
}

// Cấu hình Cron Job chạy lúc 07:00 AM hàng ngày (Múi giờ Asia/Ho_Chi_Minh)
function initScheduler(bot, adminChatIds) {
  console.log('⏰ Đã kích hoạt Cron Job quét Website hàng ngày vào lúc 07:00 AM (Asia/Ho_Chi_Minh)');

  cron.schedule('0 7 * * *', async () => {
    console.log('⏰ Kích hoạt lịch quét 07:00 AM...');
    await runWebsiteResearch(bot, adminChatIds);
  }, {
    scheduled: true,
    timezone: 'Asia/Ho_Chi_Minh'
  });
}

module.exports = {
  loadTargets,
  saveTargets,
  runWebsiteResearch,
  initScheduler
};
