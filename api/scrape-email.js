// api/scrape-email.js
// mode: 'find'   — cascada completa: Jina Reader + fetch paralelo + Hunter + Bing + SMTP
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

    // Paso 1a: Jina Reader (renderiza JS, bypasea anti-bots, gratis)
    if (web && !out.email) {
      try {
        const jinaUrl = `https://r.jina.ai/${web.startsWith('http') ? web : 'https://'+web}`;
        const r = await fetch(jinaUrl, {
          headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' },
          signal: AbortSignal.timeout(7000)
        });
        if (r.ok) {
          const text = await r.text();
          const emails = extractEmails(text).filter(e => !isFake(e));
          if (emails.length > 0) {
            const best = emails.sort((a,b) => scoreEmail(b) - scoreEmail(a))[0];
            out.log.push(`Jina: ${best} (score ${scoreEmail(best)})`);
            out.alternativas.push(...emails.slice(0,3).map(e=>({email:e,fuente:'jina'})));
            if (scoreEmail(best) >= 40) { out.email=best; out.fuente='jina'; out.score=scoreEmail(best); }
          } else out.log.push('Jina: sin emails en texto');
        }
      } catch(e){ out.log.push(`Jina error: ${e.message}`); }
    }

    // Paso 1b: scraper fetch paralelo (home + /contacto + /contact)
    if (web && !out.email) {
      const s = await scrapeWebsite(web);
      if (s.best) {
        out.log.push(`Web fetch: ${s.best} (score ${s.score})`);
        out.alternativas.push(...s.emails.slice(0,3).map(e=>({email:e,fuente:'web'})));
        if (s.score >= 40) { out.email=s.best; out.fuente='web'; out.score=s.score; }
      } else out.log.push('Web fetch: sin resultados');
    }

    // Paso 2: Hunter.io (base de datos de emails por dominio)
    if (!out.email && HUNTER_KEY && web) {
      try {
        const domain = extractDomain(web);
        if (domain) {
          const d = await (await fetch(
            `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_KEY}&limit=5`,
            { signal: AbortSignal.timeout(5000) }
          )).json();
          const emails = (d.data?.emails||[]).sort((a,b)=>(b.confidence||0)-(a.confidence||0));
          if (emails.length > 0) {
            const best = emails[0];
            out.log.push(`Hunter: ${best.value} (${best.confidence}%)`);
            out.alternativas.push(...emails.slice(0,3).map(e=>({email:e.value,fuente:'hunter',score:e.confidence})));
            if (best.confidence >= 40) {
              out.email=best.value; out.fuente='hunter'; out.score=best.confidence;
              if(best.first_name) out.contacto_nombre=`${best.first_name} ${best.last_name||''}`.trim();
              if(best.position) out.contacto_cargo=best.position;
            }
          } else out.log.push('Hunter: sin resultados');
        }
      } catch(e){ out.log.push(`Hunter error: ${e.message}`); }
    }

    // Paso 3: Bing — busca email por nombre empresa (funciona sin website)
    if (!out.email && nombre) {
      try {
        const queries = [
          `"${nombre}" email contacto${ciudad?' '+ciudad:''} Argentina`,
          `${nombre} ${ciudad||''} Argentina mail site:paginasamarillas.com.ar OR site:guialocal.com.ar OR site:infonegocios.net`,
        ];
        for (const q of queries) {
          if (out.email) break;
          const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=es`, {
            headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept-Language':'es-AR,es;q=0.9'},
            signal: AbortSignal.timeout(6000)
          });
          if (!r.ok) continue;
          const html = await r.text();
          const found = [...new Set(extractEmails(html).filter(e=>!isFake(e)))];
          if (found.length > 0) {
            const words = nombre.toLowerCase().split(/\s+/).filter(w=>w.length>3);
            const sorted = found.sort((a,b)=>(words.some(w=>b.includes(w))?1:0)-(words.some(w=>a.includes(w))?1:0));
            out.log.push(`Bing: ${sorted[0]}`);
            out.alternativas.push(...sorted.slice(0,3).map(e=>({email:e,fuente:'bing'})));
            out.email=sorted[0]; out.fuente='bing'; out.score=40;
          }
        }
        if (!out.email) out.log.push('Bing: sin emails');
      } catch(e){ out.log.push(`Bing error: ${e.message}`); }
    }

    // Paso 4: Jina Reader en pagina de contacto especifica
    if (!out.email && web) {
      try {
        const contactUrl = `${web.startsWith('http')?web:'https://'+web}/contacto`;
        const jinaUrl = `https://r.jina.ai/${contactUrl}`;
        const r = await fetch(jinaUrl, {
          headers: {'Accept':'text/plain'},
          signal: AbortSignal.timeout(6000)
        });
        if (r.ok) {
          const text = await r.text();
          const emails = extractEmails(text).filter(e=>!isFake(e));
          if (emails.length>0) {
            const best = emails.sort((a,b)=>scoreEmail(b)-scoreEmail(a))[0];
            out.log.push(`Jina /contacto: ${best}`);
            out.email=best; out.fuente='jina_contacto'; out.score=scoreEmail(best);
          }
        }
      } catch(_){}
    }

    // Paso 5: SMTP pattern + MX check
    if (!out.email) {
      const domain = web ? extractDomain(web) : guessDomain(nombre);
      if (domain) {
        try {
          const dns = await (await fetch(`https://dns.google/resolve?name=${domain}&type=MX`,{signal:AbortSignal.timeout(3000)})).json();
          if ((dns.Answer||[]).length > 0) {
            out.email=`info@${domain}`; out.fuente='smtp_pattern'; out.score=25;
            out.log.push(`SMTP: info@${domain} (MX ok)`);
          } else out.log.push(`SMTP: ${domain} sin MX`);
        } catch(e){ out.log.push(`SMTP error: ${e.message}`); }
      }
    }

    const seen = new Set([out.email].filter(Boolean));
    out.alternativas = out.alternativas.filter(a=>{ if(seen.has(a.email)) return false; seen.add(a.email); return true; }).slice(0,3);
    out.best = out.email;
    return res.json(out);
  }

  // ── Modo scrape (default) ───────────────────────────────────────────────
  if (!web) return res.status(400).json({ error: 'Falta URL del sitio web' });
  const result = await scrapeWebsite(web);
  return res.json({ emails: result.emails, best: result.best, score: result.score });
}

// Scraping en paralelo con fetch nativo
async function scrapeWebsite(web) {
  const base = (web.startsWith('http') ? web : 'https://'+web).replace(/\/$/,'');
  const paths = ['','/contacto','/contact','/contactenos','/quienes-somos','/nosotros','/empresa','/about'];
  const found = new Map();

  const fetchPath = async (path) => {
    try {
      const r = await fetch(base+path, {
        headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept-Language':'es-AR,es;q=0.9'},
        signal: AbortSignal.timeout(5000), redirect:'follow'
      });
      if (!r.ok) return;
      const html = await r.text();
      (html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)||[]).forEach(m=>{
        const e=m.replace('mailto:','').toLowerCase();
        if(!isFake(e)){ const s=scoreEmail(e)+10; if(!found.has(e)||found.get(e)<s) found.set(e,s); }
      });
      extractEmails(html).forEach(e=>{ if(!isFake(e)&&!found.has(e)) found.set(e,scoreEmail(e)); });
    } catch(_){}
  };

  await Promise.all([fetchPath(''), fetchPath('/contacto'), fetchPath('/contact')]);
  const best = [...found.entries()].sort((a,b)=>b[1]-a[1])[0];
  if (!best || best[1] < 60) {
    await Promise.all(paths.slice(3).map(p => fetchPath(p)));
  }

  const sorted = [...found.entries()].sort((a,b)=>b[1]-a[1]);
  return { emails:sorted.map(([e])=>e), best:sorted[0]?.[0]||null, score:sorted[0]?.[1]||0 };
}

function extractEmails(text) {
  return [...new Set((text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)||[]).map(e=>e.toLowerCase()))];
}
function scoreEmail(email) {
  const local = email.split('@')[0].toLowerCase();
  if(/^[a-z]+\.[a-z]+@/.test(email)) return 95;
  if(local.includes('comercial')||local.includes('ventas')||local.includes('venta')) return 90;
  if(local.includes('export')||local.includes('import')||local.includes('logistic')) return 85;
  if(local.includes('gerencia')||local.includes('gerente')||local.includes('direccion')) return 85;
  if(local.includes('administr')||local.includes('admin')) return 70;
  if(local.includes('contacto')||local.includes('contact')) return 65;
  if(local==='info'||local==='hola') return 40;
  return 50;
}
function isFake(e){ return ['example','sentry','domain','noreply','no-reply','wordpress','wix','jquery','w3.org','.png','.jpg','yourname','tuempresa','bing.com','microsoft.com','google.com','schema.org','cloudflare','jquery'].some(b=>e.includes(b)); }
function extractDomain(w=''){ try{ const u=w.startsWith('http')?w:'https://'+w; return new URL(u).hostname.replace('www.',''); }catch(_){ return w.replace(/^https?:\/\/(www\.)?/,'').split('/')[0]; } }
function guessDomain(nombre=''){ const c=nombre.toLowerCase().replace(/s\.a\.?$|s\.r\.l\.?$|\s+(sa|srl)$/,'').trim().replace(/[^a-z0-9]/g,''); return c.length>=3?`${c}.com.ar`:null; }
