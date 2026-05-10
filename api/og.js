// api/og.js — Vercel Serverless Function
// 後端代理：抓取蝦皮商品的 OG 圖片，繞過前端 CORS 限制
// 快取 24 小時，減少重複請求

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');

  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // 只允許蝦皮相關網域，防止濫用
  const allowed = ['shopee.tw', 's.shopee.tw', 'shopee.com.tw'];
  let targetUrl = url;
  try {
    const parsed = new URL(url);
    if (!allowed.some(d => parsed.hostname.endsWith(d))) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // 模擬 Facebook 爬蟲 User-Agent（蝦皮會對爬蟲回傳 SSR 完整 HTML）
  const UA_LIST = [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  ];
  const ua = UA_LIST[Math.floor(Math.random() * UA_LIST.length)];

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });

    if (!response.ok) {
      return res.status(200).json({ image: '', title: '', description: '', status: response.status });
    }

    const html = await response.text();

    // 提取 OG meta tags（支援多種屬性順序格式）
    function getOG(prop) {
      // 格式一：property="og:image" content="..."
      let m = html.match(new RegExp(
        `<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'
      ));
      if (m) return decodeHTML(m[1]);
      // 格式二：content="..." property="og:image"
      m = html.match(new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'
      ));
      return m ? decodeHTML(m[1]) : '';
    }

    function decodeHTML(str) {
      return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
    }

    const image       = getOG('og:image');
    const title       = getOG('og:title');
    const description = getOG('og:description');

    // 也嘗試抓 JSON-LD 中的圖片（部分蝦皮頁面用這種格式）
    let ldImage = '';
    const ldMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        ldImage = ld?.image?.[0] || ld?.image || '';
      } catch {}
    }

    const finalImage = image || ldImage;

    return res.status(200).json({
      image: finalImage,
      title,
      description,
      cached: false,
    });

  } catch (err) {
    console.error('OG fetch error:', err.message);
    return res.status(200).json({
      image: '',
      title: '',
      description: '',
      error: err.message,
    });
  }
}
