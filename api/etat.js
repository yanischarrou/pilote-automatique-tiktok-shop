// Ce que la page du robot affiche : les réglages (sans les secrets), les boutiques autorisées, le dernier passage.
import { readJson, stockage, blobRelie } from '../lib/store.js';
import { chargerReglages, visibles } from '../lib/reglages.js';
import { toutesBoutiques } from '../lib/comptes.js';
import { entrepots, piloteActif } from '../lib/config.js';
import { gmailPret } from '../lib/mail.js';
import { exigerAcces, json, origine } from '../lib/http.js';

export default async function handler(req, res) {
  if (!blobRelie()) return json(res, 503, { ok: false, erreur: 'pas_de_blob' });
  if (!(await exigerAcces(req, res))) return;
  try {
    const r = await chargerReglages();
    const tokens = await readJson('tokens.json');
    const state = (await readJson('state.json')) ?? {};
    const boutiques = toutesBoutiques(tokens).map((s) => ({ nom: s.name, pays: s.region }));
    const v = visibles(r);
    json(res, 200, {
      ok: true,
      reglages: v,
      redirection: `${origine(req)}/api/auth/callback`,
      etapes: {
        app: !!(v.TTS_APP_KEY && v.TTS_APP_SECRET_enregistre && v.TTS_SERVICE_ID),
        gmail: gmailPret() && !!r.mail_essai_ok,
        entrepot: entrepots().length > 0,
        boutique: boutiques.length > 0,
        test: !!state.dernier_test,
        actif: piloteActif(),
      },
      boutiques,
      vendeur: tokens?.seller_name ?? null,
      autorisation_expire: tokens?.refresh_expires_at ? new Date(tokens.refresh_expires_at * 1000).toISOString() : null,
      dernier_passage: state.last_run ?? null,
      derniere_veille: state.last_veille ?? null,
      dernier_test: state.dernier_test ?? null,
      stockage: stockage(),
    });
  } catch (e) {
    console.error(e);
    json(res, 500, { ok: false, erreur: e.message });
  }
}
