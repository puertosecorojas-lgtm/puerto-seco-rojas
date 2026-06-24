// api/scrape-email.js — versión mejorada
// Busca emails reales en el sitio web de la empresa,
// priorizando emails de contacto directo sobre genéricos

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { web, company } = req.body || {};
  if (!web) return res.status(400).json({ error: 'Falta URL del sitio web' });

  const base = web.startsWith('http') ? web.replace(/\/$/, '') : 'https://' + web.replace(/\/$/, '');

  // Rutas a revisar en orden de probabilidad de tener email de contacto real
  const paths = [
    '',             // home
    '/contacto',
    '/contact',
    '/contactenos',
    '/contactenos.html',
    '/contacto.html',
    '/contact.html',
    '/nosotros',
    '/quienes-somos',
    '/empresa',
    '/about',
    '/about-us',
    '/equipo',
    '/team',
    '/staff',
    '/about/contact',
  ];

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  // Emails a ignorar (falsos positivos comunes en HTML)
  const BLACKLIST = [
    'example', 'sentry', 'domain', 'noreply', 'no-reply',
    'wordpress', 'wix', 'jquery', 'schema', 'w3.org',
    '.png', '.jpg', '.gif', '.svg', '.webp', '.css', '.js',
    'yourname', 'tuempresa', 'usuario', 'correo',
  ];

  // Score para priorizar emails: cuanto más alto, mejor
  function scoreEmail(email) {
    const e = email.toLowerCase();
    const local = e.split('@')[0];

    // Emails personales = mejor (tienen nombre real)
    if (/^[a-z]+\.[a-z]+@/.test(e)) return 100;          // juan.perez@
    if (/^[a-z]+[0-9]{0,2}@/.test(e) && local.length > 4) return 80; // juanp@

    // Emails de área de negocio = buenos
    if (local.includes('comercial') || local.includes('ventas') || local.includes('venta')) return 90;
    if (local.includes('export') || local.includes('import') || local.includes('logistic')) return 85;
    if (local.includes('gerencia') || local.includes('gerente') || local.includes('direccion')) return 85;
    if (local.includes('administr') || local.includes('admin')) return 70;
    if (local.includes('contacto') || local.includes('contact')) return 60;

    // Emails genéricos = peor pero válidos
    if (local === 'info') return 40;
    if (local === 'hola') return 35;
    if (local.includes('info') || local.includes('mail')) return 30;

    return 50; // default
  }

  const allFound = new Map(); // email → score

  for (const path of paths) {
    const url = base + path;
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-AR,es;q=0.9',
        },
        signal: AbortSignal.timeout(6000),
        redirect: 'follow',
      });

      if (!r.ok) continue;

      let html = await r.text();

      // Decodificar mailto: links ocultos en HTML (muy común en webs argentinas)
      // Ejemplo: href="mailto:gerencia@empresa.com"
      const mailtoMatches = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g) || [];
      mailtoMatches.forEach(m => {
        const email = m.replace('mailto:', '').toLowerCase().trim();
        if (isValid(email)) {
          const s = scoreEmail(email);
          if (!allFound.has(email) || allFound.get(email) < s) allFound.set(email, s);
        }
      });

      // Buscar en el HTML general
      const matches = html.match(emailRegex) || [];
      matches.forEach(email => {
        const e = email.toLowerCase().trim();
        if (isValid(e)) {
          const s = scoreEmail(e);
          if (!allFound.has(e) || allFound.get(e) < s) allFound.set(e, s);
        }
      });

      // Si ya encontramos algo con score alto, no seguir buscando
      const best = getBest(allFound);
      if (best && scoreEmail(best) >= 80) break;

    } catch (_) {
      continue;
    }
  }

  // Ordenar por score descendente
  const emails = [...allFound.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([email]) => email);

  const best = emails[0] || null;

  return res.json({
    emails,
    best,
    score: best ? allFound.get(best) : null,
  });

  function isValid(email) {
    if (!email || !email.includes('@')) return false;
    for (const bad of BLACKLIST) {
      if (email.includes(bad)) return false;
    }
    // Ignorar dominios claramente no empresariales
    const domain = email.split('@')[1] || '';
    if (['gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com'].includes(domain)) {
      // Aceptar igualmente — en PyMEs argentinas es muy común tener Gmail corporativo
      return true;
    }
    return true;
  }

  function getBest(map) {
    let best = null, bestScore = -1;
    for (const [email, score] of map.entries()) {
      if (score > bestScore) { best = email; bestScore = score; }
    }
    return best;
  }
}
