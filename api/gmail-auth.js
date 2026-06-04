// api/gmail-auth.js — inicia el flujo OAuth con Google
export default async function handler(req, res) {
  const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
  const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI;

  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.status(500).json({ error: 'Faltan GMAIL_CLIENT_ID o GMAIL_REDIRECT_URI' });
  }

  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
  ].join(' ');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  res.redirect(authUrl.toString());
}
