// Enregistre ce que la page envoie (POST, JSON). Un secret laissé vide garde l'ancien.
import { enregistrer, visibles } from '../lib/reglages.js';
import { exigerAcces, json, lireCorps } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false });
  if (!(await exigerAcces(req, res))) return;
  try {
    const recu = await lireCorps(req);
    const r = await enregistrer(recu);
    if (!r.ok) return json(res, 400, r);
    json(res, 200, { ok: true, reglages: visibles(r.reglages) });
  } catch (e) {
    console.error(e);
    json(res, 500, { ok: false, erreurs: [e.message] });
  }
}
