// Les réglages du robot. Ils viennent de la page de réglages (reglages.json, chiffré) ; une variable Vercel du même nom
// passe devant si elle existe. chargerReglages() (lib/reglages.js) les lit au début de chaque appel.

let REGLAGES = {};

export function poserReglages(r) {
  REGLAGES = r && typeof r === 'object' ? r : {};
}

export function reglagesEnCours() {
  return REGLAGES;
}

export function env(name, fallback) {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  const r = REGLAGES[name];
  return r === undefined || r === null || r === '' ? fallback : r;
}

// Le pilote ne fait rien tant que l'élève ne l'a pas activé sur sa page (après le test à blanc).
export function piloteActif() {
  if (process.env.PILOTE_ACTIF) return process.env.PILOTE_ACTIF === '1';
  return REGLAGES.actif === true;
}

function motsDe(v) {
  return (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((m) => String(m).trim().toLowerCase())
    .filter(Boolean);
}

// Les entrepôts : { cle, nom, contact, email, mots_produit[], handover }. Un seul entrepôt reçoit tout ; avec plusieurs,
// un colis va à celui dont un mot apparaît dans le nom du produit (sinon il part chez toi, à transmettre).
export function entrepots() {
  let liste = REGLAGES.entrepots;
  const brut = process.env.ENTREPOTS_JSON;
  if (brut) {
    try {
      const t = JSON.parse(brut);
      if (Array.isArray(t) && t.length) liste = t;
    } catch {
      /* on garde ceux de la page */
    }
  }
  return (Array.isArray(liste) ? liste : [])
    .filter((e) => e && String(e.email ?? '').includes('@'))
    .map((e, i) => ({
      cle: String(e.cle || `entrepot-${i + 1}`),
      nom: String(e.nom || `Entrepôt ${i + 1}`),
      contact: String(e.contact ?? '').trim(),
      email: String(e.email).trim(),
      mots_produit: motsDe(e.mots_produit ?? e.mots),
      warehouse_ids: (e.warehouse_ids ?? []).map(String),
      noms_entrepot: motsDe(e.noms_entrepot),
      handover: e.handover === 'PICKUP' ? 'PICKUP' : 'DROP_OFF',
    }));
}

// Le nom qui signe les mails aux entrepôts.
export function signature() {
  return String(env('NOM', '') || '').trim() || 'La boutique';
}

const PAYS = {
  FR: 'France', DE: 'Allemagne', AT: 'Autriche', BE: 'Belgique', CZ: 'Tchéquie', GR: 'Grèce', HU: 'Hongrie',
  IE: 'Irlande', IT: 'Italie', NL: 'Pays-Bas', PL: 'Pologne', PT: 'Portugal', ES: 'Espagne', GB: 'Royaume-Uni',
  LU: 'Luxembourg', SK: 'Slovaquie', RO: 'Roumanie', DK: 'Danemark', SE: 'Suède', FI: 'Finlande',
};
export function nomPays(region) {
  const r = String(region ?? 'FR').toUpperCase();
  return PAYS[r] ?? r;
}

// Les dates du robot se comptent à l'heure de Paris, quel que soit le fuseau du serveur.
export function jourParis(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(d); // AAAA-MM-JJ
}

export function dateParis(d = new Date()) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit' }).format(d); // JJ/MM
}

export function heureParis(d = new Date()) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(d);
}

// Jour de la semaine à Paris : 0 dimanche … 6 samedi.
export function jourSemaineParis(jour) {
  return new Date(`${jour}T12:00:00Z`).getUTCDay();
}

export function jourSuivant(jour) {
  const d = new Date(`${jour}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Le jour où le transporteur doit passer pour un colis préparé ce jour-là : le jour même en semaine, sinon le lundi.
export function jourEnlevement(jour) {
  let j = jour;
  while ([0, 6].includes(jourSemaineParis(j))) j = jourSuivant(j);
  return j;
}

// L'alerte « pas pris en charge » part le jour ouvré qui suit le jour d'enlèvement.
export function jourAlerteEnlevement(jour) {
  return jourEnlevement(jourSuivant(jourEnlevement(jour)));
}

// L'adresse de la page du robot (celle de son projet Vercel).
export function adressePublique() {
  const p = process.env.PUBLIC_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || '';
  if (!p) return '';
  return p.startsWith('http') ? p.replace(/\/$/, '') : `https://${p.replace(/\/$/, '')}`;
}
