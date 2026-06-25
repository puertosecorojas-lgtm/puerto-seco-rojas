// api/apollo.js → Páginas Amarillas Argentina
// Solo devuelve empresas CON email real — descarta las que no tienen
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rubro, ciudad, provincia = 'Buenos Aires' } = req.body || {};
  if (!rubro || !ciudad) return res.status(400).json({ error: 'Falta rubro y ciudad' });

  const HUNTER_KEY = process.env.HUNTER_API_KEY;
  const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'');
  const emailRx = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const phoneRx = /(?:\+?54)?(?:11|2[2-9]\d|3[0-9]\d)[\s\-]?\d{3,4}[\s\-]?\d{4}/g;
  const webRx   = /(?:www\.|https?:\/\/)[a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}/gi;
  const FAKE    = ['paginasamarillas','google','microsoft','bing','sentry','noreply','no-reply','wordpress','wix','w3.org','.png','.jpg','example.com','cloudflare','schema'];

  const isEmail = e => !FAKE.some(f => e.includes(f)) && e.includes('@') && e.split('@')[1]?.includes('.');

  // Scrape Páginas Amarillas
  const urls = [
    `https://www.paginasamarillas.com.ar/buscar/${slug(rubro)}/${slug(ciudad)}`,
    `https://www.paginasamarillas.com.ar/buscar/${slug(rubro)}/${slug(ciudad)}/${slug(provincia)}`,
  ];

  let allLeads = [];
  for (const url of urls) {
    try {
      let text = '';
      // Jina Reader primero
      try {
        const rj = await fetch(`https://r.jina.ai/${url}`, {
          headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' },
          signal: AbortSignal.timeout(9000)
        });
        if (rj.ok) text = await rj.text();
      } catch(_) {}
      // Fallback fetch directo
      if (text.length < 200) {
        try {
          const rd = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'es-AR,es;q=0.9' },
            signal: AbortSignal.timeout(7000)
          });
          if (rd.ok) text = await rd.text();
        } catch(_) {}
      }
      if (text.length < 100) continue;
      const parsed = parsePA(text, ciudad, provincia, emailRx, phoneRx, webRx, isEmail);
      for (const l of parsed) {
        if (!allLeads.find(x => x.empresa.toLowerCase() === l.empresa.toLowerCase())) allLeads.push(l);
      }
    } catch(e) { console.error('PA error:', e.message); }
  }

  // Para cada empresa SIN email, intentar encontrarlo (Jina web + Bing)
  const sinEmail = allLeads.filter(l => !l.email && (l.web || l.empresa));
  await Promise.allSettled(sinEmail.map(async (lead) => {
    try {
      const body = { mode: 'find', empresa: lead.empresa, ciudad: lead.ciudad };
      if (lead.web) body.web = lead.web;
      const r = await fetch(`${process.env.VERCEL_URL ? 'https://'+process.env.VERCEL_URL : 'https://puerto-seco-rojas.vercel.app'}/api/scrape-email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000)
      });
      if (r.ok) {
        const d = await r.json();
        if (d.email || d.best) {
          lead.email = d.email || d.best;
          lead.email_status = 'sin_verificar';
          lead.fuente_email = d.fuente || 'web';
        }
      }
    } catch(_) {}
  }));

  // SOLO devolver empresas con email
  const conEmail = allLeads.filter(l => l.email && l.email.includes('@'));
  return res.json({ ok: true, leads: conEmail, total: conEmail.length, descartadas: allLeads.length - conEmail.length, fuente: 'paginas_amarillas', ciudad, rubro });
}

function parsePA(text, ciudad, provincia, emailRx, phoneRx, webRx, isEmail) {
  const leads = [], seen = new Set();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let cur = null;

  for (const line of lines) {
    const looksLikeName =
      line.length >= 4 && line.length <= 80 &&
      /[A-ZÁÉÍÓÚÑ]/.test(line) &&
      !/^https?:\/\//.test(line) && !/^\d{3,}/.test(line) &&
      !line.includes('@') && !line.match(phoneRx) &&
      !/^(Tel|Fax|Cel|Email|Web|Ver |Más|Llamar|Compartir|Guardar|\+54|www\.)/i.test(line) &&
      !['Buenos Aires','Argentina','Teléfono','Dirección','Correo Electrónico'].includes(line);

    if (looksLikeName && !seen.has(line.toLowerCase())) {
      if (cur?.empresa) leads.push(cur);
      cur = { empresa: line, nombre: line, tipo: 'empresa', ciudad, zona: provincia,
        email: '', email_status: 'sin_email', telefono: '', web: '', direccion: '',
        fuente: 'paginas_amarillas', estado: 'pendiente_revision', contactado: false };
      seen.add(line.toLowerCase());
    }
    if (!cur) continue;
    const phones = line.match(phoneRx);
    if (phones && !cur.telefono) cur.telefono = phones[0].trim();
    const webs = line.match(webRx);
    if (webs && !cur.web) cur.web = webs[0].startsWith('http') ? webs[0] : 'https://'+webs[0];
    const emails = (line.match(emailRx)||[]).map(e=>e.toLowerCase()).filter(isEmail);
    if (emails.length && !cur.email) { cur.email = emails[0]; cur.email_status = 'sin_verificar'; }
    if (/\b\d{1,5}\b/.test(line) && line.length < 70 && !phones && !cur.direccion && !/http|www/i.test(line))
      cur.direccion = line;
  }
  if (cur?.empresa) leads.push(cur);
  return leads.filter(l => l.empresa.length > 2);
}
