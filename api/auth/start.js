// Le départ vers TikTok : la page du robot (bouton « Autoriser ma boutique ») demande ici le lien d'autorisation, avec
// un `state` aléatoire gardé dans un cookie signé (vérifié au retour).
import { chargerReglages } from '../../lib/reglages.js';
import { env } from '../../lib/config.js';
import { cookieEtat, nouvelEtat } from '../../lib/oauth-state.js';
import { exigerAcces, json } from '../../lib/http.js';

function urlAutorisation(state) {
  const serviceId = env('TTS_SERVICE_ID');
  if (!serviceId) return null;
  const url = new URL('https://services.tiktokshop.com/open/authorize');
  url.searchParams.set('service_id', String(serviceId).trim());
  url.searchParams.set('state', state);
  return url.toString();
}

export default async function handler(req, res) {
  if (req.method === 'GET' && !req.headers['authorization']) {
    res.statusCode = 302;
    res.setHeader('location', '/');
    return res.end();
  }
  if (!(await exigerAcces(req, res))) return;
  await chargerReglages();
  if (!env('TTS_APP_KEY') || !env('TTS_APP_SECRET')) return json(res, 400, { ok: false, erreur: "Colle d'abord l'App key et l'App secret de ton app TikTok, puis enregistre." });
  const { state, valeur } = nouvelEtat(process.env.CRON_SECRET);
  const url = urlAutorisation(state);
  if (!url) return json(res, 400, { ok: false, erreur: "Colle d'abord le Service ID de ton app TikTok, puis enregistre." });
  res.setHeader('set-cookie', cookieEtat(valeur));
  json(res, 200, { ok: true, url });
}
