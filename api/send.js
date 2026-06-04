// api/send.js — envío real de emails via Gmail (Nodemailer)
import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, html, text } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: 'Faltan datos: to, subject' });

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_PASS = process.env.GMAIL_PASS;
  if (!GMAIL_USER || !GMAIL_PASS) {
    return res.status(500).json({ error: 'Variables de Gmail no configuradas en Vercel' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });

    await transporter.sendMail({
      from: `"Puerto Seco Rojas" <${GMAIL_USER}>`,
      to,
      subject,
      text: text || '',
      html: html || text || '',
    });

    return res.json({ ok: true, message: 'Email enviado correctamente' });
  } catch (e) {
    return res.status(500).json({ error: `Error Gmail: ${e.message}` });
  }
}
