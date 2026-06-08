export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { city, industry, keywords, page = 1, _apolloKey } = req.body || {};
  const APOLLO_KEY = _apolloKey || process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY) return res.status(500).json({ error: 'APOLLO_API_KEY no configurada' });
  const locations = city ? [city + ', Argentina'] : ['Buenos Aires, Argentina'];
  const keywordTags = [];
  if (industry) keywordTags.push(industry);
  if (keywords) keywordTags.push(...keywords.split(',').map(k => k.trim()));
  if (keywordTags.length === 0) keywordTags.push('comercio exterior', 'logistica');
  try {
    const body = {
      api_key: APOLLO_KEY,
      page,
      per_page: 25,
      organization_locations: locations,
      q_organization_keyword_tags: keywordTags,
    };
    const r = await fetch('https://api.apollo.io/v1/mixed_companies/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: 'Apollo error: ' + err });
    }
    const data = await r.json();
    const companies = (data.organizations || []).map(org => ({
      nombre: org.name || '',
      empresa: org.name || '',
      tipo: 'empresa',
      ciudad: org.city || city || '',
      zona: org.state || '',
      email: org.email || '',
      email_status: org.email ? 'sin_verificar' : 'sin_email',
      telefono: org.phone || '',
      web: org.website_url || '',
      linkedin: org.linkedin_url || '',
      fuente: 'apollo',
    }));
    return res.json({ leads: companies, total: data.pagination?.total_entries || companies.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
