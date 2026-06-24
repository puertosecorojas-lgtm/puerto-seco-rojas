// api/apify-status.js — consulta el estado de un run de Apify y devuelve leads cuando termina
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { runId, _apifyKey, _hunterKey } = req.body || {};
  const APIFY_KEY  = _apifyKey  || process.env.APIFY_API_KEY;
  const HUNTER_KEY = _hunterKey || process.env.HUNTER_API_KEY;

  if (!APIFY_KEY) return res.status(500).json({ error: 'APIFY_API_KEY no configurada' });
  if (!runId)    return res.status(400).json({ error: 'Falta runId' });

  try {
    // Consultar estado del run
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_KEY}`
    );
    const statusData = await statusRes.json();
    const status = statusData.data?.status;

    if (!status) return res.status(500).json({ error: 'No se pudo obtener estado del run' });

    // Todavia corriendo
    if (status === 'RUNNING' || status === 'READY') {
      return res.json({ status: 'running' });
    }

    // Fallo
    if (status !== 'SUCCEEDED') {
      return res.json({ status: 'failed', error: `Run termino con estado: ${status}` });
    }

    // Listo — obtener resultados
    const resultsRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_KEY}&limit=50`
    );
    const results = await resultsRes.json();

    let leads = (results || [])
      .filter(p => p.title)
      .map(place => ({
        nombre:       place.title,
        empresa:      place.title,
        tipo:         clasificarTipo(place.categoryName || place.categories?.[0] || ''),
        ciudad:       extractCity(place.address || ''),
        zona:         mapZona(place.address || ''),
        email:        place.email || '',
        email_status: place.email ? 'sin_verificar' : 'sin_email',
        telefono:     place.phone || place.phoneUnformatted || '',
        web:          place.website || '',
        direccion:    place.address || '',
        fuente:       'apify_maps',
      }));

    // Buscar emails con Hunter para los que tienen web pero no email (max 10)
    if (HUNTER_KEY) {
      const sinEmail = leads.filter(l => !l.email && l.web).slice(0, 10);
      await Promise.allSettled(sinEmail.map(async (lead) => {
        try {
          const domain = extractDomain(lead.web);
          if (!domain) return;
          const r = await fetch(
            `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_KEY}&limit=3`
          );
          const data = await r.json();
          const emails = data.data?.emails || [];
          if (emails.length > 0) {
            const best = emails.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
            lead.email        = best.value;
            lead.email_status = best.confidence > 70 ? 'verificado' : 'sin_verificar';
            lead.contacto_nombre = best.first_name && best.last_name ? `${best.first_name} ${best.last_name}` : '';
            lead.contacto_cargo  = best.position || '';
          }
        } catch (_) {}
      }));
    }

    return res.json({ status: 'done', leads, total: leads.length });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function clasificarTipo(category) {
  const c = category.toLowerCase();
  if (c.includes('aduana') || c.includes('despacho') || c.includes('despachante')) return 'despachante';
  if (c.includes('logistic') || c.includes('transporte') || c.includes('flete')) return 'operador_logistico';
  if (c.includes('import') || c.includes('export') || c.includes('comercio exterior')) return 'importador_exportador';
  if (c.includes('agro') || c.includes('grano') || c.includes('semilla') || c.includes('cereal')) return 'agro_industrial';
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
  if (t.includes('santa fe'))     return 'Santa Fe';
  if (t.includes('cordoba') || t.includes('córdoba')) return 'Cordoba';
  if (t.includes('entre rios') || t.includes('entre ríos')) return 'Entre Rios';
  return 'Bs.As.';
}

function extractDomain(web = '') {
  try {
    const url = web.startsWith('http') ? web : 'https://' + web;
    return new URL(url).hostname.replace('www.', '');
  } catch (_) {
    return web.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }
}
