export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  const { user, pass } = req.body;
  const CRM_USER = process.env.CRM_USER;
  const CRM_PASS = process.env.CRM_PASS;
  if (!CRM_USER || !CRM_PASS) return res.status(500).json({ error: 'Variables no configuradas' });
  if (user === CRM_USER && pass === CRM_PASS) {
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Usuario o contrasena incorrectos' });
}
