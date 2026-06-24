// api/apify-start.js — lanza el run de Apify y devuelve runId de inmediato
// El browser hace polling a /api/apify-status para saber cuando termina
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, searchQuery, _apifyKey } = req.body || {};
  const APIFY_KEY = _apifyKey || process.env.APIFY_API_KEY;

  if (!APIFY_KEY) return res.status(500).json({ error: 'APIFY_API_KEY no configurada' });
  if (!url && !searchQuery) return res.status(400).json({ error: 'Falta URL o searchQuery' });

  const input = url
    ? { startUrls: [{ url }], maxCrawledPlacesPerSearch: 1 }
    : { searchStringsArray: [searchQuery], maxCrawledPlacesPerSearch: 20, language: 'es', countryCode: 'ar' };

  try {
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );

    if (!runRes.ok) {
      const err = await runRes.text();
      return res.status(runRes.status).json({ error: `Apify error ${runRes.status}: ${err.substring(0, 200)}` });
    }

    const runData = await runRes.json();
    const runId = runData.data?.id;
    if (!runId) return res.status(500).json({ error: 'Apify no devolvio runId' });

    return res.json({ ok: true, runId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
