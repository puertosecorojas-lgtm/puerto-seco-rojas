// api/apify-v2.js — Apify unificado
// action: 'start'  → lanza run, devuelve runId
// action: 'status' → consulta estado, devuelve leads si termino
// action: 'cron'   → busqueda diaria automatica por zona (lunes-viernes)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cron-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, url, searchQuery, runId, _apifyKey, _hunterKey } = req.body || {};
  const APIFY_KEY  = _apifyKey  || process.env.APIFY_API_KEY;
  const HUNTER_KEY = _hunterKey || process.env.HUNTER_API_KEY;
  const SB_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SB_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!APIFY_KEY) return res.status(500).json({ error: 'APIFY_API_KEY no configurada' });

  // ── START ────────────────────────────────────────────────────────────────
  if (action === 'start') {
    if (!url && !searchQuery) return res.status(400).json({ error: 'Falta url o searchQuery' });
    const input = url
      ? { startUrls: [{ url }], maxCrawledPlacesPerSearch: 1 }
      : { searchStringsArray: [searchQuery], maxCrawledPlacesPerSearch: 20, language: 'es', countryCode: 'ar' };
    try {
      const r = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      if (!r.ok) return res.status(r.status).json({ error: `Apify error ${r.status}` });
      const data = await r.json();
      const runId = data.data?.id;
      if (!runId) return res.status(500).json({ error: 'Apify no devolvio runId' });
      return res.json({ ok: true, runId });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── STATUS ───────────────────────────────────────────────────────────────
  if (action === 'status') {
    if (!runId) return res.status(400).json({ error: 'Falta runId' });
    try {
      const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_KEY}`);
      const sd = await s.json();
      const status = sd.data?.status;
      if (!status) return res.status(500).json({ error: 'No se pudo obtener estado' });
      if (status === 'RUNNING' || status === 'READY') return res.json({ status: 'running' });
      if (status !== 'SUCCEEDED') return res.json({ status: 'failed', error: `Run: ${status}` });
      const items = await (await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_KEY}&limit=50`)).json();
      const leads = await processItems(items, HUNTER_KEY);
      return res.json({ status: 'done', leads, total: leads.length });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CRON ────────────────────────────────────────────────────────────────
  if (action === 'cron') {
    const secret = req.headers['x-cron-secret'];
    if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET)
      return res.status(401).json({ error: 'No autorizado' });
    if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Faltan variables Supabase' });

    const day = new Date().getUTCDay();
    const zonas = {
      1: { ciudad: 'Junin',     provincia: 'Buenos Aires', q: 'empresa industrial' },
      2: { ciudad: 'Lincoln',   provincia: 'Buenos Aires', q: 'empresa exportadora' },
      3: { ciudad: 'Vedia',     provincia: 'Buenos Aires', q: 'empresa distribuidora' },
      4: { ciudad: 'Colon',     provincia: 'Buenos Aires', q: 'empresa industrial fabrica' },
      5: { ciudad: 'Laboulaye', provincia: 'Cordoba',      q: 'empresa exportadora agro' },
    };
    const zona = zonas[day];
    if (!zona) return res.json({ ok: true, msg: 'Dia no laborable' });

    const log = []; let insertados = 0; let duplicados = 0;
    const sbH = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };

    const existentes = await (await fetch(`${SB_URL}/rest/v1/leads?select=email,empresa&limit=2000`, { headers: sbH })).json();
    const emailsEx   = new Set((existentes||[]).map(l=>(l.email||'').toLowerCase()).filter(Boolean));
    const empresasEx = new Set((existentes||[]).map(l=>(l.empresa||'').toLowerCase()).filter(Boolean));

    let leads = [];
    try {
      const searchQ = `${zona.q} ${zona.ciudad} Argentina`;
      const r = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY_KEY}`,
        { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ searchStringsArray:[searchQ], maxCrawledPlacesPerSearch:15, language:'es', countryCode:'ar' }) });
      if (r.ok) {
        const rd = await r.json(); const rid = rd.data?.id;
        if (rid) {
          let status='RUNNING', att=0;
          while(status==='RUNNING'&&att<30){ await new Promise(r=>setTimeout(r,3000)); const sd=await(await fetch(`https://api.apify.com/v2/actor-runs/${rid}?token=${APIFY_KEY}`)).json(); status=sd.data?.status; att++; }
          if(status==='SUCCEEDED'){ const items=await(await fetch(`https://api.apify.com/v2/actor-runs/${rid}/dataset/items?token=${APIFY_KEY}&limit=30`)).json(); leads=await processItems(items,HUNTER_KEY,zona); }
          log.push(`Apify: ${leads.length} resultados`);
        }
      }
    } catch(e){ log.push(`Apify error: ${e.message}`); }

    const nuevos=[]; const vistos=new Set();
    for(const l of leads){
      const ek=(l.email||'').toLowerCase(); const emp=(l.empresa||'').toLowerCase();
      if((ek&&emailsEx.has(ek))||(emp&&empresasEx.has(emp))||(emp&&vistos.has(emp))){ duplicados++; continue; }
      vistos.add(emp); l.estado='pendiente_revision'; l.contactado=false; nuevos.push(l);
    }
    if(nuevos.length>0){
      const r=await fetch(`${SB_URL}/rest/v1/leads`,{method:'POST',headers:sbH,body:JSON.stringify(nuevos)});
      if(r.ok) insertados=nuevos.length; else log.push('Error Supabase: '+(await r.text()).substring(0,100));
    }
    return res.json({ ok:true, zona:`${zona.ciudad}`, insertados, duplicados, log });
  }

  return res.status(400).json({ error: 'action debe ser: start | status | cron' });
}

async function processItems(items, HUNTER_KEY, zona={}) {
  const leads = (items||[]).filter(p=>p.title).map(p=>({
    nombre: p.title, empresa: p.title,
    tipo: clasificar(p.categoryName||''),
    ciudad: zona.ciudad || extractCity(p.address||''),
    zona:   zona.provincia || mapZona(p.address||''),
    email: p.email||'', email_status: p.email?'sin_verificar':'sin_email',
    telefono: p.phone||'', web: p.website||'', direccion: p.address||'', fuente:'apify_maps',
  }));
  if (HUNTER_KEY) {
    const sinEmail = leads.filter(l=>!l.email&&l.web).slice(0,10);
    await Promise.allSettled(sinEmail.map(async lead=>{
      try {
        const domain = extractDomain(lead.web); if(!domain) return;
        const d=await(await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_KEY}&limit=3`)).json();
        const emails=(d.data?.emails||[]).sort((a,b)=>(b.confidence||0)-(a.confidence||0));
        if(emails.length>0){ const best=emails[0]; lead.email=best.value; lead.email_status=best.confidence>70?'verificado':'sin_verificar'; lead.contacto_nombre=best.first_name?`${best.first_name} ${best.last_name||''}`.trim():''; lead.contacto_cargo=best.position||''; }
      } catch(_){}
    }));
  }
  return leads;
}

function clasificar(c=''){
  c=c.toLowerCase();
  if(c.includes('aduana')||c.includes('despachante')) return 'despachante';
  if(c.includes('logistic')||c.includes('transporte')) return 'operador_logistico';
  if(c.includes('import')||c.includes('export')) return 'importador_exportador';
  if(c.includes('agro')||c.includes('grano')) return 'agro_industrial';
  return 'empresa';
}
function extractCity(a=''){ const p=a.split(','); return p.length>=2?p[p.length-2].trim():p[0].trim(); }
function mapZona(t=''){ t=t.toLowerCase(); if(t.includes('santa fe')) return 'Santa Fe'; if(t.includes('cordoba')||t.includes('córdoba')) return 'Cordoba'; return 'Bs.As.'; }
function extractDomain(w=''){ try{ const u=w.startsWith('http')?w:'https://'+w; return new URL(u).hostname.replace('www.',''); }catch(_){ return w.replace(/^https?:\/\/(www\.)?/,'').split('/')[0]; } }
