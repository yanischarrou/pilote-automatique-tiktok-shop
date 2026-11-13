// Le retour de TikTok après « Autoriser » : on échange le code contre l'autorisation, gardée chiffrée.
import { exchangeCode, normalizeTokens, makeClient } from '../../lib/tiktok.js';
import { readJson, writeJson } from '../../lib/store.js';
import { fusionnerCompte } from '../../lib/comptes.js';
import { chargerReglages } from '../../lib/reglages.js';
import { env } from '../../lib/config.js';
import { egal, esc, html, lireCookie, query } from '../../lib/http.js';
import { STATE_COOKIE, cookieEfface, lireEtat } from '../../lib/oauth-state.js';

const retour = '<p><a href="/" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600">Revenir à la page du robot</a></p>';

export default async function handler(req, res) {
  const q = query(req);
  const fin = { 'set-cookie': cookieEfface() }; // le cookie du state ne sert qu'une fois

  // Le retour doit venir de NOTRE départ : même state que le cookie signé (sinon, n'importe qui pourrait faire
  // enregistrer sa boutique à la place de la tienne avec un lien fabriqué).
  const attendu = lireEtat(lireCookie(req, STATE_COOKIE), process.env.CRON_SECRET);
  if (!attendu || !egal(q.get('state') || '', attendu)) {
    return html(res, 403, `<h2>Autorisation refusée</h2><p>Ce retour ne correspond à aucune demande en cours (lien de plus de 10 minutes, ou ouvert dans un autre navigateur). Recommence depuis la page du robot, bouton « Autoriser ma boutique ».</p>${retour}`, fin);
  }
  const code = q.get('code') || q.get('auth_code');
  if (!code) return html(res, 400, `<h2>Code manquant</h2><p>TikTok n'a pas renvoyé de code d'autorisation. Recommence depuis la page du robot.</p>${retour}`, fin);
  try {
    await chargerReglages();
    const appKey = env('TTS_APP_KEY'), appSecret = env('TTS_APP_SECRET');
    const tokens = normalizeTokens(await exchangeCode({ appKey, appSecret, code }));
    const client = makeClient({ appKey, appSecret, accessToken: tokens.access_token });
    const shops = (await client.getAuthorizedShops()).shops ?? [];
    await writeJson('tokens.json', fusionnerCompte((await readJson('tokens.json')) ?? {}, { ...tokens, shops }));
    const liste = shops.map((s) => `<li><b>${esc(s.name)}</b> (${esc(s.region)})</li>`).join('') || '<li>(aucune boutique renvoyée)</li>';
    return html(res, 200, `<h2>✅ Boutique autorisée</h2><ul>${liste}</ul><p>Prochaine étape : le test à blanc, sur la page du robot.</p>${retour}`, fin);
  } catch (e) {
    console.error(e);
    return html(res, 500, `<h2>❌ L'autorisation n'a pas marché</h2><p>${esc(e.message)}</p><p>Vérifie que l'App key et l'App secret collés sur la page sont ceux de cette app, puis recommence.</p>${retour}`, fin);
  }
}
