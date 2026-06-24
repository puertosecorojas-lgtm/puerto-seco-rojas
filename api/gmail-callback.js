// api/gmail-callback.js — recibe el código OAuth y guarda los tokens en Supabase
export default async function handler(req, res) {
  const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
  const REDIRECT_URI  = process.env.GMAIL_REDIRECT_URI;
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;

  const { code, error } = req.query;

  if (error) {
    return res.redirect('/?gmail_error=' + encodeURIComponent(error));
  }
  if (!code) {
    return res.status(400).json({ error: 'No se recibió el código OAuth' });
  }

  try {
    // 1. Intercambiar código por tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    // 2. Guardar tokens en Supabase tabla configuracion (id=1)
    const sbHeaders = {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=representation',
    };

    // UPSERT: crea la fila si no existe, actualiza si existe (mas robusto que PATCH)
    await fetch(`${SUPABASE_URL}/rest/v1/configuracion`, {
      method: 'POST',
      headers: {
        ...sbHeaders,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id:                  1,
        gmail_access_token:  tokens.access_token,
        gmail_refresh_token: tokens.refresh_token,
        gmail_token_expiry:  new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      }),
    });

    // 3. Redirigir al CRM con éxito
    res.redirect('/?gmail_connected=1');
  } catch (err) {
    res.redirect('/?gmail_error=' + encodeURIComponent(err.message));
  }
}
