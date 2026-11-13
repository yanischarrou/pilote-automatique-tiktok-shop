// La page de réglages : ce qu'on y colle est gardé, chiffré, dans reglages.json. Les secrets ne repartent jamais vers
// le navigateur : la page sait seulement s'ils sont enregistrés.
import { readJson, writeJson } from './store.js';
import { poserReglages, reglagesEnCours } from './config.js';

export const SECRETS = ['TTS_APP_SECRET', 'GMAIL_APP_PASSWORD'];
const TEXTES = ['TTS_APP_KEY', 'TTS_SERVICE_ID', 'GMAIL_USER', 'NOM'];

export async function chargerReglages() {
  const r = (await readJson('reglages.json', {})) ?? {};
  poserReglages(r);
  return r;
}

const courriel = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? '').trim());

// Fusionne ce que la page envoie avec ce qui est déjà gardé. Un secret laissé vide garde l'ancien.
export function fusionner(avant, recu) {
  const r = { ...avant };
  const erreurs = [];
  for (const k of TEXTES) if (k in recu) r[k] = String(recu[k] ?? '').trim();
  for (const k of SECRETS) {
    const v = String(recu[k] ?? '').trim();
    if (v) r[k] = k === 'GMAIL_APP_PASSWORD' ? v.replace(/\s+/g, '') : v;
  }
  if (r.GMAIL_USER && !courriel(r.GMAIL_USER)) erreurs.push("L'adresse Gmail n'est pas une adresse e-mail.");
  if (r.GMAIL_APP_PASSWORD && !/^[a-zA-Z]{16}$/.test(r.GMAIL_APP_PASSWORD)) {
    erreurs.push("Le mot de passe d'application Google fait 16 lettres (Google l'affiche en 4 groupes de 4).");
  }
  if (Array.isArray(recu.entrepots)) {
    r.entrepots = recu.entrepots
      .map((e, i) => ({
        cle: String(e.cle || `entrepot-${i + 1}`),
        nom: String(e.nom ?? '').trim(),
        contact: String(e.contact ?? '').trim(),
        email: String(e.email ?? '').trim(),
        mots_produit: String(e.mots_produit ?? '').split(',').map((m) => m.trim()).filter(Boolean),
        handover: e.handover === 'PICKUP' ? 'PICKUP' : 'DROP_OFF',
      }))
      .filter((e) => e.email || e.nom || e.contact);
    r.entrepots.forEach((e, i) => {
      if (!courriel(e.email)) erreurs.push(`Entrepôt ${i + 1} : l'adresse e-mail manque ou n'est pas valable.`);
      if (r.entrepots.length > 1 && !e.mots_produit.length) erreurs.push(`Entrepôt ${i + 1} : avec plusieurs entrepôts, indique les mots du nom du produit qui y part.`);
    });
  }
  // Changer d'adresse Gmail ou de mot de passe oblige à refaire le mail d'essai.
  if (r.GMAIL_USER !== avant.GMAIL_USER || String(recu.GMAIL_APP_PASSWORD ?? '').trim()) delete r.mail_essai_ok;
  if ('aucun_colis' in recu) r.aucun_colis = recu.aucun_colis !== false;
  if ('actif' in recu) r.actif = recu.actif === true;
  return { reglages: r, erreurs };
}

export async function enregistrer(recu) {
  const avant = await chargerReglages();
  const { reglages, erreurs } = fusionner(avant, recu);
  if (erreurs.length) return { ok: false, erreurs };
  await writeJson('reglages.json', reglages);
  poserReglages(reglages);
  return { ok: true, reglages };
}

// Ce que la page peut voir : tout sauf la valeur des secrets.
export function visibles(r = reglagesEnCours()) {
  const v = {};
  for (const k of TEXTES) v[k] = r[k] ?? process.env[k] ?? '';
  for (const k of SECRETS) v[`${k}_enregistre`] = !!(r[k] || process.env[k]);
  v.entrepots = (r.entrepots ?? []).map((e) => ({ ...e, mots_produit: (e.mots_produit ?? []).join(', ') }));
  v.aucun_colis = r.aucun_colis !== false;
  v.actif = r.actif === true;
  return v;
}
