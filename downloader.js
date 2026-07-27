const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

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

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Trích xuất Media (Video / Tất cả ảnh tập truyện) từ URL trang web
async function extractMediaFromUrl(targetUrl) {
  let urlStr = String(targetUrl || '').trim();
  if (!/^https?:\/\//i.test(urlStr)) urlStr = 'https://' + urlStr;

  try {
    const response = await axios.get(urlStr, httpConfig);
    const resolvedUrl = response.request?.res?.responseUrl || urlStr;
    const html = response.data;
    const $ = cheerio.load(html);

    const title = $('title').text().replace(/\s+/g, ' ').trim() || 'Media Telegram';

    // 1. Kiểm tra Video Tags & Embed Source (.mp4, .m3u8, video src)
    let videoUrl = null;
    $('video source, video, iframe').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && (src.includes('.mp4') || src.includes('.m3u8'))) {
        try {
          videoUrl = new URL(src, resolvedUrl).href;
        } catch (_) {}
      }
    });

    if (!videoUrl) {
      const mp4Match = html.match(/https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*/i);
      const m3u8Match = html.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
      if (mp4Match) videoUrl = mp4Match[0];
      else if (m3u8Match) videoUrl = m3u8Match[0];
    }

    // 2. Trích xuất tất cả Ảnh Chương Truyện (FoxTruyen, NetTruyen, TruyenQQ, MangaDex...)
    const imagesSet = new Set();
    const selectors = [
      '.chapter-content img', '#chapter-content img', '.reading-detail img',
      '.page-chapter img', '.vng-comic-reading img', '.container-chapter img',
      '.read-content img', '.box-chap img', '.content-chap img', '.reading img',
      '.comic-content img', '.viewer-content img', 'div[class*="chap"] img',
      'div[id*="chap"] img', 'div[class*="read"] img', 'div[class*="story"] img'
    ];

    selectors.forEach(selector => {
      $(selector).each((_, el) => {
        let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original') || $(el).attr('data-cdn') || $(el).attr('data-lazy-src') || $(el).attr('data-url');
        if (src) {
          src = src.trim();
          if (src.startsWith('//')) src = 'https:' + src;
          if (/^https?:\/\//i.test(src) && !/logo|banner|icon|avatar|gif|fb|facebook|ads|qc/i.test(src)) {
            try {
              const absImgUrl = new URL(src, resolvedUrl).href;
              imagesSet.add(absImgUrl);
            } catch (_) {}
          }
        }
      });
    });

    // Fallback nếu không khớp selector cụ thể: lấy tất cả img hợp lệ trong trang
    if (imagesSet.size === 0 && !videoUrl) {
      $('img').each((_, el) => {
        let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original');
        if (src) {
          src = src.trim();
          if (src.startsWith('//')) src = 'https:' + src;
          if (/^https?:\/\//i.test(src) && !/logo|banner|icon|avatar|gif|fb|facebook|ads|qc/i.test(src)) {
            try {
              const absImgUrl = new URL(src, resolvedUrl).href;
              imagesSet.add(absImgUrl);
            } catch (_) {}
          }
        }
      });
    }

    const allImages = Array.from(imagesSet);

    return {
      success: true,
      title,
      resolvedUrl,
      type: videoUrl ? 'video' : (allImages.length > 0 ? 'manga' : 'page'),
      videoUrl,
      images: allImages // Trả về tất cả các trang ảnh của chap
    };
  } catch (error) {
    console.error('Lỗi trích xuất media từ URL:', error.message);
    return {
      success: false,
      errorMsg: error.message || 'Không thể truy cập đường dẫn web.'
    };
  }
}

// Xử lý gửi trực tiếp Media vào Telegram Chat
async function processAndSendMedia(ctx, targetUrl) {
  const statusMsg = await ctx.reply('⏬ <b>Đang trích xuất toàn bộ trang truyện/video về Telegram cho bạn...</b>', { parse_mode: 'HTML' });

  try {
    const mediaInfo = await extractMediaFromUrl(targetUrl);
    await ctx.deleteMessage(statusMsg.message_id).catch(() => {});

    if (!mediaInfo.success) {
      return ctx.reply(`❌ Lỗi: ${mediaInfo.errorMsg}`);
    }

    // A. Gửi Video trực tiếp vào Telegram Chat
    if (mediaInfo.type === 'video' && mediaInfo.videoUrl) {
      if (mediaInfo.videoUrl.includes('.mp4')) {
        await ctx.reply('🎬 <b>Đang tải video trực tiếp về Telegram...</b>', { parse_mode: 'HTML' });
        return ctx.replyWithVideo(mediaInfo.videoUrl, {
          caption: `🎬 <b>${escapeHtml(mediaInfo.title)}</b>\n🔗 <a href="${mediaInfo.resolvedUrl}">Xem gốc</a>`,
          parse_mode: 'HTML'
        });
      } else {
        return ctx.reply([
          `🎬 <b>${escapeHtml(mediaInfo.title)}</b>`,
          '',
          `📥 <b>Luồng Video Stream (.m3u8):</b>`,
          `<code>${mediaInfo.videoUrl}</code>`,
          '',
          `💡 <i>Bạn có thể bấm vào link trên để Telegram phát trực tiếp hoặc tải qua IDM.</i>`
        ].join('\n'), { parse_mode: 'HTML' });
      }
    }

    // B. Gửi Album Tất Cả Trang Truyện (MediaGroup) trực tiếp vào Telegram Chat
    if (mediaInfo.type === 'manga' && mediaInfo.images.length > 0) {
      const total = mediaInfo.images.length;
      await ctx.reply(`📚 <b>Đang tải trọn bộ ${total} trang truyện vào Telegram chat...</b>`, { parse_mode: 'HTML' });

      // Telegram cho phép gửi tối đa 10 ảnh / 1 Album (MediaGroup)
      const chunkSize = 10;
      for (let i = 0; i < mediaInfo.images.length; i += chunkSize) {
        const chunk = mediaInfo.images.slice(i, i + chunkSize);
        const mediaGroup = chunk.map((imgUrl, idx) => ({
          type: 'photo',
          media: imgUrl,
          caption: (i === 0 && idx === 0) ? `📚 <b>${escapeHtml(mediaInfo.title)}</b>\n<i>(Tổng cộng ${total} trang)</i>` : undefined,
          parse_mode: 'HTML'
        }));

        await ctx.replyWithMediaGroup(mediaGroup).catch(err => {
          console.warn(`Lỗi khi gửi batch ảnh ${i + 1}-${i + chunk.length}:`, err.message);
        });
      }

      return;
    }

    // C. Trường hợp không tìm thấy media trực tiếp
    return ctx.reply([
      `📄 <b>${escapeHtml(mediaInfo.title)}</b>`,
      `🌐 <b>URL:</b> ${mediaInfo.resolvedUrl}`,
      '',
      `⚠️ <i>Không trích xuất được file media trực tiếp. Bạn hãy mở đường dẫn trên để xem.</i>`
    ].join('\n'), { parse_mode: 'HTML' });

  } catch (err) {
    await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
    console.error('Lỗi khi tải media về Telegram:', err);
    return ctx.reply('❌ Đã xảy ra lỗi khi trích xuất và tải media về Telegram.');
  }
}

module.exports = {
  extractMediaFromUrl,
  processAndSendMedia
};
