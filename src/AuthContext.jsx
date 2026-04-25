// AuthContext.jsx
// Gestisce autenticazione + tutti i dati personali dell'utente:
//   - profilo (punti, piano, livello, città_registrazione, città_attiva)
//   - lista_spesa (sincronizzata su cloud)
//   - preferenze (insegne attive + tessere fedeltà)
//   - prodotti_preferiti (prodotti con marca specifica)

import React, { createContext, useContext, useEffect, useState, useRef, useMemo } from 'react';
import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp
} from 'firebase/firestore';
import { auth, googleProvider, db } from './firebase';

// ─── Contesto ──────────────────────────────────────────────────────────────────

const AuthContext = createContext(null);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve essere usato dentro <AuthProvider>');
  return ctx;
};

// ─── Città supportate ──────────────────────────────────────────────────────────

export const CITTA_DISPONIBILI = [
  { id: 'Roma',    label: 'Roma',    emoji: '🏛️' },
  { id: 'Mantova', label: 'Mantova', emoji: '🏰' },
];

// ─── Insegne disponibili ───────────────────────────────────────────────────────

export const INSEGNE_DISPONIBILI = [
  'Lidl', 'PIM/Agora', 'CTS', 'Eurospin',
  'Todis', 'MD Discount', 'Sacoph', 'Elite'
];

// ─── Profilo default ───────────────────────────────────────────────────────────

const creaProfiloDefault = (user, città = null) => ({
  uid:                        user.uid,
  email:                      user.email,
  nome:                       user.displayName || '',
  avatar:                     user.photoURL || '',
  piano:                      'free',
  piano_scadenza:             null,
  piano_origine:              'organic',
  punti:                      0,
  livello:                    'Osservatore',
  scontrini_questa_settimana: 0,
  scontrini_totali:           0,
  ultimo_reset_contatore:     null,
  data_iscrizione:            serverTimestamp(),
  ultimo_accesso:             serverTimestamp(),
  onboarding_completato:      false,
  tutorial_completato:        false,  // tutorial in-app dopo il primo accesso
  // Città: registrazione = dove si è iscritto, attiva = quella che vede ora
  città_registrazione:        città,
  città_attiva:               città,
  // Contatore scontrini per città — usato per eleggibilità a proporre info insegne (soglia 80%)
  scontrini_per_città:        {},
});

// ─── Defaults documenti utente ────────────────────────────────────────────────

const DEFAULT_LISTA_SPESA = {
  items: ['pane', 'latte', 'pasta'],
  ultima_modifica: null,
};

const DEFAULT_PREFERENZE = {
  zona_selezionata:        null,
  insegne_attive:          null,
  tessere:                 {},
  onboarding_supermercati: false,
  ultima_modifica:         null,
};

const DEFAULT_PRODOTTI_PREFERITI = {
  items: [],
  ultima_modifica: null,
};

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }) {
  const [utente, setUtente]                     = useState(null);
  const [profilo, setProfilo]                   = useState(null);
  const [listaSpesa, setListaSpesa]             = useState(DEFAULT_LISTA_SPESA);
  const [preferenze, setPreferenze]             = useState(DEFAULT_PREFERENZE);
  const [prodottiPreferiti, setProdottiPreferiti] = useState(DEFAULT_PRODOTTI_PREFERITI);
  const [loading, setLoading]                   = useState(true);
  const [erroreAuth, setErroreAuth]             = useState(null);

  const debounceListaRef = useRef(null);

  // ── Listener Auth ──────────────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUtente(firebaseUser);
        await caricaTuttiIDatiUtente(firebaseUser);
      } else {
        setUtente(null);
        setProfilo(null);
        setListaSpesa(DEFAULT_LISTA_SPESA);
        setPreferenze(DEFAULT_PREFERENZE);
        setProdottiPreferiti(DEFAULT_PRODOTTI_PREFERITI);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  // ── Carica tutti i documenti dell'utente in parallelo ─────────────────────
  const caricaTuttiIDatiUtente = async (firebaseUser) => {
    const uid = firebaseUser.uid;
    const refs = {
      profilo:            doc(db, 'users', uid, 'private', 'profilo'),
      lista_spesa:        doc(db, 'users', uid, 'private', 'lista_spesa'),
      preferenze:         doc(db, 'users', uid, 'private', 'preferenze'),
      prodotti_preferiti: doc(db, 'users', uid, 'private', 'prodotti_preferiti'),
    };

    try {
      const [profiloSnap, listaSnap, prefSnap, prodSnap] = await Promise.all([
        getDoc(refs.profilo),
        getDoc(refs.lista_spesa),
        getDoc(refs.preferenze),
        getDoc(refs.prodotti_preferiti),
      ]);

      // Profilo
      if (profiloSnap.exists()) {
        const dati = profiloSnap.data();
        setProfilo(dati);
        const oggi = new Date().toISOString().split('T')[0];
        const ultimoAccesso = dati.ultimo_accesso?.toDate?.()?.toISOString?.()?.split('T')[0];
        if (ultimoAccesso !== oggi) {
          await setDoc(refs.profilo, { ultimo_accesso: serverTimestamp() }, { merge: true });
        }
      } else {
        // Nuovo utente — città verrà impostata durante l'onboarding
        const nuovoProfilo = creaProfiloDefault(firebaseUser, null);
        await setDoc(refs.profilo, nuovoProfilo);
        setProfilo(nuovoProfilo);
      }

      // Lista spesa — migra da localStorage se è il primo accesso
      if (listaSnap.exists()) {
        setListaSpesa(listaSnap.data());
      } else {
        let itemsLocali = DEFAULT_LISTA_SPESA.items;
        try {
          const locale = localStorage.getItem('lenticchia_lista');
          if (locale) itemsLocali = locale.split('\n').map(i => i.trim()).filter(Boolean);
        } catch {}
        const nuovaLista = { items: itemsLocali, ultima_modifica: serverTimestamp() };
        await setDoc(refs.lista_spesa, nuovaLista);
        setListaSpesa(nuovaLista);
      }

      // Preferenze insegne + tessere
      if (prefSnap.exists()) {
        setPreferenze(prefSnap.data());
      } else {
        await setDoc(refs.preferenze, DEFAULT_PREFERENZE);
        setPreferenze(DEFAULT_PREFERENZE);
      }

      // Prodotti preferiti
      if (prodSnap.exists()) {
        setProdottiPreferiti(prodSnap.data());
      } else {
        await setDoc(refs.prodotti_preferiti, DEFAULT_PRODOTTI_PREFERITI);
        setProdottiPreferiti(DEFAULT_PRODOTTI_PREFERITI);
      }

    } catch (err) {
      console.error('Errore caricamento dati utente:', err);
    }
  };

  // ── Lista spesa — aggiorna con debounce ───────────────────────────────────
  const aggiornaListaSpesa = (nuoviItems) => {
    setListaSpesa(prev => ({ ...prev, items: nuoviItems }));
    if (debounceListaRef.current) clearTimeout(debounceListaRef.current);
    debounceListaRef.current = setTimeout(async () => {
      if (!utente) return;
      try {
        await setDoc(
          doc(db, 'users', utente.uid, 'private', 'lista_spesa'),
          { items: nuoviItems, ultima_modifica: serverTimestamp() },
          { merge: true }
        );
      } catch (err) { console.error('Errore salvataggio lista:', err); }
    }, 1500);
  };

  // ── Preferenze insegne + tessere ──────────────────────────────────────────
  const aggiornaPreferenze = async (nuovePreferenze) => {
    setPreferenze(nuovePreferenze);
    if (!utente) return;
    try {
      await setDoc(
        doc(db, 'users', utente.uid, 'private', 'preferenze'),
        { ...nuovePreferenze, ultima_modifica: serverTimestamp() },
        { merge: true }
      );
    } catch (err) { console.error('Errore salvataggio preferenze:', err); }
  };

  const toggleInsegna = async (insegna) => {
    const attive = preferenze.insegne_attive || [];
    const nuoveAttive = attive.includes(insegna)
      ? attive.filter(i => i !== insegna)
      : [...attive, insegna];
    await aggiornaPreferenze({ ...preferenze, insegne_attive: nuoveAttive });
  };

  const completaOnboardingSupermercati = async (insegneSelezionate) => {
    await aggiornaPreferenze({
      ...preferenze,
      insegne_attive:          insegneSelezionate,
      onboarding_supermercati: true,
    });
  };

  const aggiornaTessera = async (insegna, attiva, numero = '') => {
    const tessere = { ...(preferenze.tessere || {}) };
    if (!attiva && !numero) { delete tessere[insegna]; }
    else { tessere[insegna] = { attiva, numero: numero.trim() }; }
    await aggiornaPreferenze({ ...preferenze, tessere });
  };

  // ── Profilo — aggiorna campi specifici ────────────────────────────────────
  const aggiornaProfilo = async (campi) => {
    if (!utente) return;
    try {
      const ref = doc(db, 'users', utente.uid, 'private', 'profilo');
      await setDoc(ref, campi, { merge: true });
      setProfilo(prev => ({ ...prev, ...campi }));
    } catch (err) { console.error('Errore aggiornamento profilo:', err); }
  };

  // ── Città attiva — cambiabile in qualsiasi momento ────────────────────────
  const cambiaCittà = async (nuovaCittà) => {
    await aggiornaProfilo({ città_attiva: nuovaCittà });
  };

  const impostaCittàRegistrazione = async (città) => {
    await aggiornaProfilo({
      città_registrazione: città,
      città_attiva:        città,
    });
  };

  // ── Contatore scontrini per città — aggiornato alla Fase 2 HITL ───────────
  // Usa increment() Firestore per atomicità — evita letture stale dallo state React
  const aggiornaScontriniPerCittà = async (città) => {
    if (!utente || !città) return;
    try {
      const ref = doc(db, 'users', utente.uid, 'private', 'profilo');
      await updateDoc(ref, {
        [`scontrini_per_città.${città}`]: increment(1),
      });
      // Aggiorna state locale ottimisticamente
      setProfilo(prev => ({
        ...prev,
        scontrini_per_città: {
          ...(prev?.scontrini_per_città || {}),
          [città]: ((prev?.scontrini_per_città?.[città]) || 0) + 1,
        }
      }));
    } catch (err) { console.error('Errore aggiornamento scontrini per città:', err); }
  };

  // Helper: verifica se l'utente è eleggibile a proporre/votare info per una città.
  // Guru possono sempre farlo. Gli altri devono avere ≥80% scontrini in quella città
  // e almeno 5 scontrini totali (soglia alzata da 3 per ridurre abusi in beta).
  const isEleggibilePerCittà = useMemo(() => (città) => {
    if (!profilo) return false;
    if ((profilo.punti || 0) >= 1000) return true; // Guru override totale
    const perCittà = profilo.scontrini_per_città || {};
    const totale   = Object.values(perCittà).reduce((a, b) => a + b, 0);
    if (totale < 5) return false; // soglia minima — riduce abusi
    const inCittà  = perCittà[città] || 0;
    return inCittà / totale >= 0.8;
  }, [profilo]);

  // ── Prodotti preferiti ────────────────────────────────────────────────────
  const aggiungiProdottoPreferito = async (prodotto) => {
    const nuovoId = `pref_${Date.now()}`;
    const nuovoProdotto = { id: nuovoId, ...prodotto };
    const nuoviItems = [...(prodottiPreferiti.items || []), nuovoProdotto];
    setProdottiPreferiti(prev => ({ ...prev, items: nuoviItems }));
    if (!utente) return;
    try {
      await setDoc(
        doc(db, 'users', utente.uid, 'private', 'prodotti_preferiti'),
        { items: nuoviItems, ultima_modifica: serverTimestamp() },
        { merge: true }
      );
    } catch (err) { console.error('Errore salvataggio prodotto preferito:', err); }
  };

  const rimuoviProdottoPreferito = async (id) => {
    const nuoviItems = (prodottiPreferiti.items || []).filter(p => p.id !== id);
    setProdottiPreferiti(prev => ({ ...prev, items: nuoviItems }));
    if (!utente) return;
    try {
      await setDoc(
        doc(db, 'users', utente.uid, 'private', 'prodotti_preferiti'),
        { items: nuoviItems, ultima_modifica: serverTimestamp() },
        { merge: true }
      );
    } catch (err) { console.error('Errore rimozione prodotto preferito:', err); }
  };

  // ── Helper: rileva se siamo in PWA standalone su iOS ─────────────────────
  // In standalone iOS < 16.4, signInWithPopup fallisce silenziosamente.
  // Usiamo signInWithRedirect come fallback.
  const isIOSStandalone = () => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;
    return isIOS && isStandalone;
  };

  // Recupera il risultato di un redirect precedente al mount
  useEffect(() => {
    getRedirectResult(auth)
      .then(result => { if (result?.user) setUtente(result.user); })
      .catch(() => {}); // nessun redirect in corso — silenzioso
  }, []);

  // ── Login / Logout ────────────────────────────────────────────────────────
  const loginGoogle = async () => {
    setErroreAuth(null);
    try {
      if (isIOSStandalone()) {
        // iOS standalone: usa redirect (popup bloccato da Safari < 16.4)
        await signInWithRedirect(auth, googleProvider);
      } else {
        await signInWithPopup(auth, googleProvider);
      }
    } catch (err) {
      if (err.code !== 'auth/popup-closed-by-user') {
        setErroreAuth('Accesso non riuscito. Riprova.');
        console.error('Errore login:', err);
      }
    }
  };

  const logout = async () => {
    try { await signOut(auth); }
    catch (err) { console.error('Errore logout:', err); }
  };

  const completaOnboarding = async () => {
    if (!utente) return;
    try {
      const profiloRef = doc(db, 'users', utente.uid, 'private', 'profilo');
      await setDoc(profiloRef, { onboarding_completato: true }, { merge: true });
      setProfilo(prev => ({ ...prev, onboarding_completato: true }));
    } catch (err) { console.error('Errore onboarding:', err); }
  };

  // ── Tutorial in-app ───────────────────────────────────────────────────────
  const completaTutorial = async () => {
    if (!utente) return;
    try {
      await setDoc(
        doc(db, 'users', utente.uid, 'private', 'profilo'),
        { tutorial_completato: true }, { merge: true }
      );
      setProfilo(prev => ({ ...prev, tutorial_completato: true }));
    } catch (err) { console.error('Errore completamento tutorial:', err); }
  };

  const riavviaTutorial = () => {
    // Solo locale — non serve salvare su Firestore, basta resettare lo state
    // Il profilo Firestore viene aggiornato solo al completamento/skip
    setProfilo(prev => ({ ...prev, tutorial_completato: false }));
  };

  // Helper derivati
  const cittàAttiva    = profilo?.città_attiva    || null;
  const cittàRegistr   = profilo?.città_registrazione || null;

  // ── Valore esposto ─────────────────────────────────────────────────────────
  const value = {
    // Auth
    utente,
    profilo,
    loading,
    erroreAuth,
    isLoggedIn:  !!utente,
    isPremium:   profilo?.piano === 'premium',
    loginGoogle,
    login: loginGoogle, // alias usato in TabLoginRichiesto
    logout,
    completaOnboarding,
    completaTutorial,
    riavviaTutorial,

    // Città
    cittàAttiva,
    cittàRegistrazione: cittàRegistr,
    cambiaCittà,
    impostaCittàRegistrazione,
    aggiornaScontriniPerCittà,
    isEleggibilePerCittà,

    // Lista spesa
    listaSpesa,
    aggiornaListaSpesa,

    // Preferenze insegne + tessere
    preferenze,
    toggleInsegna,
    aggiornaPreferenze,
    aggiornaTessera,

    // Prodotti preferiti
    prodottiPreferiti,
    aggiungiProdottoPreferito,
    rimuoviProdottoPreferito,

    // Profilo generico
    aggiornaProfilo,

    // Onboarding supermercati
    completaOnboardingSupermercati,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
