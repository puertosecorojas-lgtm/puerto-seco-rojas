// api/hunter.js — búsqueda y verificación de emails reales via Hunter.io
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, email, domain, company, firstName, lastName, _hunterKey } = req.body || {};
  const HUNTER_KEY = _hunterKey || process.env.HUNTER_API_KEY;
  if (!HUNTER_KEY) return res.status(500).json({ error: 'HUNTER_API_KEY no configurada — agregala en Configuración → Keys' });

  try {
    if (action === 'verify') {
      // Verificar si un email existe
      if (!email) return res.status(400).json({ error: 'Falta email' });

      const url = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${HUNTER_KEY}`;
      const r = await fetch(url);
      const data = await r.json();
      const d = data.data || {};

      return res.json({
        email,
        status: d.status,          // 'valid' | 'invalid' | 'accept_all' | 'unknown'
        score:  d.score || 0,
        valid:  d.status === 'valid' || (d.status === 'accept_all' && d.score > 50),
      });

    } else if (action === 'find') {
      // Buscar email de una persona por dominio + nombre
      if (!domain) return res.status(400).json({ error: 'Falta domain' });

      const params = new URLSearchParams({ domain, api_key: HUNTER_KEY });
      if (firstName) params.append('first_name', firstName);
      if (lastName)  params.append('last_name', lastName);

      const r = await fetch(`https://api.hunter.io/v2/email-finder?${params}`);
      const data = await r.json();
      const d = data.data || {};

      return res.json({
        email:  d.email || null,
        score:  d.score || 0,
        valid:  !!d.email && d.score > 40,
      });

    } else if (action === 'domain') {
      // Buscar todos los emails de un dominio/empresa
      if (!domain) return res.status(400).json({ error: 'Falta domain' });

      const params = new URLSearchParams({ domain, api_key: HUNTER_KEY, limit: '10' });
      const r = await fetch(`https://api.hunter.io/v2/domain-search?${params}`);
      const data = await r.json();
      const d = data.data || {};

      const emails = (d.emails || []).map(e => ({
        email:     e.value,
        firstName: e.first_name,
        lastName:  e.last_name,
        position:  e.position,
        score:     e.confidence,
      }));

      return res.json({ emails, organization: d.organization || company });

    } else {
      return res.status(400).json({ error: 'action debe ser: verify | find | domain' });
    }
  } catch (e