// api/apollo.js → ahora es el scraper de Páginas Amarillas Argentina
// Busca empresas reales con contacto en paginasamarillas.com.ar
// Gratis, sin créditos, cubre PyMEs argentinas en ciudades chicas
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rubro, ciudad, provincia = 'Buenos Aires', page = 1 } = req.body || {};
  if (!rubro || !ciudad) return res.status(400).json({ error: 'Falta rubro y ciudad' });

  const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'');

  const urls = [
    `https://www.paginasamarillas.com.ar/buscar/${slug(rubro)}/${slug(ciudad)}`,
    `https://www.paginasamarillas.com.ar/buscar/${slug(rubro)}/${slug(ciudad)}/${slug(provincia)}`,
    `https://www.paginasamarillas.com.ar/buscar?q=${encodeURIComponent(rubro)}&donde=${encodeURIComponent(ciudad+', '+provincia)}`,
  ];

  const emailRx  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const phoneRx  = /(?:(?:\+?54)?(?:11|2[2-9]\d|3[0-9]\d)[\s\-]?\d{3,4}[\s\-]?\d{4})/g;
  const webRx    = /(?:www\.|https?:\/\/)[a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}/gi;
  const FAKE     = ['paginasamarillas','google','microsoft','bing','sentry','noreply','no-reply','wordpress','wix','w3.org','.png','.jpg','.gif','example.com'];

  const isEmail  = e => !FAKE.some(f => e.includes(f)) && e.includes('@') && e.includes('.');

  let leads = [];

  for (const url of urls) {
    if (leads.length >= 20) break;
    try {
      // Intentar con Jina Reader primero (renderiza JS, evita bloqueos)
      const jinaUrl = `https://r.jina.ai/${url}`;
      let text = '';
      try {
        const rj = await fetch(jinaUrl, {
          headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-No-Cache': 'true' },
          signal: AbortSignal.timeout(9000)
        });
        if (rj.ok) text = await rj.text();
      } catch(_) {}

      // Fallback: fetch directo
      if (text.length < 200) {
        const rd = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'es-AR,es;q=0.9',
            'Accept': 'text/html',
          },
          signal: AbortSignal.timeout(7000)
        });
        if (rd.ok) text = await rd.text();
      }

      if (text.length < 100) continue;

      const parsed = parsePA(text, ciudad, provincia, emailRx, phoneRx, webRx, isEmail);
      for (const l of parsed) {
        if (leads.length >= 20) break;
        if (!leads.find(x => normalize(x.empresa) === normalize(l.empresa))) leads.push(l);
      }
    } catch(e) { console.error('PA error:', e.message); }
  }

  return res.json({ ok: true, leads, total: leads.length, fuente: 'paginas_amarillas', ciudad, rubro });
}

function normalize(s='') { return s.toLowerCase().trim().replace(/\s+/g,' '); }

function parsePA(text, ciudad, provincia, emailRx, phoneRx, webRx, isEmail) {
  const leads = [];
  const seen  = new Set();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Recolectar todos los emails del texto para asignar a empresas cercanas
  const allEmails = [...new Set((text.match(emailRx)||[]).map(e=>e.toLowerCase()).filter(isEmail))];

  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detectar nombre de empresa: línea corta, tiene mayúsculas, no es URL ni número
    const looksLikeName =
      line.length >= 4 && line.length <= 80 &&
      /[A-ZÁÉÍÓÚÑ]/.test(line) &&
      !/^https?:\/\//.test(line) &&
      !/^\d{4,}/.test(line) &&
      !line.includes('@') &&
      !/^(Tel|Fax|Dir|Cel|Whats|Email|Web|Ver |Más|Llamar|Compartir|Guardar|Abrir|\+54)/i.test(line) &&
      !['Buenos Aires','Argentina','Teléfono','Dirección','Sitio Web','Correo'].includes(line);

    if (looksLikeName && !seen.has(normalize(line))) {
      if (cur && cur.empresa) leads.push(cur);
      cur = {
        empresa: line, nombre: line, tipo: 'empresa',
        ciudad, zona: provincia, email: '', email_status: 'sin_email',
        telefono: '', web: '', direccion: '', notas: '',
        fuente: 'paginas_amarillas', estado: 'pendiente_revision', contactado: false,
      };
      seen.add(normalize(line));
    }

    if (!cur) continue;

    const phones = line.match(phoneRx);
    if (phones && !cur.telefono) cur.telefono = phones[0].trim();

    const webs = line.match(webRx);
    if (webs && !cur.web) cur.web = webs[0].startsWith('http') ? webs[0] : 'https://'+webs[0];

    const emails = (line.match(emailRx)||[]).map(e=>e.toLowerCase()).filter(isEmail);
    if (emails.length && !cur.email) { cur.email = emails[0]; cur.email_status = 'sin_verificar'; }

    // Dirección: tiene número y no es teléfono
    if (/\d{2,5}/.test(line) && line.length < 70 && !phones && !cur.direccion && !/http/.test(line)) {
      cur.direccion = line;
    }
  }
  if (cur && cur.empresa) leads.push(cur);

  // Si el parser estructurado no encontró nada pero hay emails, crear entradas simples
  if (leads.length === 0 && allEmails.length > 0) {
    allEmails.slice(0,10).forEach((email, i) => {
      const domain = email.split('@')[1] || '';
      leads.push({
        empresa: domain.replace(/\.com\.ar$|\.com$/,'').replace(/\./g,' '),
        nombre: `Empresa de ${ciudad}`,
        tipo: 'empresa', ciudad, zona: provincia,
        email, email_status: 'sin_verificar',
        telefono: '', web: `https://${domain}`, direccion: '',
        fuente: 'paginas_amarillas', estado: 'pendiente_revision', contactado: false,
      });
    });
  }

  return leads.filter(l => l.empresa.length > 2);
}
