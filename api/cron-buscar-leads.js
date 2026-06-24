// api/cron-buscar-leads.js
// Corre automáticamente lunes a viernes a las 9am Argentina (12:00 UTC)
// Busca empresas en la zona de influencia del Puerto Seco Rojas
// y las inserta en Supabase como pendiente_revision

export default async function handler(req, res) {
  // Vercel cron llama con GET. También permitir POST para pruebas manuales.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const APOLLO_KEY  = process.env.APOLLO_API_KEY;
  const APIFY_KEY   = process.env.APIFY_API_KEY;
  const HUNTER_KEY  = process.env.HUNTER_API_KEY;
  const SB_URL      = process.env.SUPABASE_URL;
  const SB_KEY      = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Faltan variables de Supabase (SUPABASE_URL / SUPABASE_KEY)' });
  }

  // ─── Rotación diaria por zona ───────────────────────────────────────────────
  // Usamos el día UTC (lunes=1 … viernes=5)
  const day = new Date().getUTCDay(); // 0=dom, 1=lun … 6=sáb

  const zonas = {
    1: { ciudad: 'Junín',     provincia: 'Buenos Aires', queries: ['empresa industrial', 'distribuidora', 'agro', 'comercio exterior'] },
    2: { ciudad: 'Lincoln',   provincia: 'Buenos Aires', queries: ['empresa', 'industria', 'exportadora', 'importadora'] },
    3: { ciudad: 'Vedia',     provincia: 'Buenos Aires', queries: ['empresa', 'distribuidora', 'agro industrial'] },
    4: { ciudad: 'Colón',     provincia: 'Buenos Aires', queries: ['empresa industrial', 'fábrica', 'logística', 'comercio'] },
    5: { ciudad: 'Laboulaye', provincia: 'Córdoba',      queries: ['empresa', 'exportadora', 'agro', 'industria'] },
  };

  const zona = zonas[day];
  if (!zona) {
    return res.json({ ok: true, msg: 'Día no laborable, sin búsqueda.' });
  }

  const log = [];
  let insertados = 0;
  let duplicados = 0;

  // ─── Helpers Supabase ────────────────────────────────────────────────────────
  async function sbGet(path) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
      },
    });
    return r.json();
  }

  async function sbInsert(table, rows) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
    return r;
  }

  // ─── Cargar emails/empresas ya existentes para deduplicar ───────────────────
  const existentes = await sbGet('leads?select=email,empresa&limit=2000');
  const emailsExistentes  = new Set((existentes || []).map(l => (l.email || '').toLowerCase().trim()).filter(Boolean));
  const empresasExistentes = new Set((existentes || []).map(l => (l.empresa || '').toLowerCase().trim()).filter(Boolean));

  // ─── Búsqueda Apollo ─────────────────────────────────────────────────────────
  let leadsApollo = [];
  if (APOLLO_KEY) {
    try {
      const body = {
        page: 1,
        per_page: 25,
        organization_locations: [`${zona.ciudad}, ${zona.provincia}, Argentina`],
        q_organization_keyword_tags: zona.queries,
      };
      const r = await fetch('https://api.apollo.io/v1/organizations/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': APOLLO_KEY,
        },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const data = await r.json();
        leadsApollo = (data.organizations || []).map(org => ({
          nombre:           org.name || '',
          empresa:          org.name || '',
          tipo:             detectarTipo(org.name, org.short_description),
          ciudad:           zona.ciudad,
          zona:             zona.provincia,
          email:            org.contact_email || '',
          email_status:     org.contact_email ? 'sin_verificar' : 'sin_email',
          telefono:         org.sanitized_phone || org.phone || '',
          web:              org.website_url || '',
          linkedin:         org.linkedin_url || '',
          fuente:           'apollo_cron',
          notas:            org.short_description ? org.short_description.substring(0, 150) : '',
          estado:           'pendiente_revision',
          contactado:       false,
        }));
        log.push(`Apollo: ${leadsApollo.length} resultados para ${zona.ciudad}`);
      } else {
        log.push(`Apollo error: ${r.status}`);
      }
    } catch (e) {
      log.push(`Apollo excepción: ${e.message}`);
    }
  }

  // ─── Búsqueda Apify (Google Maps) ────────────────────────────────────────────
  let leadsApify = [];
  if (APIFY_KEY) {
    // Usar solo el primer query para ahorrar créditos
    const searchQuery = `${zona.queries[0]} ${zona.ciudad} Argentina`;
    try {
      const runRes = await fetch(
        `https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            searchStringsArray: [searchQuery],
            maxCrawledPlacesPerSearch: 15,
            language: 'es',
            countryCode: 'ar',
          }),
        }
      );

      if (runRes.ok) {
        const runData = await runRes.json();
        const runId = runData.data?.id;

        if (runId) {
          // Esperar hasta 90 seg
          let status = 'RUNNING';
          let attempts = 0;
          while (status === 'RUNNING' && attempts < 30) {
            await new Promise(r => setTimeout(r, 3000));
            const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_KEY}`);
            const sd = await s.json();
            status = sd.data?.status;
            attempts++;
          }

          if (status === 'SUCCEEDED') {
            const resultsRes = await fetch(
              `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_KEY}&limit=30`
            );
            const results = await resultsRes.json();

            leadsApify = (results || [])
              .filter(p => p.title)
              .map(place => {
                const email = place.email || '';
                return {
                  nombre:       place.title,
                  empresa:      place.title,
                  tipo:         detectarTipoCategoria(place.categoryName || ''),
                  ciudad:       zona.ciudad,
                  zona:         zona.provincia,
                  email:        email,
                  email_status: email ? 'sin_verificar' : 'sin_email',
                  telefono:     place.phone || place.phoneUnformatted || '',
                  web:          place.website || '',
                  direccion:    place.address || '',
                  fuente:       'apify_cron',
                  estado:       'pendiente_revision',
                  contactado:   false,
                };
              });

            log.push(`Apify: ${leadsApify.length} resultados para "${searchQuery}"`);

            // Buscar emails con Hunter para los que tienen web pero no email (máx 5 para no quemar créditos)
            if (HUNTER_KEY) {
              const sinEmail = leadsApify.filter(l => !l.email && l.web).slice(0, 5);
              await Promise.allSettled(sinEmail.map(async (lead) => {
                try {
                  const domain = extractDomain(lead.web);
                  if (!domain) return;
                  const r = await fetch(
                    `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_KEY}&limit=2`
                  );
                  const data = await r.json();
                  const emails = data.data?.emails || [];
                  if (emails.length > 0) {
                    const best = emails.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
                    lead.email = best.value;
                    lead.email_status = best.confidence > 70 ? 'verificado' : 'sin_verificar';
                    lead.contacto_nombre = best.first_name && best.last_name ? `${best.first_name} ${best.last_name}` : '';
                    lead.contacto_cargo  = best.position || '';
                  }
                } catch (_) {}
              }));
            }
          } else {
            log.push(`Apify terminó con estado: ${status}`);
          }
        }
      } else {
        log.push(`Apify error al iniciar: ${runRes.status}`);
      }
    } catch (e) {
      log.push(`Apify excepción: ${e.message}`);
    }
  }

  // ─── Combinar y deduplicar ───────────────────────────────────────────────────
  const todos = [...leadsApollo, ...leadsApify];
  const nuevos = [];
  const vistos = new Set(); // para no insertar duplicados entre Apollo y Apify en el mismo run

  for (const lead of todos) {
    const emailKey   = (lead.email || '').toLowerCase().trim();
    const empresaKey = (lead.empresa || '').toLowerCase().trim();

    // Duplicado si ya está en Supabase o ya lo vimos en este run
    if (
      (emailKey && emailsExistentes.has(emailKey)) ||
      (empresaKey && empresasExistentes.has(empresaKey)) ||
      (empresaKey && vistos.has(empresaKey))
    ) {
      duplicados++;
      continue;
    }

    vistos.add(empresaKey);
    nuevos.push(lead);
  }

  log.push(`${nuevos.length} leads nuevos / ${duplicados} duplicados descartados`);

  // ─── Insertar en Supabase ────────────────────────────────────────────────────
  if (nuevos.length > 0) {
    // Insertar en lotes de 20
    const chunks = [];
    for (let i = 0; i < nuevos.length; i += 20) chunks.push(nuevos.slice(i, i + 20));

    for (const chunk of chunks) {
      const r = await sbInsert('leads', chunk);
      if (r.ok) {
        insertados += chunk.length;
      } else {
        const err = await r.text();
        log.push(`Error insertando lote: ${err.substring(0, 100)}`);
      }
    }
  }

  return res.json({
    ok: true,
    fecha: new Date().toISOString(),
    zona: `${zona.ciudad}, ${zona.provincia}`,
    insertados,
    duplicados,
    log,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function detectarTipo(name = '', desc = '') {
  const t = (name + ' ' + desc).toLowerCase();
  if (t.includes('despachante') || t.includes('aduana') || t.includes('customs')) return 'despachante';
  if (t.includes('logistic') || t.includes('logística') || t.includes('transporte') || t.includes('freight')) return 'operador_logistico';
  if (t.includes('import') || t.includes('export') || t.includes('comercio exterior')) return 'importador_exportador';
  if (t.includes('agro') || t.includes('cereal') || t.includes('soja') || t.includes('grano')) return 'agro_industrial';
  return 'empresa';
}

function detectarTipoCategoria(category = '') {
  const c = category.toLowerCase();
  if (c.includes('aduana') || c.includes('despacho') || c.includes('despachante')) return 'despachante';
  if (c.includes('logistic') || c.includes('transporte') || c.includes('flete')) return 'operador_logistico';
  if (c.includes('import') || c.includes('export') || c.includes('comercio exterior')) return 'importador_exportador';
  if (c.includes('agro') || c.includes('grano') || c.includes('semilla') || c.includes('cereal')) return 'agro_industrial';
  return 'empresa';
}

function extractDomain(web = '') {
  try {
    const url = web.startsWith('http') ? web : 'https://' + web;
    return new URL(url).hostname.replace('www.', '');
  } catch (_) {
    return web.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }
}
