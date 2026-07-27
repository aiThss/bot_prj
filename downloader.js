const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const httpConfig = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
  },
  timeout: 30000,
  maxRedirects: 5,
  httpsAgent: new https.Agent({ rejectUnauthorized: false })
};

// Trích xuất Media (Video / Ảnh tập truyện) từ URL trang web
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
      // Regex match file .mp4 hoặc .m3u8 trực tiếp trong mã HTML/Javascript
      const mp4Match = html.match(/https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*/i);
      const m3u8Match = html.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i);
      if (mp4Match) videoUrl = mp4Match[0];
      else if (m3u8Match) videoUrl = m3u8Match[0];
    }

    // 2. Trích xuất danh sách Ảnh Chương Truyện (Manga/Comic Pages)
    const images = [];
    $('.page-chapter img, .reading-detail img, .vng-comic-reading img, .container-chapter img, .chapter-content img, .read-content img').each((_, el) => {
      let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original') || $(el).attr('data-cdn');
      if (src) {
        src = src.trim();
        if (src.startsWith('//')) src = 'https:' + src;
        if (/^https?:\/\//i.test(src) && !src.includes('logo') && !src.includes('banner') && !src.includes('icon')) {
          try {
            const absImgUrl = new URL(src, resolvedUrl).href;
            images.push(absImgUrl);
          } catch (_) {}
        }
      }
    });

    return {
      success: true,
      title,
      resolvedUrl,
      type: videoUrl ? 'video' : (images.length > 0 ? 'manga' : 'page'),
      videoUrl,
      images: Array.from(new Set(images)).slice(0, 10) // Lấy tối đa 10 ảnh gửi theo Album
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
  const statusMsg = await ctx.reply('⏬ <b>Đang trích xuất media và tải về Telegram cho bạn...</b>', { parse_mode: 'HTML' });

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
          caption: `🎬 <b>${mediaInfo.title}</b>\n🔗 <a href="${mediaInfo.resolvedUrl}">Xem gốc</a>`,
          parse_mode: 'HTML'
        });
      } else {
        // Luồng stream HLS .m3u8 -> Gửi link stream m3u8 kèm player trực tiếp
        return ctx.reply([
          `🎬 <b>${mediaInfo.title}</b>`,
          '',
          `📥 <b>Luồng Video Stream (.m3u8):</b>`,
          `<code>${mediaInfo.videoUrl}</code>`,
          '',
          `💡 <i>Bạn có thể bấm vào link trên để Telegram Desktop phát trực tiếp hoặc tải qua IDM.</i>`
        ].join('\n'), { parse_mode: 'HTML' });
      }
    }

    // B. Gửi Album Ảnh Chương Truyện trực tiếp vào Telegram Chat
    if (mediaInfo.type === 'manga' && mediaInfo.images.length > 0) {
      await ctx.reply(`📚 <b>Đang tải trọn bộ ${mediaInfo.images.length} trang truyện vào Telegram...</b>`, { parse_mode: 'HTML' });

      const mediaGroup = mediaInfo.images.map((imgUrl, index) => ({
        type: 'photo',
        media: imgUrl,
        caption: index === 0 ? `📚 <b>${mediaInfo.title}</b>` : undefined,
        parse_mode: 'HTML'
      }));

      return ctx.replyWithMediaGroup(mediaGroup);
    }

    // C. Trường hợp là trang web xem trực tuyến thông thường
    return ctx.reply([
      `📄 <b>${mediaInfo.title}</b>`,
      `🌐 <b>URL:</b> ${mediaInfo.resolvedUrl}`,
      '',
      `⚠️ <i>Trang web này chưa hỗ trợ trích xuất luồng MP4/Ảnh trực tiếp tự động. Bạn hãy mở link để xem trực tuyến trên Telegram.</i>`
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
