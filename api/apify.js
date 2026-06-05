// api/apify.js — scraper de Google Maps via Apify
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url, searchQuery, _apifyKey } = req.body || {};
  const APIFY_KEY = _apifyKey || process.env.APIFY_API_KEY;

  if (!APIFY_KEY) return res.status(500).json({ error: 'APIFY_API_KEY no configurada' });
  if (!url && !searchQuery) return res.status(400).json({ error: 'Falta URL o busqueda' });

  try {
    // Iniciar el actor de Google Maps de Apify
    const input = url
      ? { startUrls: [{ url }], maxCrawledPlacesPerSearch: 1 }
      : { searchStringsArray: [searchQuery], maxCrawledPlacesPerSearch: 20, language: 'es', countryCode: 'ar' };

    // Llamar al actor de Google Maps (georgelza/google-maps-scraper)
    const runRes = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    if (!runRes.ok) {
      const err = await runRes.text();
      return res.status(runRes.status).json({ error: `Apify error: ${err}` });
    }

    const runData = await runRes.json();
    const runId = runData.data?.id;
    if (!runId) return res.status(500).json({ error: 'No se pudo iniciar el scraper' });

    // Esperar a que termine (polling cada 3 segundos, max 60 segundos)
    let status = 'RUNNING';
    let attempts = 0;
    while (status === 'RUNNING' && attempts < 20) {
      await new Promise(r => setTimeout(r, 3000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_KEY}`);
      const statusData = await statusRes.json();
      status = statusData.data?.status;
      attempts++;
    }

    if (status !== 'SUCCEEDED') {
      return res.status(500).json({ error: `Scraper termino con estado: ${status}` });
    }

    // Obtener resultados
    const resultsRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_KEY}&limit=50`);
    const results = await resultsRes.json();

    // Mapear resultados al formato de leads
    const leads = (results || []).map(place => ({
      nombre:       place.title || '',
      empresa:      place.title || '',
      tipo:         clasificarTipo(place.categoryName || place.categories?.[0] || ''),
      ciudad:       extractCity(place.address || place.city || ''),
      zona:         mapZona(place.state || place.address || ''),
      email:        place.email || '',
      email_status: place.email ? 'sin_verificar' : 'sin_email',
      telefono:     place.phone || place.phoneUnformatted || '',
      web:          place.website || '',
      direccion:    place.address || '',
      fuente:       'apify_maps',
    })).filter(l => l.empresa);

    return res.json({ leads, total: leads.length });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

function clasificarTipo(category) {
  const c = category.toLowerCase();
  if (c.includes('aduana') || c.includes('despacho') || c.includes('despachante')) return 'despachante';
  if (c.includes('logistic') || c.includes('transporte') || c.includes('flete')) return 'operador_logistico';
  if (c.includes('import') || c.includes('export') || c.includes('comercio exterior')) return 'importador_exportador';
  if (c.includes('agro') || c.includes('grano') || c.includes('semilla') || c.includes('cereal')) return 'agro_industrial';
  if (c.includes('fabricant') || c.includes('industria') || c.includes('manufactura')) return 'empresa';
  return 'empresa';
}

function extractCity(address) {
  if (!address) return '';
  const parts = address.split(',');
  return parts.length >= 2 ? parts[parts.length - 2].trim() : parts[0].trim();
}

function mapZona(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('buenos aires')) return 'Bs.As.';
  if (t.includes('santa fe')) return 'Santa Fe';
  if (t.includes('cordoba') || t.includes('córdoba')) return 'Cordoba';
  if (t.includes('entre rios') || t.includes('entre ríos')) return 'Entre Rios';
  return 'Bs.As.';
}
