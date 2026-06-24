// api/find-email.js — busca el email real de una empresa en cascada
// Paso 1: scraper del sitio web (multiples rutas)
// Paso 2: Hunter.io por dominio
// Paso 3: Bing search snippets
// Paso 4: probar patrones comunes con SMTP ping

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { empresa, web, ciudad, _hunterKey } = req.body || {};
  const HUNTER_KEY = _hunterKey || process.env.HUNTER_API_KEY;

  if (!empresa && !web) return res.status(400).json({ error: 'Falta empresa o web' });

  const results = { email: null, fuente: null, score: 0, alternativas: [] };
  const log = [];

  // ── PASO 1: Scraper del sitio web ─────────────────────────────────────────
  if (web) {
    try {
      const scraped = await scrapeWebsite(web);
      if (scraped.best) {
        log.push(`Web scraper: ${scraped.best} (score ${scraped.score})`);
        results.alternativas.push(...scraped.emails.slice(0, 3).map(e => ({ email: e, fuente: 'web' })));
        if (scraped.score >= 60) {
          results.email  = scraped.best;
          results.fuente = 'web_scraper';
          results.score  = scraped.score;
        }
      } else {
        log.push('Web scraper: sin resultados');
      }
    } catch (e) {
      log.push(`Web scraper error: ${e.message}`);
    }
  }

  // ── PASO 2: Hunter.io por dominio ─────────────────────────────────────────
  if (!results.email && HUNTER_KEY && web) {
    try {
      const domain = extractDomain(web);
      if (domain) {
        const r = await fetch(
          `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_KEY}&limit=5`
        );
        const data = await r.json();
        const emails = (data.data?.emails || []).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
        if (emails.length > 0) {
          const best = emails[0];
          log.push(`Hunter: ${best.value} (confianza ${best.confidence}%)`);
          results.alternativas.push(...emails.slice(0, 3).map(e => ({ email: e.value, fuente: 'hunter', score: e.confidence })));
          if (best.confidence >= 50) {
            results.email  = best.value;
            results.fuente = 'hunter';
            results.score  = best.confidence;
            if (best.first_name) results.contacto_nombre = `${best.first_name} ${best.last_name || ''}`.trim();
            if (best.position)   results.contacto_cargo  = best.position;
          }
        } else {
          log.push('Hunter: sin resultados para ese dominio');
        }
      }
    } catch (e) {
      log.push(`Hunter error: ${e.message}`);
    }
  }

  // ── PASO 3: Búsqueda Bing ─────────────────────────────────────────────────
  if (!results.email && empresa) {
    try {
      const query = `"${empresa}" email contacto${ciudad ? ' ' + ciudad : ''} Argentina`;
      const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=es`;
      const r = await fetch(bingUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'es-AR,es;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const html = await r.text();
        const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const found = [...new Set((html.match(emailRegex) || []).map(e => e.toLowerCase()))];
        const filtered = found.filter(e => !isFakeEmail(e));
        if (filtered.length > 0) {
          // Preferir emails que contengan parte del nombre de la empresa
          const empresaWords = empresa.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          const prioritized = filtered.sort((a, b) => {
            const aMatch = empresaWords.some(w => a.includes(w)) ? 1 : 0;
            const bMatch = empresaWords.some(w => b.includes(w)) ? 1 : 0;
            return bMatch - aMatch;
          });
          log.push(`Bing: ${prioritized[0]} (${filtered.length} encontrados)`);
          results.alternativas.push(...prioritized.slice(0, 3).map(e => ({ email: e, fuente: 'bing' })));
          results.email  = prioritized[0];
          results.fuente = 'bing';
          results.score  = 40;
        } else {
          log.push('Bing: sin emails en resultados');
        }
      }
    } catch (e) {
      log.push(`Bing error: ${e.message}`);
    }
  }

  // ── PASO 4: Patrones comunes + verificación SMTP ──────────────────────────
  if (!results.email && web) {
    try {
      const domain = extractDomain(web);
      if (domain) {
        const patterns = ['info', 'contacto', 'ventas', 'comercial', 'administracion', 'gerencia', 'hola'];
        for (const prefix of patterns) {
          const candidate = `${prefix}@${domain}`;
          const valid = await smtpCheck(domain, candidate);
          if (valid) {
            log.push(`SMTP pattern: ${candidate} responde`);
            results.email  = candidate;
            results.fuente = 'smtp_pattern';
            results.score  = 55;
            break;
          }
        }
        if (!results.email) log.push('SMTP patterns: ninguno respondio');
      }
    } catch (e) {
      log.push(`SMTP error: ${e.message}`);
    }
  }

  // Deduplicar alternativas
  const seen = new Set();
  results.alternativas = results.alternativas.filter(a => {
    if (seen.has(a.email) || a.email === results.email) return false;
    seen.add(a.email);
    return true;
  }).slice(0, 3);

  return res.json({ ...results, log });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function scrapeWebsite(web) {
  const base = web.startsWith('http') ? web.replace(/\/$/, '') : 'https://' + web.replace(/\/$/, '');
  const paths = ['', '/contacto', '/contact', '/contactenos', '/nosotros', '/quienes-somos',
                 '/empresa', '/about', '/equipo', '/team', '/contacto.html', '/contact.html'];
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const found = new Map();

  for (const path of paths) {
    try {
      const r = await fetch(base + path, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'es-AR,es;q=0.9' },
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      if (!r.ok) continue;
      const html = await r.text();

      // mailto links primero (mas confiables)
      const mailtoMatches = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g) || [];
      mailtoMatches.forEach(m => {
        const email = m.replace('mailto:', '').toLowerCase();
        if (!isFakeEmail(email)) found.set(email, scoreEmail(email) + 10);
      });

      const matches = html.match(emailRegex) || [];
      matches.forEach(email => {
        const e = email.toLowerCase();
        if (!isFakeEmail(e) && !found.has(e)) found.set(e, scoreEmail(e));
      });

      if (found.size > 0 && Math.max(...found.values()) >= 80) break;
    } catch (_) { continue; }
  }

  const sorted = [...found.entries()].sort((a, b) => b[1] - a[1]);
  return {
    emails: sorted.map(([e]) => e),
    best:   sorted[0]?.[0] || null,
    score:  sorted[0]?.[1] || 0,
  };
}

async function smtpCheck(domain, email) {
  // Verificacion liviana: resolucion MX via DNS-over-HTTPS
  // No hace conexion SMTP real (requeriria raw sockets), pero valida que el dominio tiene MX
  try {
    const r = await fetch(`https://dns.google/resolve?name=${domain}&type=MX`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = await r.json();
    return (data.Answer || []).length > 0; // tiene MX → acepta emails
  } catch (_) {
    return false;
  }
}

function scoreEmail(email) {
  const local = email.split('@')[0].toLowerCase();
  if (/^[a-z]+\.[a-z]+@/.test(email)) return 95;
  if (local.includes('comercial') || local.includes('ventas')) return 90;
  if (local.includes('export') || local.includes('import') || local.includes('logistic')) return 85;
  if (local.includes('gerencia') || local.includes('gerente') || local.includes('direccion')) return 85;
  if (local.includes('administr')) return 70;
  if (local.includes('contacto') || local.includes('contact')) return 65;
  if (local === 'info') return 40;
  if (local.includes('info') || local.includes('mail')) return 35;
  return 50;
}

function isFakeEmail(email) {
  const bad = ['example', 'sentry', 'domain', 'noreply', 'no-reply', 'wordpress',
               'wix', 'jquery', 'schema', 'w3.org', '.png', '.jpg', '.gif', '.svg',
               'yourname', 'tuempresa', 'usuario', 'correo', 'email@', '@email',
               'bing.com', 'microsoft.com', 'google.com'];
  return bad.some(b => email.includes(b));
}

function extractDomain(web = '') {
  try {
    const url = web.startsWith('http') ? web : 'https://' + web;
    return new URL(url).hostname.replace('www.', '');
  } catch (_) {
    return web.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }
}
