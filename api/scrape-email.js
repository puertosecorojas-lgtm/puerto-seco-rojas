export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { web, company } = req.body || {};
  if (!web) return res.status(400).json({ error: 'Falta URL del sitio web' });

  const urls = [];
  try {
    const base = web.startsWith('http') ? web : 'https://' + web;
    urls.push(base);
    urls.push(base.replace(/\/$/, '') + '/contacto');
    urls.push(base.replace(/\/$/, '') + '/contact');
    urls.push(base.replace(/\/$/, '') + '/contactenos');
    urls.push(base.replace(/\/$/, '') + '/about');

    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const found = new Set();

    for (const url of urls) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0)' },
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) continue;
        const html = await r.text();
        const emails = html.match(emailRegex) || [];
        emails.forEach(e => {
          const lower = e.toLowerCase();
          if (!lower.includes('example') && !lower.includes('sentry') &&
              !lower.includes('domain') && !lower.includes('.png') &&
              !lower.includes('.jpg') && !lower.includes('noreply')) {
            found.add(lower);
          }
        });
        if (found.size > 0) break;
      } catch (e) { continue; }
    }

    const emails = [...found];
    return res.json({ emails, best: emails[0] || null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
