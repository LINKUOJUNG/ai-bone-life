// api/og.js — Vercel Serverless Function
// 後端代理：抓取蝦皮商品 OG 圖片，多策略輪替提升成功率

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const allowed = ['shopee.tw', 's.shopee.tw'];
  try {
    const parsed = new URL(url);
    if (!allowed.some(d => parsed.hostname.endsWith(d))) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // 多種 User-Agent 輪替策略
  const UA_STRATEGIES = [
    // 策略1: Facebook 爬蟲（蝦皮會回傳 SSR HTML）
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    // 策略2: Googlebot
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    // 策略3: Twitterbot
    'Twitterbot/1.0',
    // 策略4: LINE 預覽爬蟲
    'Mozilla/5.0 (compatible; linepagebot/1.0; +https://line.me)',
    // 策略5: Slack 預覽
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  ];

  function decodeHTML(str) {
    return str
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  function extractOG(html) {
    function getOG(prop) {
      // 格式一：property="..." content="..."
      let m = html.match(new RegExp(
        `<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']{4,})["']`, 'i'
      ));
      if (m) return decodeHTML(m[1].trim());
      // 格式二：content="..." property="..."
      m = html.match(new RegExp(
        `<meta[^>]+content=["']([^"']{4,})["'][^>]+property=["']${prop}["']`, 'i'
      ));
      return m ? decodeHTML(m[1].trim()) : '';
    }

    // 也嘗試 twitter:image
    function getTwitter(prop) {
      let m = html.match(new RegExp(
        `<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']{4,})["']`, 'i'
      ));
      if (m) return decodeHTML(m[1].trim());
      m = html.match(new RegExp(
        `<meta[^>]+content=["']([^"']{4,})["'][^>]+name=["']${prop}["']`, 'i'
      ));
      return m ? decodeHTML(m[1].trim()) : '';
    }

    // 嘗試 JSON-LD
    let ldImage = '';
    const ldMatch = html.match(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        const imgVal = ld?.image?.[0] || ld?.image || '';
        if (typeof imgVal === 'string' && imgVal.startsWith('http')) ldImage = imgVal;
        else if (imgVal?.url) ldImage = imgVal.url;
      } catch {}
    }

    // 嘗試 Shopee 特有的 __NEXT_DATA__ JSON
    let nextImage = '';
    const nextMatch = html.match(/<script id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (nextMatch) {
      try {
        const next = JSON.parse(nextMatch[1]);
        const item = next?.props?.pageProps?.initialState?.itemReducer?.item;
        if (item?.images?.[0]) {
          nextImage = `https://cf.shopee.tw/file/${item.images[0]}_tn`;
        }
      } catch {}
    }

    // 嘗試直接找 cf.shopee.tw 圖片 URL
    const cfMatch = html.match(/https:\/\/cf\.shopee\.tw\/file\/[a-zA-Z0-9_]+/);
    const cfImage = cfMatch ? cfMatch[0] : '';

    const ogImage = getOG('og:image');
    const twImage = getTwitter('twitter:image');

    return {
      image: ogImage || twImage || ldImage || nextImage || cfImage,
      title: getOG('og:title') || getTwitter('twitter:title'),
      description: getOG('og:description') || getTwitter('twitter:description'),
    };
  }

  // 依序嘗試各種 UA 策略
  for (const ua of UA_STRATEGIES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate',
          'Cache-Control': 'no-cache',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1',
        },
      });

      clearTimeout(timeout);

      if (!response.ok) continue;

      const html = await response.text();
      const result = extractOG(html);

      if (result.image) {
        return res.status(200).json({ ...result, ua_used: ua.split('/')[0] });
      }
      // 有 HTML 但沒圖片，繼續下一個策略
    } catch (e) {
      // 逾時或網路錯誤，繼續下一個策略
      continue;
    }
  }

  // 所有策略都失敗
  return res.status(200).json({ image: '', title: '', description: '' });
}
