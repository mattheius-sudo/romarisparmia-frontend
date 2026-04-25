// api/telegram.js
// Webhook Vercel per il bot Telegram di Lenticchia.
//
// SETUP (da fare una volta sola):
//   curl "https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://lenticchia.vercel.app/api/telegram"
//
// Sostituisce il long-polling su GitHub Actions — il bot risponde in tempo reale.
// Comandi supportati:
//   /volantini          — lista volantini in attesa di approvazione
//   /approva_vol {id}   — approva un volantino
//   /rifiuta_vol {id}   — rifiuta un volantino con motivazione
//   /stats              — statistiche generali del database
//   /help               — lista comandi

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ── Firebase Admin init ───────────────────────────────────────────────────────
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = getFirestore();

// ── Helpers ───────────────────────────────────────────────────────────────────
async function rispondi(token, chatId, testo) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:    chatId,
      text:       testo,
      parse_mode: 'Markdown',
    }),
  });
}

// ── Comandi ───────────────────────────────────────────────────────────────────
async function cmdVolantini() {
  const snap = await db.collection('coda_volantini')
    .where('stato', '==', 'in_attesa')
    .orderBy('data_caricamento', 'asc')
    .limit(10)
    .get();

  if (snap.empty) return '📭 Nessun volantino in attesa.';

  const righe = snap.docs.map(d => {
    const data    = d.data();
    const insegna = data.insegna || '?';
    const città   = data.città   || '?';
    const nFoto   = data.n_foto  || '?';
    const ts      = data.data_caricamento?.toDate?.()?.toLocaleString('it-IT') || '?';
    return `• \`${d.id}\` — *${insegna}* (${città}) — ${nFoto} foto — ${ts}`;
  });

  return `📋 *Volantini in attesa (${snap.size}):*\n\n${righe.join('\n')}\n\nUsa /approva_vol {id} o /rifiuta_vol {id}`;
}

async function cmdApprovaVol(docId) {
  if (!docId) return '❌ Specifica l\'ID: /approva_vol {id}';

  const ref  = db.collection('coda_volantini').doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return `❌ Documento \`${docId}\` non trovato.`;

  const data = snap.data();
  if (data.stato !== 'in_attesa') return `⚠️ Stato attuale: ${data.stato} — nessuna azione.`;

  // Aggiorna stato in coda_volantini
  await ref.update({
    stato:        'approvato',
    approvato_il: FieldValue.serverTimestamp(),
  });

  // Attiva tutte le offerte associate
  const offerte = await db.collection('offerte_attive')
    .where('coda_doc_id', '==', docId)
    .get();

  const batch = db.batch();
  let nAttivate = 0;
  offerte.forEach(o => {
    if (!o.data().flag_prezzo_sospetto) {
      batch.update(o.ref, { stato: 'attivo' });
      nAttivate++;
    }
  });
  await batch.commit();

  // Sblocca punti escrow dell'utente contributore
  const uid = data.uid;
  if (uid && data.punti_pending) {
    const profiloRef = db.doc(`users/${uid}/private/profilo`);
    await profiloRef.update({
      punti: FieldValue.increment(data.punti_pending),
    });
  }

  const sospette = offerte.size - nAttivate;
  let msg = `✅ Volantino \`${docId}\` approvato!\n`;
  msg += `• Insegna: *${data.insegna}* (${data.città || '?'})\n`;
  msg += `• Offerte attivate: ${nAttivate}`;
  if (sospette > 0) msg += `\n• ⚠️ ${sospette} offerte con prezzi sospetti — restano in pending_review`;
  if (data.punti_pending) msg += `\n• 💰 ${data.punti_pending} punti accreditati all'utente`;

  return msg;
}

async function cmdRifiutaVol(docId, motivazione) {
  if (!docId) return '❌ Specifica l\'ID: /rifiuta_vol {id} [motivazione]';

  const ref  = db.collection('coda_volantini').doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return `❌ Documento \`${docId}\` non trovato.`;

  const data = snap.data();
  if (data.stato !== 'in_attesa') return `⚠️ Stato attuale: ${data.stato} — nessuna azione.`;

  await ref.update({
    stato:        'rifiutato',
    rifiutato_il: FieldValue.serverTimestamp(),
    motivazione:  motivazione || 'Rifiutato dall\'admin',
  });

  // Elimina offerte pending associate
  const offerte = await db.collection('offerte_attive')
    .where('coda_doc_id', '==', docId)
    .where('stato', '==', 'pending_review')
    .get();

  const batch = db.batch();
  offerte.forEach(o => batch.delete(o.ref));
  await batch.commit();

  return `🗑️ Volantino \`${docId}\` rifiutato.\n${offerte.size} offerte eliminate.${motivazione ? `\nMotivazione: ${motivazione}` : ''}`;
}

async function cmdStats() {
  const [offerteSnap, codaSnap, scontriniSnap] = await Promise.all([
    db.collection('offerte_attive').where('stato', '==', 'attivo').count().get(),
    db.collection('coda_volantini').where('stato', '==', 'in_attesa').count().get(),
    db.collection('coda_scontrini').where('stato', '==', 'in_attesa').count().get(),
  ]);

  return [
    `📊 *Statistiche Lenticchia*`,
    `• Offerte attive: ${offerteSnap.data().count}`,
    `• Volantini in attesa: ${codaSnap.data().count}`,
    `• Scontrini in coda: ${scontriniSnap.data().count}`,
  ].join('\n');
}

const HELP = `
🌿 *Lenticchia Admin Bot*

/volantini — lista volantini in attesa
/approva\\_vol {id} — approva volantino e attiva offerte
/rifiuta\\_vol {id} [motivazione] — rifiuta volantino
/stats — statistiche database
/help — questo messaggio
`.trim();

// ── Dispatcher comandi ────────────────────────────────────────────────────────
async function gestisciComando(testo) {
  const parti   = testo.trim().split(/\s+/);
  const comando = parti[0].toLowerCase();
  const arg1    = parti[1] || '';
  const resto   = parti.slice(2).join(' ');

  switch (comando) {
    case '/volantini':    return await cmdVolantini();
    case '/approva_vol':  return await cmdApprovaVol(arg1);
    case '/rifiuta_vol':  return await cmdRifiutaVol(arg1, resto);
    case '/stats':        return await cmdStats();
    case '/help':
    default:              return HELP;
  }
}

// ── Handler Vercel ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Telegram manda solo POST
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, info: 'Lenticchia Telegram Webhook' });
  }

  const token          = process.env.TELEGRAM_BOT_TOKEN;
  const chatAutorizzato = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token || !chatAutorizzato) {
    console.error('Variabili TELEGRAM_BOT_TOKEN o TELEGRAM_ADMIN_CHAT_ID mancanti');
    return res.status(500).end();
  }

  // Verifica secret opzionale (Telegram lo manda nell'header X-Telegram-Bot-Api-Secret-Token)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(403).end();
  }

  const update  = req.body;
  const message = update?.message;

  // Risponde subito 200 a Telegram (evita retry)
  res.status(200).json({ ok: true });

  if (!message) return;

  const chatId  = String(message.chat?.id || '');
  const testo   = message.text?.trim() || '';

  // Sicurezza: risponde solo al chat_id autorizzato
  if (chatId !== chatAutorizzato) {
    await rispondi(token, chatId, '⛔ Non autorizzato.');
    return;
  }

  if (!testo.startsWith('/')) {
    await rispondi(token, chatId, 'Invia un comando. /help per la lista.');
    return;
  }

  try {
    const risposta = await gestisciComando(testo);
    await rispondi(token, chatId, risposta);
  } catch (err) {
    console.error('Errore gestione comando:', err);
    await rispondi(token, chatId, `❌ Errore: ${err.message}`);
  }
}
