import crypto from 'node:crypto';

/** Comparaison en temps constant, quelle que soit la longueur des deux chaînes. */
export function egal(a, b) {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * Le secret d'administration (CRON_SECRET), uniquement dans l'en-tête
 * `Authorization: Bearer …` — jamais dans l'URL, où il finirait dans les
 * journaux et l'historique. C'est aussi ce que Vercel envoie à ses crons quand
 * la variable CRON_SECRET existe. Sans CRON_SECRET, tout est fermé.
 */
export function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers['authorization'] || '';
  return egal(auth, `Bearer ${secret}`);
}

export function query(req) {
  return new URL(req.url, 'http://x').searchParams;
}

/** Toute valeur venue de TikTok ou d'une erreur passe par ici avant d'entrer dans le HTML. */
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function lireCookie(req, nom) {
  for (const morceau of String(req.headers['cookie'] || '').split(';')) {
    const i = morceau.indexOf('=');
    if (i > 0 && morceau.slice(0, i).trim() === nom) return morceau.slice(i + 1).trim();
  }
  return null;
}

export function html(res, status, body, headers = {}) {
  const style = "font-family:Inter,system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5;background:#faf8f3;color:#2b2233";
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pilote automatique</title><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;600&display=swap" rel="stylesheet"><style>h2{font-family:Poppins,sans-serif}</style><body style="${style}">${body}</body></html>`);
}

/** Le mot de passe du robot doit être assez long : la page est sur internet. */
export function motDePasseValable() {
  return String(process.env.CRON_SECRET ?? '').length >= 12;
}

/** Contrôle d'accès des pages du robot : un refus attend un peu, pour freiner qui essaierait de deviner. */
export async function exigerAcces(req, res) {
  if (!motDePasseValable()) {
    json(res, 503, { ok: false, erreur: 'mot_de_passe_trop_court' });
    return false;
  }
  if (authorized(req)) return true;
  await new Promise((r) => setTimeout(r, 800));
  json(res, 401, { ok: false, erreur: 'mot_de_passe_refuse' });
  return false;
}

export function json(res, status, objet) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(objet, null, 2));
}

/** Le corps JSON d'une requête (Vercel le lit déjà ; sinon on le lit). */
export async function lireCorps(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const morceaux = [];
  for await (const m of req) morceaux.push(m);
  const t = Buffer.concat(morceaux).toString('utf8');
  return t ? JSON.parse(t) : {};
}

/** L'adresse de ce site, telle que le navigateur l'a appelée (pour l'URL de redirection à donner à TikTok). */
export function origine(req) {
  const hote = req.headers['x-forwarded-host'] || req.headers['host'] || '';
  const proto = req.headers['x-forwarded-proto'] || (hote.startsWith('localhost') ? 'http' : 'https');
  return hote ? `${proto}://${hote}` : '';
}
