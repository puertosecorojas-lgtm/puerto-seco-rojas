// api/scrape-email.js
// mode: 'scrape' (default) — scraper del sitio web
// mode: 'find'             — busqueda completa: web + Hunter + Bing + SMTP
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
    // ── Modo find: cascada completa ─────────────────────────────────────────
    const out = { email: null, fuente: null, score: 0, alternativas: [], log: [] };

    // Paso 1: scraper web
    if (web) {
      const s = await scrapeWebsite(web);
      if (s.best) {
        out.log.push(`Web: ${s.best} (score ${s.score})`);
        out.alternativas.push(...s.emails.slice(0,3).map(e=>({email:e,fuente:'web'})));
        if (s.score >= 60) { out.email=s.best; out.fuente='web'; out.score=s.score; }
      } else out.log.push('Web: sin resultados');
    }

    // Paso 2: Hunter
    if (!out.email && HUNTER_KEY && web) {
      try {
        const domain = extractDomain(web);
        if (domain) {
          const d = await (await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_KEY}&limit=5`)).json();
          const emails = (d.data?.emails||[]).sort((a,b)=>(b.confidence||0)-(a.confidence||0));
          if (emails.length>0) {
            const best=emails[0];
            out.log.push(`Hunter: ${best.value} (${best.confidence}%)`);
            out.alternativas.push(...emails.slice(0,3).map(e=>({email:e.value,fuente:'hunter',score:e.confidence})));
            if (best.confidence>=50) { out.email=best.value; out.fuente='hunter'; out.score=best.confidence; if(best.first_name) out.contacto_nombre=`${best.first_name} ${best.last_name||''}`.trim(); if(best.position) out.contacto_cargo=best.position; }
          } else out.log.push('Hunter: sin resultados');
        }
      } catch(e){ out.log.push(`Hunter error: ${e.message}`); }
    }

    // Paso 3: Bing
    if (!out.email && nombre) {
      try {
        const q = `"${nombre}" email contacto${ciudad?' '+ciudad:''} Argentina`;
        const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=es`,
          { headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept-Language':'es-AR,es;q=0.9'}, signal:AbortSignal.timeout(8000) });
        if (r.ok) {
          const html = await r.text();
          const found = [...new Set((html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)||[]).map(e=>e.toLowerCase()))].filter(e=>!isFake(e));
          if (found.length>0) {
            const words = nombre.toLowerCase().split(/\s+/).filter(w=>w.length>3);
            const sorted = found.sort((a,b)=>(words.some(w=>b.includes(w))?1:0)-(words.some(w=>a.includes(w))?1:0));
            out.log.push(`Bing: ${sorted[0]}`);
            out.alternativas.push(...sorted.slice(0,3).map(e=>({email:e,fuente:'bing'})));
            out.email=sorted[0]; out.fuente='bing'; out.score=40;
          } else out.log.push('Bing: sin emails');
        }
      } catch(e){ out.log.push(`Bing error: ${e.message}`); }
    }

    // Paso 4: Patrones SMTP
    if (!out.email && web) {
      try {
        const domain = extractDomain(web);
        if (domain) {
          const dns = await (await fetch(`https://dns.google/resolve?name=${domain}&type=MX`,{signal:AbortSignal.timeout(3000)})).json();
          if ((dns.Answer||[]).length>0) {
            for (const p of ['info','contacto','ventas','comercial','administracion','gerencia']) {
              out.email=`${p}@${domain}`; out.fuente='smtp_pattern'; out.score=45; break;
            }
            if (out.email) out.log.push(`SMTP pattern: ${out.email}`);
          } else out.log.push('SMTP: sin MX');
        }
      } catch(e){ out.log.push(`SMTP error: ${e.message}`); }
    }

    // Deduplicar alternativas
    const seen=new Set([out.email].filter(Boolean));
    out.alternativas=out.alternativas.filter(a=>{ if(seen.has(a.email)) return false; seen.add(a.email); return true; }).slice(0,3);
    return res.json(out);
  }

  // ── Modo scrape (default) ───────────────────────────────────────────────
  if (!web) return res.status(400).json({ error: 'Falta URL del sitio web' });
  const result = await scrapeWebsite(web);
  return res.json({ emails: result.emails, best: result.best });
}

async function scrapeWebsite(web) {
  const base = (web.startsWith('http') ? web : 'https://'+web).replace(/\/$/,'');
  const paths = ['','/contacto','/contact','/contactenos','/contactenos.html','/contacto.html','/contact.html','/nosotros','/quienes-somos','/empresa','/about','/about-us','/equipo','/team','/staff'];
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const found = new Map();
  for (const path of paths) {
    try {
      const r = await fetch(base+path, { headers:{'User-Agent':'Mozilla/5.0','Accept-Language':'es-AR,es;q=0.9'}, signal:AbortSignal.timeout(6000), redirect:'follow' });
      if (!r.ok) continue;
      const html = await r.text();
      (html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g)||[]).forEach(m=>{
        const e=m.replace('mailto:','').toLowerCase(); if(!isFake(e)){ const s=score(e)+10; if(!found.has(e)||found.get(e)<s) found.set(e,s); }
      });
      (html.match(emailRegex)||[]).forEach(e=>{ e=e.toLowerCase(); if(!isFake(e)&&!found.has(e)) found.set(e,score(e)); });
      const best=[...found.entries()].sort((a,b)=>b[1]-a[1])[0];
      if (best && best[1]>=80) break;
    } catch(_){ continue; }
  }
  const sorted=[...found.entries()].sort((a,b)=>b[1]-a[1]);
  return { emails:sorted.map(([e])=>e), best:sorted[0]?.[0]||null, score:sorted[0]?.[1]||0 };
}

function score(email) {
  const local=email.split('@')[0].toLowerCase();
  if(/^[a-z]+\.[a-z]+@/.test(email)) return 95;
  if(local.includes('comercial')||local.includes('ventas')) return 90;
  if(local.includes('export')||local.includes('import')) return 85;
  if(local.includes('gerencia')||local.includes('gerente')) return 85;
  if(local.includes('administr')) return 70;
  if(local.includes('contacto')||local.includes('contact')) return 65;
  if(local==='info') return 40;
  return 50;
}
function isFake(e){ return ['example','sentry','domain','noreply','no-reply','wordpress','wix','jquery','w3.org','.png','.jpg','yourname','tuempresa','bing.com','microsoft.com','google.com'].some(b=>e.includes(b)); }
function extractDomain(w=''){ try{ const u=w.startsWith('http')?w:'https://'+w; return new URL(u).hostname.replace('www.',''); }catch(_){ return w.replace(/^https?:\/\/(www\.)?/,'').split('/')[0]; } }
