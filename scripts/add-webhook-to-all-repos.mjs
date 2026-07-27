import axios from 'axios';

/**
 * Script tự động thêm Webhook vào TẤT CẢ các Repository GitHub của bạn.
 * 
 * Cách dùng:
 * 1. Lấy Personal Access Token từ GitHub: Settings -> Developer Settings -> Personal access tokens (Tokens classic) -> Chọn quyền 'repo' & 'admin:repo_hook'.
 * 2. Chạy lệnh:
 *    node scripts/add-webhook-to-all-repos.mjs <GITHUB_TOKEN> <WEBHOOK_URL>
 * 
 * Ví dụ:
 *    node scripts/add-webhook-to-all-repos.mjs ghp_xxxxxx https://bot-prj.yourdomain.com/webhook/github
 */

const [token, webhookUrl] = process.argv.slice(2);

if (!token || !webhookUrl) {
  console.error('❌ Thiếu tham số!');
  console.log('👉 Cách dùng: node scripts/add-webhook-to-all-repos.mjs <GITHUB_TOKEN> <WEBHOOK_URL>');
  process.exit(1);
}

const headers = {
  'Authorization': `token ${token}`,
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'Bot-Prj-Webhook-Setup'
};

async function main() {
  try {
    console.log('🔍 Đang lấy danh sách các repository...');
    const reposResponse = await axios.get('https://api.github.com/user/repos?per_page=100&type=owner', { headers });
    const repos = reposResponse.data;

    console.log(`📌 Tìm thấy ${repos.length} repository.`);

    for (const repo of repos) {
      const repoFullName = repo.full_name;
      console.log(`\n⏳ Đang kiểm tra repo: ${repoFullName}...`);

      try {
        // Lấy danh sách hooks hiện có
        const hooksResponse = await axios.get(`https://api.github.com/repos/${repoFullName}/hooks`, { headers });
        const existingHooks = hooksResponse.data || [];

        const isAlreadyAdded = existingHooks.some(hook => hook.config?.url === webhookUrl);

        if (isAlreadyAdded) {
          console.log(`  ✅ Webhook đã tồn tại trong ${repoFullName}. Bỏ qua.`);
          continue;
        }

        // Tạo webhook mới
        await axios.post(`https://api.github.com/repos/${repoFullName}/hooks`, {
          name: 'web',
          active: true,
          events: ['push'],
          config: {
            url: webhookUrl,
            content_type: 'json',
            insecure_ssl: '0'
          }
        }, { headers });

        console.log(`  🎉 Đã thêm Webhook thành công vào ${repoFullName}!`);
      } catch (err) {
        console.error(`  ❌ Lỗi khi thêm Webhook vào ${repoFullName}:`, err.response?.data?.message || err.message);
      }
    }

    console.log('\n✨ Hoàn thành tự động thêm Webhook cho tất cả các repository!');
  } catch (err) {
    console.error('❌ Lỗi kết nối GitHub API:', err.response?.data?.message || err.message);
  }
}

main();
