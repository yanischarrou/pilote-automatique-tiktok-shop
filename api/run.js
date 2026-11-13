// Le passage de midi. Appelé par le cron de Vercel (vercel.json) et par les boutons de la page :
// ?dry=1 = test à blanc (rien n'est expédié, aucun mail) ; ?maintenant=1 = passage tout de suite.
import { runOnce, alertFailure } from '../lib/run.js';
import { readJson, writeJson } from '../lib/store.js';
import { chargerReglages } from '../lib/reglages.js';
import { piloteActif } from '../lib/config.js';
import { exigerAcces, json, query } from '../lib/http.js';

export default async function handler(req, res) {
  if (!(await exigerAcces(req, res))) return;
  const q = query(req);
  const dryRun = q.get('dry') === '1';
  const logs = [];
  const log = (m) => { logs.push(m); console.log(m); };
  try {
    await chargerReglages();
    if (!dryRun && !piloteActif()) return json(res, 200, { ok: true, inactif: true, message: 'Pilote automatique pas encore activé : rien fait.' });
    const report = await runOnce({ dryRun, log, autreEssai: !dryRun && q.get('maintenant') !== '1' });
    if (dryRun) {
      const state = (await readJson('state.json')) ?? {};
      state.dernier_test = { at: new Date().toISOString(), commandes: report.orders, colis: report.packages.length, erreurs: report.errors.length };
      await writeJson('state.json', state);
    }
    json(res, 200, { ok: true, report, logs });
  } catch (e) {
    console.error(e);
    // Pas d'alerte tant que la boutique n'a jamais été autorisée ou que le pilote n'est pas réglé.
    if (!dryRun && !/Aucune autorisation|Aucun entrepôt|Gmail pas/.test(e.message)) await alertFailure(e);
    json(res, 500, { ok: false, error: e.message, logs });
  }
}
