export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { prompt, system, _groqKey } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Falta prompt' });
  const GROQ_KEY = _groqKey || process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_API_KEY no configurada' });
  try {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': Bearer  },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 1200, temperature: 0.7 }),
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: Groq error:  });
    }
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    return res.json({ text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
