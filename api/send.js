// api/send.js — envío real de emails via Gmail + registro en Supabase
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, html, text, leadId, enfoque, nombreLead, ciudadLead } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: 'Faltan datos: to, subject' });

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_PASS = process.env.GMAIL_PASS;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!GMAIL_USER || !GMAIL_PASS) {
    return res.status(500).json({ error: 'Variables de Gmail no configuradas en Vercel' });
  }

  try {
    // 1. Enviar el email
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

    // 2. Actualizar Supabase si hay leadId
    if (leadId && SUPABASE_URL && SUPABASE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

      // Marcar el lead como contactado
      await supabase
        .from('leads')
        .update({ 
          estado: 'contactado', 
          ultimo_contacto: new Date().toISOString() 
        })
        .eq('id', leadId);

      // Registrar el envío en la tabla sent_emails
      await supabase
        .from('sent_emails')
        .insert({
          lead_id: leadId,
          nombre_lead: nombreLead || '',
          ciudad_lead: ciudadLead || '',
          email_destino: to,
          asunto: subject,
          enfoque: enfoque || '',
          fecha_envio: new Date().toISOString(),
          estado: 'enviado'
        });
    }

    return res.json({ ok: true, message: 'Email enviado y registrado correctamente' });

  } catch (e) {
    return res.status(500).json({ error: `Error: ${e.message}` });
  }
}
