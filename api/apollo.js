// api/apollo.js — búsqueda de empresas reales via Apollo.io
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { city, industry, keywords, page = 1, _apolloKey } = req.body || {};
  const APOLLO_KEY = _apolloKey || process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY) return res.status(500).json({ error: 'APOLLO_API_KEY no configurada — agregala en Configuración → Keys' });

  // Construir parámetros de búsqueda
  const locations = city
    ? [`${city}, Argentina`]
    : ['Buenos Aires, Argentina', 'Santa Fe, Argentina', 'Córdoba, Argentina'];

  const keywordTags = [];
  if (industry) keywordTags.push(industry);
  if (keywords) keywordTags.push(...keywords.split(',').map(k => k.trim()));
  // Si no hay filtros específicos, buscar rubros relacionados con comercio exterior
  if (keywordTags.length === 0) {
    keywordTags.push('despachante de aduana', 'comercio exterior', 'logistica internacional');
  }

  try {
    const body = {
      api_key: APOLLO_KEY,
      page,
      per_page: 25,
      organization_locations: locations,
      q_organization_keyword_tags: keywordTags,
      organization_num_employees_ranges: ['1,200'], // empresas pequeñas/medianas
    };

    const r = await fetch('https://api.apollo.io/v1/mixed_companies/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Apollo error: ${err}` });
    }

    const data = await r.json();
    const companies = (data.organizations || []).map(org => ({
      nombre:     org.name || '',
      empresa:    org.name || '',
      tipo:       clasificarTipo(org.industry || ''),
      ciudad:     org.city || city || '',
      zona:       mapZona(org.state || org.country || ''),
      email:      org.email || '',
      email_status: org.email ? 'sin_verificar' : 'sin_email',
      telefono:   org.phone || '',
      web:        org.website_url || '',
      linkedin:   org.linkedin_url || '',
      fuente:     'apollo',
    }));

    return res.json({ leads: companies, total: data.pagination?.total_entries || companies.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function clasificarTipo(industry) {
  const i = industry.toLowerCase();
  if (i.includes('aduanero') || i.includes('customs') || i.includes('despachante')) return 'despachante';
  if (i.includes('logistic') || i.includes('transporte') || i.includes('freight')) return 'operador_logistico';
  if (i.includes('import') || i.includes('export') || i.includes('comercio')) return 'importador_exportador';
  if (i.includes('agro') || i.includes('grain') || i.includes('agriCultural')) return 'agro_industrial';
  return 'empresa';
}

function mapZona(state) {
  const s = state.toLowerCase();
  if (s.includes('buenos aires')) return 'Bs.As.';
  if (s.includes('santa fe')) return 'Santa Fe';
  if (s.includes('córdoba') || s.includes('cordoba')) return 'Córdoba';
  if (s.includes('entre ríos') || s