// api/segnalazione.js
// Backend Vercel — gestisce le segnalazioni DSA ex art. 16 Reg. UE 2022/2065
// Salva su Firestore e invia notifica email all'admin
//
// POST /api/segnalazione
// Body: { email, tipo, descrizione, offerta_id?, url_contenuto? }

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Inizializza Firebase Admin una sola volta (gestisce i cold start di Vercel)
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:    process.env.FIREBASE_PROJECT_ID,
      clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:   process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

// ── Validazione ──────────────────────────────────────────────────────────────

const TIPI_VALIDI = [
  'contenuto_illegale',
  'prezzo_errato',
  'offerta_scaduta',
  'informazione_falsa',
  'violazione_privacy',
  'altro',
];

function valida(body) {
  const errors = [];
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    errors.push('Email non valida');
  }
  if (!body.tipo || !TIPI_VALIDI.includes(body.tipo)) {
    errors.push(`Tipo non valido. Valori ammessi: ${TIPI_VALIDI.join(', ')}`);
  }
  if (!body.descrizione || body.descrizione.trim().length < 20) {
    errors.push('Descrizione troppo corta (minimo 20 caratteri)');
  }
  if (body.descrizione?.length > 2000) {
    errors.push('Descrizione troppo lunga (massimo 2000 caratteri)');
  }
  return errors;
}

// ── Notifica Telegram admin ──────────────────────────────────────────────────

async function notificaTelegram(ticketId, body) {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const chatId  = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) return;

  const msg = [
    `🚨 *Nuova segnalazione DSA*`,
    `ID: \`${ticketId}\``,
    `Tipo: ${body.tipo}`,
    `Email: ${body.email}`,
    body.offerta_id ? `Offerta: \`${body.offerta_id}\`` : '',
    ``,
    `_${body.descrizione.slice(0, 200)}${body.descrizione.length > 200 ? '...' : ''}_`,
    ``,
    `⏱ SLA: risposta motivata entro 48h`,
  ].filter(Boolean).join('\n');

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    chatId,
        text:       msg,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    console.error('Errore notifica Telegram:', err);
    // Non blocca il flusso — la segnalazione è già salvata su Firestore
  }
}

// ── Handler principale ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS — permette richieste dall'app Lenticchia
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ errore: 'Metodo non consentito' });
  }

  // Rate limiting primitivo — Vercel ha max 1 req/s per IP in tier free
  // Per una protezione più robusta aggiungere Upstash Redis o simile

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ errore: 'Body non valido' });
  }

  // Validazione
  const errors = valida(body);
  if (errors.length > 0) {
    return res.status(400).json({ errore: errors.join('; ') });
  }

  // Genera ticket ID tracciabile: DSA-YYYYMMDD-XXXXXX
  const oggi     = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random   = Math.random().toString(36).slice(2, 8).toUpperCase();
  const ticketId = `DSA-${oggi}-${random}`;

  try {
    // Salva su Firestore nella collection segnalazioni_dsa
    await db.collection('segnalazioni_dsa').add({
      ticket_id:      ticketId,
      email:          body.email,
      tipo:           body.tipo,
      descrizione:    body.descrizione.trim(),
      offerta_id:     body.offerta_id || null,
      url_contenuto:  body.url_contenuto || null,
      stato:          'ricevuta',       // ricevuta → in_esame → chiusa
      data_ricezione: FieldValue.serverTimestamp(),
      scadenza_sla:   new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      risposta:       null,
      ip_hash:        null,             // non salviamo IP raw per GDPR
    });

    // Notifica Telegram all'admin
    await notificaTelegram(ticketId, body);

    // Risposta al segnalante — DSA richiede conferma con ID ticket
    return res.status(200).json({
      ok:        true,
      ticket_id: ticketId,
      messaggio: `Segnalazione ricevuta. ID: ${ticketId}. Risponderemo all'indirizzo ${body.email} entro 48 ore.`,
    });

  } catch (err) {
    console.error('Errore salvataggio segnalazione:', err);
    return res.status(500).json({
      errore: 'Errore interno. Riprova o scrivi a trust@lenticchia.app',
    });
  }
}
