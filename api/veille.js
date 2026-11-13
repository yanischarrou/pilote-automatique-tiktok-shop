// Le second passage de la journée (cron de 17 h) : la veille des colis, puis ce que midi n'a pas fini.
import { rattrapage, alertFailure } from '../lib/run.js';
import { chargerReglages } from '../lib/reglages.js';
import { piloteActif } from '../lib/config.js';
import { exigerAcces, json } from '../lib/http.js';

export default async function handler(req, res) {
  if (!(await exigerAcces(req, res))) return;
  const logs = [];
  const log = (m) => { logs.push(m); console.log(m); };
  try {
    await chargerReglages();
    if (!piloteActif()) return json(res, 200, { ok: true, inactif: true });
    json(res, 200, { ok: true, report: await rattrapage({ log }), logs });
  } catch (e) {
    console.error(e);
    if (!/Aucune autorisation|Aucun entrepôt|Gmail pas/.test(e.message)) await alertFailure(e);
    json(res, 500, { ok: false, error: e.message, logs });
  }
}
