// api/leads.js — CRUD de leads contra Supabase REST API
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, Prefer');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Faltan variables de entorno SUPABASE_URL o SUPABASE_ANON_KEY' });
  }

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };

  try {
    if (req.method === 'GET') {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/leads?select=*&order=id.asc`, { headers });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      return res.status(201).json(data);
    }
    if (req.method === 'PUT') {
      const { id, ...body } = req.body;
      if (!id) return res.status(400).json({ error: 'Falta el id del lead' });
      const response = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      return res.status(200).json(data);
    }
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Falta el id del lead' });
      const response = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${id}`, {
        method: 'DELETE',
        headers,
      });
      if (!response.ok) {
        const data = await response.json();
        return res.status(response.status).json(data);
      }
      return res.status(204).end();
    }
    return res.status(405).json({ error: 'Metodo no permitido' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
