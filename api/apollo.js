// api/apollo.js — Páginas Amarillas scraper con flujo: listado → ficha → web → email
// Máximo 3 fichas por llamada para no exceder el timeout de Vercel (10s)

const SKIP_DOMAINS = [
  'paginasamarillas', 'amarillas.cl', 'paginas-amarillas', 'paginasblancas',
  'gurusoluciones', 'gurugo', 'miportal.guru', '_next', '/imagenes/',
  'wa.me', 'whatsapp.com', 'tiktok.com', 'instagram.com', 'facebook.com',
  'twitter.com', 'youtube.com', 'youtu.be', 'mt1.google', 'gstatic',
  'googleapis', 'leafletjs', 'google.com', 'google.es', 'amazonaws',
  'guru-media', 'maps.google', 'linkedin.com'
];

const SKIP_EMAILS = [
  'paginasamarillas', 'gurusoluciones', 'sentry', 'example.com',
  'noreply', 'guru', '@test', 'usuario@', 'nombre@', 'correo@'
];

function extractCompanyWeb(text) {
  const urls = text.match(/https?:\/\/[a-zA-Z0-9.\-]+\.[a-z]{2,}[^\s\)"\'>]*/g) || [];
  for (const url of urls) {
    if (!SKIP_DOMAINS.some(d => url.includes(d))) {
      return url.split('?')[0].split('#')[0].replace(/\/$/, '');
    }
  }
  return null;
}

function extractEmail(text) {
  const emails = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-z]{2,}/g) || [];
  for (const e of emails) {
    if (!SKIP_EMAILS.some(s => e.includes(s))) return e;
  }
  return null;
}

async function jinaFetch(url, timeout = 7000) {
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' },
      signal: AbortSignal.timeout(timeout)
    });
    if (!r.ok) return '';
    return await r.text();
  } catch {
    return '';
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { rubro, ciudad, provincia, page = 0 } = req.body || {};
  if (!rubro || !ciudad) {
    return res.status(400).json({ error: 'rubro y ciudad requeridos' });
  }

  // Si page === -1 es un request de solo listado (para saber cuántas hay)
  const rubroSlug = encodeURIComponent(rubro.toLowerCase().replace(/\s+/g, '-'));
  const ciudadSlug = encodeURIComponent(ciudad.toLowerCase().replace(/\s+/g, '-').replace(/[áàä]/g,'a').replace(/[éèë]/g,'e').replace(/[íìï]/g,'i').replace(/[óòö]/g,'o').replace(/[úùü]/g,'u').replace(/ñ/g,'n'));

  // Step 1: Obtener el listado de Páginas Amarillas
  const listingUrl = `https://www.paginasamarillas.com.ar/buscar/${rubroSlug}/${ciudadSlug}`;
  const listingText = await jinaFetch(listingUrl, 8000);

  // Extraer URLs de fichas únicas
  const fichasRaw = listingText.match(/https:\/\/www\.paginasamarillas\.com\.ar\/fichas\/[a-zA-Z0-9\-]+/g) || [];
  const fichas = [...new Set(fichasRaw)];

  if (fichas.length === 0) {
    return res.json({
      ok: true, leads: [], total: 0, totalFichas: 0, page: 0, hasMore: false,
      fuente: 'paginas_amarillas', ciudad, rubro,
      mensaje: `No se encontraron empresas de "${rubro}" en "${ciudad}". Intentá con otro rubro o ciudad.`
    });
  }

  // Step 2: Procesar batch de 3 fichas por llamada
  const BATCH_SIZE = 3;
  const start = page * BATCH_SIZE;
  const batch = fichas.slice(start, start + BATCH_SIZE);
  const hasMore = fichas.length > start + BATCH_SIZE;

  // Step 3: Obtener web de cada ficha en paralelo
  const fichaData = await Promise.all(batch.map(async (fichaUrl) => {
    const text = await jinaFetch(fichaUrl, 5000);
    const web = extractCompanyWeb(text);
    // Nombre desde la URL: /fichas/nombre-empresa_12345 → "Nombre Empresa"
    const slug = fichaUrl.split('/fichas/')[1] || '';
    const nombre = slug.replace(/_\d+$/, '').replace(/-/g, ' ')
      .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').substring(0, 60);
    // También intentar extraer email directo de la ficha
    const emailDirecto = extractEmail(text);
    return { nombre, fichaUrl, web, emailDirecto };
  }));

  // Step 4: Para empresas con web, buscar email en la web
  const leads = await Promise.all(fichaData.map(async ({ nombre, fichaUrl, web, emailDirecto }) => {
    // Si ya tiene email en la ficha, usar ese
    if (emailDirecto) {
      return { empresa: nombre, email: emailDirecto, web: web || fichaUrl, fuente: 'paginas_amarillas' };
    }
    if (!web) return null;

    // Buscar email en home y /contacto en paralelo
    const [homeText, contactText] = await Promise.all([
      jinaFetch(web, 5000),
      jinaFetch(web + '/contacto', 4000)
    ]);
    const email = extractEmail(homeText + '\n' + contactText);
    if (!email) return null;

    return { empresa: nombre, email, web, fuente: 'paginas_amarillas' };
  }));

  const validLeads = leads.filter(Boolean);

  return res.json({
    ok: true,
    leads: validLeads,
    total: validLeads.length,
    totalFichas: fichas.length,
    procesadas: start + batch.length,
    page,
    hasMore,
    fuente: 'paginas_amarillas',
    ciudad,
    rubro
  });
}
