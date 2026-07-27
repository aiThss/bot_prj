const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const cron = require('node-cron');

const TARGETS_FILE = path.join(__dirname, 'targets.json');

// Khởi tạo file targets.json nếu chưa tồn tại (Mặc định mảng rỗng, KHÔNG tự ý chèn dữ liệu mẫu)
if (!fs.existsSync(TARGETS_FILE)) {
  fs.writeFileSync(TARGETS_FILE, JSON.stringify([], null, 2), 'utf8');
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
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
  },
  timeout: 30000,
  maxRedirects: 5,
  httpsAgent: new https.Agent({ rejectUnauthorized: false })
};

// Gọi Gemini API tương thích cả v1 và v1beta endpoints cho gemini-1.5-flash
async function callGeminiApi(prompt) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return { success: false, error: 'GEMINI_API_KEY chưa được cấu hình trong biến môi trường Dokploy.' };
  }

  const endpoints = [
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`
  ];

  const errors = [];

  for (const url of endpoints) {
    try {
      const response = await axios.post(
        url,
        { contents: [{ parts: [{ text: prompt }] }] },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );

      const generatedText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (generatedText) {
        const modelMatch = url.match(/models\/([^:]+):/);
        const modelName = modelMatch ? modelMatch[1] : 'gemini-1.5-flash';
        return { success: true, text: generatedText.trim(), model: modelName };
      }
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      errors.push(msg);
      console.warn(`Lỗi khi gọi Gemini API URL (${url.split('?')[0]}):`, msg);
    }
  }

  return {
    success: false,
    error: errors.join(' | ') || 'Khủng thể kết nối Gemini API'
  };
}

// Tự động theo vết link rút gọn (như bit.ly/hh3d) để lấy URL / Domain đích thực tế
async function resolveDestinationUrl(inputUrl) {
  let target = String(inputUrl || '').trim();
  if (!target) return null;
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  try {
    const response = await axios.get(target, httpConfig);
    const finalUrl = response.request?.res?.responseUrl || target;
    return finalUrl;
  } catch (error) {
    return target;
  }
}

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

// Tìm kiếm trực tiếp trên thanh tìm kiếm nội bộ của trang web (Direct In-Site Search)
async function searchDirectOnSite(baseUrl, query) {
  const results = [];
  const encodedQuery = encodeURIComponent(query);
  const searchUrls = [
    `${baseUrl.replace(/\/$/, '')}/?s=${encodedQuery}`,
    `${baseUrl.replace(/\/$/, '')}/tim-kiem?q=${encodedQuery}`,
    `${baseUrl.replace(/\/$/, '')}/search?keyword=${encodedQuery}`,
    `${baseUrl.replace(/\/$/, '')}/tim-truyen?keyword=${encodedQuery}`
  ];

  for (const searchUrl of searchUrls) {
    try {
      const response = await axios.get(searchUrl, httpConfig);
      const resolvedUrl = response.request?.res?.responseUrl || baseUrl;
      const $ = cheerio.load(response.data);

      const itemsSet = new Set();
      $('a[href]').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const href = $(el).attr('href');

        if (!text || !href || href.startsWith('#') || href.startsWith('javascript:')) return;

        const lowerText = text.toLowerCase();
        const lowerQuery = query.toLowerCase();
        const words = lowerQuery.split(/\s+/).filter(w => w.length > 1);

        const matchesQuery = lowerText.includes(lowerQuery) || words.every(w => lowerText.includes(w));

        if (matchesQuery && text.length < 80) {
          try {
            const absUrl = new URL(href, resolvedUrl).href;
            itemsSet.add({ title: text, url: absUrl });
          } catch (_) {}
        }
      });

      if (itemsSet.size > 0) {
        Array.from(itemsSet).slice(0, 5).forEach(item => {
          results.push(item);
        });
        break;
      }
    } catch (_) {}
  }

  return results;
}

// AI Dự đoán từ khóa & Tìm kiếm Phim/Truyện trực tiếp trên Web Cụ Thể
async function searchMovieOrManga(query, siteFilter = null) {
  let searchKeyword = query.trim();
  const allTargets = loadTargets().filter(t => t.enabled !== false);
  let selectedTargets = allTargets;

  if (siteFilter) {
    const filterLower = siteFilter.toLowerCase();
    const matched = allTargets.filter(t =>
      t.id.toLowerCase() === filterLower ||
      t.name.toLowerCase().includes(filterLower) ||
      t.url.toLowerCase().includes(filterLower)
    );
    if (matched.length > 0) {
      selectedTargets = matched;
    }
  }

  // BƯỚC 1: Dùng AI Gemini để chuẩn hóa & dự đoán từ khóa chuẩn nhất
  const prompt = `Bạn là một AI chuyên môn tìm kiếm phim và truyện. Người dùng nhập từ khóa tìm kiếm: "${query}".
Hãy đưa ra 1 cụm từ khóa tiếng Việt chuẩn nhất để tìm kiếm tập phim hoặc chương truyện mới nhất trên các trang web phim/truyện.
Chỉ trả về duy nhất chuỗi từ khóa tìm kiếm tối ưu nhất (tối đa 8 từ), không giải thích.`;

  const aiResult = await callGeminiApi(prompt);
  if (aiResult.success && aiResult.text) {
    searchKeyword = aiResult.text.replace(/^["']|["']$/g, '');
  }

  const results = [];
  const seenUrls = new Set();

  // BƯỚC 2: Tìm kiếm trực tiếp trên các Web cụ thể
  for (const target of selectedTargets) {
    const resolvedBaseUrl = await resolveDestinationUrl(target.url);
    let hostname = resolvedBaseUrl;
    try {
      hostname = new URL(resolvedBaseUrl).hostname.replace(/^www\./, '');
    } catch (_) {}

    // A. Thử tìm trực tiếp qua form tìm kiếm nội bộ của trang web (Direct In-Site Search)
    const directResults = await searchDirectOnSite(resolvedBaseUrl, query);
    directResults.forEach(item => {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        results.push({
          siteName: target.name,
          title: item.title,
          url: item.url,
          snippet: `Trích xuất trực tiếp từ ${target.name} (${hostname})`
        });
      }
    });

    // B. Tìm kiếm qua DuckDuckGo kèm site filter của domain đã giải mã
    const queriesToTry = [`site:${hostname} ${query}`, `site:${hostname} ${searchKeyword}`];
    for (const qStr of queriesToTry) {
      try {
        const response = await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(qStr)}`, httpConfig);
        const $ = cheerio.load(response.data);

        $('.result, .results_links').each((_, element) => {
          const linkEl = $(element).find('.result__a, .result-link').first();
          const title = linkEl.text().replace(/\s+/g, ' ').trim();
          const rawHref = linkEl.attr('href');
          const snippet = $(element).find('.result__snippet, .result-snippet').first().text().replace(/\s+/g, ' ').trim();

          if (!rawHref || !title) return;

          try {
            const parsedUrl = new URL(rawHref, 'https://duckduckgo.com');
            const uddg = parsedUrl.searchParams.get('uddg');
            const finalUrl = uddg ? decodeURIComponent(uddg) : parsedUrl.href;

            if (/^https?:\/\//i.test(finalUrl) && !finalUrl.includes('duckduckgo.com') && !seenUrls.has(finalUrl)) {
              seenUrls.add(finalUrl);
              results.push({
                siteName: target.name,
                title,
                url: finalUrl,
                snippet
              });
            }
          } catch (_) {}
        });
      } catch (err) {
        console.warn(`Lỗi khi search site ${target.name}:`, err.message);
      }
    }
  }

  // BƯỚC 3: Fallback tìm kiếm chung nếu chưa có kết quả từ các site cụ thể
  if (results.length === 0) {
    try {
      const fallbackQuery = `${query} xem phim đọc truyện vietsub`;
      const response = await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(fallbackQuery)}`, httpConfig);
      const $ = cheerio.load(response.data);

      $('.result, .results_links').each((_, element) => {
        const linkEl = $(element).find('.result__a, .result-link').first();
        const title = linkEl.text().replace(/\s+/g, ' ').trim();
        const rawHref = linkEl.attr('href');
        const snippet = $(element).find('.result__snippet, .result-snippet').first().text().replace(/\s+/g, ' ').trim();

        if (!rawHref || !title) return;

        try {
          const parsedUrl = new URL(rawHref, 'https://duckduckgo.com');
          const uddg = parsedUrl.searchParams.get('uddg');
          const finalUrl = uddg ? decodeURIComponent(uddg) : parsedUrl.href;

          if (/^https?:\/\//i.test(finalUrl) && !finalUrl.includes('duckduckgo.com') && !seenUrls.has(finalUrl)) {
            seenUrls.add(finalUrl);
            results.push({
              siteName: 'Web Search',
              title,
              url: finalUrl,
              snippet
            });
          }
        } catch (_) {}
      });
    } catch (err) {
      console.error('Lỗi khi fallback search:', err.message);
    }
  }

  return {
    originalQuery: query,
    predictedKeyword: searchKeyword,
    siteFilter: siteFilter,
    results: results.slice(0, 8)
  };
}

// Kiểm tra 1 website target
async function checkWebsiteTarget(target) {
  const resolvedBaseUrl = await resolveDestinationUrl(target.url);
  const result = {
    name: target.name,
    originalUrl: target.url,
    status: 'UNKNOWN',
    finalUrl: resolvedBaseUrl,
    latestUpdates: [],
    suggestedMirrors: [],
    errorMsg: null
  };

  try {
    const response = await axios.get(resolvedBaseUrl, httpConfig);
    const resolvedUrl = response.request?.res?.responseUrl || resolvedBaseUrl;
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
  callGeminiApi,
  resolveDestinationUrl,
  checkWebsiteTarget,
  searchMovieOrManga,
  runWebsiteResearch,
  initScheduler
};
