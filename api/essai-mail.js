// Le mail d'essai : de ton Gmail vers ton Gmail. S'il arrive, le robot saura écrire à ton entrepôt.
import { chargerReglages } from '../lib/reglages.js';
import { readJson, writeJson } from '../lib/store.js';
import { sendMail } from '../lib/mail.js';
import { adressePublique } from '../lib/config.js';
import { exigerAcces, json } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false });
  if (!(await exigerAcces(req, res))) return;
  try {
    await chargerReglages();
    await sendMail({
      subject: '✅ Ton pilote automatique sait envoyer des mails',
      html: `<p>Ce mail vient de ton pilote automatique TikTok Shop : il saura écrire à ton entrepôt depuis cette adresse.</p><p>Prochaine étape sur ta page : autoriser ta boutique.</p>${adressePublique() ? `<p><a href="${adressePublique()}">Ouvrir la page du robot</a></p>` : ''}`,
      text: 'Ce mail vient de ton pilote automatique TikTok Shop : il saura écrire à ton entrepôt depuis cette adresse.',
    });
    const r = (await readJson('reglages.json', {})) ?? {};
    await writeJson('reglages.json', { ...r, mail_essai_ok: new Date().toISOString() });
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 400, { ok: false, erreur: e.message });
  }
}
