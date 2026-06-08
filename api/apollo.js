export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { city, industry, keywords, page = 1, _apolloKey } = req.body || {};
  const APOLLO_KEY = _apolloKey || process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY) return res.status(500).json({ error: 'APOLLO_API_KEY no configurada — agregala en Configuracion → Keys' });

  const locations = city ? [city + ', Argentina'] : ['Buenos Aires, Argentina'];
  const keywordTags = [];
  if (industry) keywordTags.push(industry);
  if (keywords) keywordTags.push(...keywords.split(',').map(k => k.trim()).filter(Boolean));
  if (keywordTags.length === 0) keywordTags.push('comercio exterior');

  try {
    const body = {
      page,
      per_page: 25,
      organization_locations: locations,
      q_organization_keyword_tags: keywordTags,
    };

    const r = await fetch('https://api.apollo.io/v1/organizations/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': APOLLO_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: 'Apollo error ' + r.status + ': ' + err.substring(0, 200) });
    }

    const data = await r.json();
    const companies = (data.organizations || []).map(org => ({
      nombre: org.name || '',
      empresa: org.name || '',
      tipo: detectarTipo(org),
      ciudad: org.city || city || '',
      zona: org.state || '',
      email: org.contact_email || '',
      email_status: org.contact_email ? 'sin_verificar' : 'sin_email',
      telefono: org.sanitized_phone || org.phone || '',
      web: org.website_url || '',
      linkedin: org.linkedin_url || '',
      fuente: 'apollo',
      notas: org.short_description ? org.short_description.substring(0, 150) : '',
    }));

    return res.json({ leads: companies, total: data.pagination?.total_entries || companies.length });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function detectarTipo(org) {
  const name = (org.name || '').toLowerCase();
  const desc = (org.short_description || '').toLowerCase();
  const combined = name + ' ' + desc;
  if (combined.includes('despachante') || combined.includes('aduana') || combined.includes('customs broker')) return 'despachante';
  if (combined.includes('logistic') || combined.includes('logistica') || combined.includes('transporte') || combined.includes('freight')) return 'operador_logistico';
  if (combined.includes('import') || combined.includes('export') || combined.includes('comercio exterior')) return 'importador_exportador';
  if (combined.includes('agro') || combined.includes('cereal') || combined.includes('soja') || combined.includes('grano')) return 'agro_industrial';
  return 'empresa';
}
