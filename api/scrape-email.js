// api/scrape-email.js
// mode: 'find'   — cascada completa: web paralelo + Hunter + Bing + SMTP
// mode: 'scrape' — solo scraper web (default)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { web, company, empresa, ciudad, mode, _hunterKey } = req.body || {};
  const HUNTER_KEY = _hunterKey || process.env.HUNTER_API_KEY;
  const nombre = empresa || company || '';

  if (!web && !nombre) return res.status(400).json({ error: 'Falta web o empresa' });

  if (mode === 'find') {
    const out = { email: null, fuente: null, score: 0, alternativas: [], log: [] };

    // Paso 1: scraper web en PARALELO (rapido, max 5s total)
    if (web) {
      const s = await scrapeWebsite(web);
      if (s.best) {
        out.log.push(`Web: ${s.best} (score ${s.score})`);
        out.alternativas.push(...s.emails.slice(0,3).map(e=>({email:e,fuente:'web'})));
        if (s.score >= 50) { out.email=s.best; out.fuente='web'; out.score=s.score; }
      } else out.log.push('Web: sin resultados');
    }

    // Paso 2: Hunter.io
    if (!out.email && HUNTER_KEY && web) {
      try {
        const domain = extractDomain(web);
        if (domain) {
          const d = await (await fetch(
            `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_KEY}&limit=5`,
            { signal: AbortSignal.timeout(5000) }
          )).json();
          const emails = (d.data?.emails||[]).sort((a,b)=>(b.confidence||0)-(a.confidence||0));
          if (emails.length>0) {
            const best=emails[0];
            out.log.push(`Hunter: ${best.value} (${best.confidence}%)`);
            out.alternativas.push(...emails.slice(0,3).map(e=>({email:e.value,fuente:'hunter',score:e.confidence})));
            if (best.confidence>=40) {
              out.email=best.value; out.fuente='hunter'; out.score=best.confidence;
              if(best.first_name) out.contacto_nombre=`${best.first_name} ${best.last_name||''}`.trim();
              if(best.position) out.contacto_cargo=best.position;
            }
          } else out.log.push('Hunter: sin resultados');
        }
      } catch(e){ out.log.push(`Hunter error: ${e.message}`); }
    }

    // Paso 3: Bing — busca email por nombre de empresa (funciona SIN website)
    if (!out.email && nombre) {
      try {
        const queries = [
          `"${nombre}" email contacto${ciudad?' '+ciudad:''} Argentina`,
          `${nombre} ${ciudad||''} Argentina email @`,
        ];
        for (const q of queries) {
          if (out.email) break;
          const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=es`,
            { headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept-Language':'es-AR,es;q=0.9'}, signal:AbortSignal.timeout(6000) });
          if (!r.ok) continue;
          const html = await r.text();
          const found = [...new Set((html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)||[]).map(e=>e.toLowerCase()))].filter(e=>!isFake(e));
          if (found.length>0) {
            const words = nombre.toLowerCase().split(/\s+/).filter(w=>w.length>3);
            const sorted = found.sort((a,b)=>(words.some(w=>b.includes(w))?1:0)-(words.some(w=>a.includes(w))?1:0));
            out.log.push(`Bing: ${sorted[0]}`);
            out.alternativas.push(...sorted.slice(0,3).map(e=>({email:e,fuente:'bing'})));
            out.email=sorted[0]; out.fuente='bing'; out.score=40;
          } else out.log.push(`Bing: sin emails (q: ${q.substring(0,40)})`);
        }
      } catch(e){ out.log.push(`Bing error: ${e.message}`); }
    }

    // Paso 4: SMTP pattern + MX check (necesita dominio, con o sin www)
    if (!out.email) {
      const domain = web ? extractDomain(web) : guessDomain(nombre);
      if (domain) {
        try {
          const dns = await (await fetch(`https://dns.google/resolve?name=${domain}&type=MX`,{signal:AbortSignal.timeout(3000)})).json();
          if ((dns.Answer||[]).length>0) {
            out.email=`info@${domain}`; out.fuente='smtp_pattern'; out.score=30;
            out.log.push(`SMTP: info@${domain} (MX ok)`);
          } else out.log.push(`SMTP: ${domain} sin MX`);
        } catch(e){ out.log.push(`SMTP error: ${e.message}`); }
      }
    }

    const seen=new Set([out.email].filter(Boolean));
    out.alternativas=out.alternativas.filter(a=>{ if(seen.has(a.email)) return false; seen.add(a.email); return true; }).slice(0,3);
    // Campo 'best' para compatibilidad con el frontend
    out.best = out.email;
    return res.json(out);
  }

  // ── Modo scrape (default) ───────────────────────────────────────────────
  if (!web) return res.status(400).json({ error: 'Falta URL del sitio web' });
  const result = await scrapeWebsite(web);
  return res.json({ emails: result.emails, best: result.best, score: result.score });
}

// Scraping en paralelo: lanzamos todas las rutas a la vez, tomamos la mejor
async function scrapeWebsite(web) {
  const base = (web.startsWith('http') ? web : 'https://'+web).replace(/\/$/,'');
  // Rutas clave ordenadas por probabilidad
  const paths = ['','/contacto','/contact','/contactenos','/quienes-somos','/nosotros','/empresa','/about','/about-us'];
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const found = new Map();

  const fetchPath = async (path) => {
    try {
      const r = await fetch(base+path, {
        headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept-Language':'es-AR,es;q=0.9'},
        signal: AbortSignal.timeout(5000), redirect:'follow'
      });
      if (!r.ok) return;
      const html = await r.text();
      // Priorizar mailto: links
      (html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)||[]).forEach(m=>{
        const e=m.replace('mailto:','').toLowerCase();
        if(!isFake(e)){ const s=score(e)+10; if(!found.has(e)||found.get(e)<s) found.set(e,s); }
      });
      (html.match(emailRegex)||[]).forEach(e=>{
        e=e.toLowerCase(); if(!isFake(e)&&!found.has(e)) found.set(e,score(e));
      });
    } catch(_){}
  };

  // Primero: home + contacto en paralelo
  await Promise.all([fetchPath(''), fetchPath('/contacto'), fetchPath('/contact')]);

  // Si no encontramos nada bueno, buscar en más rutas en paralelo
  const bestSoFar = [...found.entries()].sort((a,b)=>b[1]-a[1])[0];
  if (!bestSoFar || bestSoFar[1] < 60) {
    await Promise.all(paths.slice(3).map(p => fetchPath(p)));
  }

  const sorted=[...found.entries()].sort((a,b)=>b[1]-a[1]);
  return { emails:sorted.map(([e])=>e), best:sorted[0]?.[0]||null, score:sorted[0]?.[1]||0 };
}

// Intenta adivinar el dominio de la empresa desde su nombre
function guessDomain(nombre='') {
  if (!nombre) return null;
  const clean = nombre.toLowerCase()
    .replace(/s\.a\.?$/,'').replace(/s\.r\.l\.?$/,'').replace(/\s+(sa|srl|sl|ltda?)$/,'')
    .trim().replace(/[^a-z0-9]/g,'');
  if (clean.length < 3) return null;
  return `${clean}.com.ar`;
}

function score(email) {
  const local=email.split('@')[0].toLowerCase();
  if(/^[a-z]+\.[a-z]+@/.test(email)) return 95;
  if(local.includes('comercial')||local.includes('ventas')||local.includes('venta')) return 90;
  if(local.includes('export')||local.includes('import')||local.includes('logistic')) return 85;
  if(local.includes('gerencia')||local.includes('gerente')||local.includes('direccion')) return 85;
  if(local.includes('administr')||local.includes('admin')) return 70;
  if(local.includes('contacto')||local.includes('contact')) return 65;
  if(local==='info'||local.includes('info')) return 40;
  return 50;
}
function isFake(e){ return ['example','sentry','domain','noreply','no-reply','wordpress','wix','jquery','w3.org','.png','.jpg','yourname','tuempresa','bing.com','microsoft.com','google.com','schema.org','cloudflare'].some(b=>e.includes(b)); }
function extractDomain(w=''){ try{ const u=w.startsWith('http')?w:'https://'+w; return new URL(u).hostname.replace('www.',''); }catch(_){ return w.replace(/^https?:\/\/(www\.)?/,'').split('/')[0]; } }
