// api/gmail-sync.js — lee respuestas de Gmail y actualiza leads en Supabase
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;

  const sbHeaders = {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer':        'return=representation',
  };

  try {
    // 1. Obtener tokens guardados en Supabase
    const cfgRes = await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1&select=gmail_access_token,gmail_refresh_token,gmail_token_expiry`, {
      headers: sbHeaders,
    });
    const cfgData = await cfgRes.json();
    const cfg = cfgData[0];

    if (!cfg?.gmail_refresh_token) {
      return res.status(200).json({ ok: false, error: 'Gmail no conectado', nuevas: 0 });
    }

    // 2. Refrescar token si expiró
    let accessToken = cfg.gmail_access_token;
    const expiry = new Date(cfg.gmail_token_expiry);
    if (new Date() >= expiry) {
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: cfg.gmail_refresh_token,
          grant_type:    'refresh_token',
        }),
      });
      const refreshData = await refreshRes.json();
      if (refreshData.error) throw new Error('Error refrescando token: ' + refreshData.error);
      accessToken = refreshData.access_token;
      await fetch(`${SUPABASE_URL}/rest/v1/configuracion?id=eq.1`, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({
          gmail_access_token: accessToken,
          gmail_token_expiry: new Date(Date.now() + refreshData.expires_in * 1000).toISOString(),
        }),
      });
    }

    const gmailHeaders = { Authorization: `Bearer ${accessToken}` };

    // 3. Obtener emails enviados de Supabase
    const enviadosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/emails_enviados?select=id,destinatario_email,lead_id,estado&estado=eq.enviado&limit=100`,
      { headers: sbHeaders }
    );
    const enviados = await enviadosRes.json();
    if (!enviados.length) return res.status(200).json({ ok: true, nuevas: 0 });

    // 4. Buscar respuestas en Gmail
    const since = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const query = `in:inbox after:${since}`;
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`,
      { headers: gmailHeaders }
    );
    const listData = await listRes.json();
    const messages = listData.messages || [];

    let nuevas = 0;
    const respuestas = [];

    for (const msg of messages) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: gmailHeaders }
      );
      const msgData = await msgRes.json();
      const headers_msg = msgData.payload?.headers || [];
      const from    = headers_msg.find(h => h.name === 'From')?.value || '';
      const subject = headers_msg.find(h => h.name === 'Subject')?.value || '';
      const date    = headers_msg.find(h => h.name === 'Date')?.value || '';

      const emailMatch = from.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (!emailMatch) continue;
      const fromEmail = emailMatch[0].toLowerCase();

      const enviado = enviados.find(e => e.destinatario_email?.toLowerCase() === fromEmail);
      if (!enviado) continue;

      nuevas++;
      respuestas.push({ email: fromEmail, subject, date, lead_id: enviado.lead_id });

      await fetch(`${SUPABASE_URL}/rest/v1/emails_enviados?id=eq.${enviado.id}`, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({ estado: 'respondido' }),
      });

      if (enviado.lead_id) {
        await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${enviado.lead_id}`, {
          method: 'PATCH',
          headers: sbHeaders,
          body: JSON.stringify({ estado: 'interesado' }),
        });
      }
    }

    return res.status(200).json({ ok: true, nuevas, respuestas });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
