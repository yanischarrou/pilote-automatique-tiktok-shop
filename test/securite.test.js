// Les pages du robot : fermées sans le mot de passe, jamais un secret renvoyé au navigateur, retour TikTok vérifié.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';

process.env.CRON_SECRET = 'mot-de-passe-de-test-tres-long';
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;
delete process.env.VERCEL;
process.chdir(new URL('.', import.meta.url).pathname);
fs.rmSync('.data', { recursive: true, force: true });
const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => origSetTimeout(fn, Math.min(ms, 5), ...a);

function req({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const r = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(r, { method, url, headers: { host: 'mon-pilote.vercel.app', ...headers } });
  return r;
}
function res() {
  const h = {};
  return { statusCode: 200, headers: h, corps: '', setHeader(k, v) { h[k.toLowerCase()] = v; }, end(t = '') { this.corps = String(t); } };
}
const avec = { authorization: 'Bearer mot-de-passe-de-test-tres-long' };
const etat = (await import('../api/etat.js')).default;
const reglages = (await import('../api/reglages.js')).default;
const start = (await import('../api/auth/start.js')).default;
const callback = (await import('../api/auth/callback.js')).default;
const run = (await import('../api/run.js')).default;

// Sans mot de passe : refusé.
let s = res(); await etat(req(), s); assert.equal(s.statusCode, 401);
s = res(); await etat(req({ headers: { authorization: 'Bearer faux' } }), s); assert.equal(s.statusCode, 401);
s = res(); await run(req(), s); assert.equal(s.statusCode, 401, 'le passage aussi');

// Les secrets ne repartent jamais.
s = res();
await reglages(req({ method: 'POST', headers: avec, body: { TTS_APP_KEY: 'k', TTS_APP_SECRET: 'tres-secret', TTS_SERVICE_ID: '9', GMAIL_USER: 'a@gmail.com', GMAIL_APP_PASSWORD: 'abcdefghijklmnop', entrepots: [{ email: 'e@x.fr' }] } }), s);
assert.equal(s.statusCode, 200, s.corps);
assert.ok(!s.corps.includes('tres-secret') && !s.corps.includes('abcdefghijklmnop'), 'pas de secret dans la réponse');
s = res(); await etat(req({ headers: avec }), s);
assert.equal(s.statusCode, 200, s.corps);
const e = JSON.parse(s.corps);
assert.ok(!s.corps.includes('tres-secret'));
assert.equal(e.reglages.TTS_APP_SECRET_enregistre, true);
assert.equal(e.redirection, 'https://mon-pilote.vercel.app/api/auth/callback');
assert.equal(e.etapes.app, true);
assert.equal(e.etapes.gmail, false, "le mail d'essai n'a pas encore été fait");

// Un secret laissé vide garde l'ancien.
s = res(); await reglages(req({ method: 'POST', headers: avec, body: { TTS_APP_KEY: 'k2' } }), s);
s = res(); await etat(req({ headers: avec }), s);
assert.equal(JSON.parse(s.corps).reglages.TTS_APP_SECRET_enregistre, true);

// Le départ vers TikTok : lien avec le service_id et un state, cookie signé.
s = res(); await start(req({ method: 'POST', headers: avec }), s);
const d = JSON.parse(s.corps);
const u = new URL(d.url);
assert.equal(u.searchParams.get('service_id'), '9');
assert.ok(u.searchParams.get('state'));
assert.match(s.headers['set-cookie'], /HttpOnly; Secure/);

// Un retour sans le bon cookie est refusé.
s = res(); await callback(req({ url: `/api/auth/callback?code=abc&state=${u.searchParams.get('state')}` }), s);
assert.equal(s.statusCode, 403, 'state sans cookie refusé');
s = res(); await callback(req({ url: '/api/auth/callback?code=abc&state=autre' }), s);
assert.equal(s.statusCode, 403);

// Pilote pas activé : le cron ne fait rien.
s = res(); await run(req({ headers: avec }), s);
assert.equal(JSON.parse(s.corps).inactif, true);

// Mot de passe trop court : tout est fermé.
process.env.CRON_SECRET = 'court';
s = res(); await etat(req({ headers: { authorization: 'Bearer court' } }), s);
assert.equal(s.statusCode, 503);
assert.match(s.corps, /mot_de_passe_trop_court/);

fs.rmSync('.data', { recursive: true, force: true });
console.log('securite.test.js : tout est bon');
