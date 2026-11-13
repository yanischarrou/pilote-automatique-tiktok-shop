// Test de bout en bout avec une fausse API TikTok et un faux Gmail : rien ne sort de l'ordinateur.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';

process.env.CRON_SECRET = 'mot-de-passe-de-test-tres-long';
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;
delete process.env.VERCEL;
process.env.PUBLIC_URL = 'https://mon-pilote.vercel.app';
process.chdir(new URL('.', import.meta.url).pathname);
fs.rmSync('.data', { recursive: true, force: true });

const { writeJson, readJson } = await import('../lib/store.js');
const { chargerReglages, enregistrer } = await import('../lib/reglages.js');
const now = Math.floor(Date.now() / 1000);

// --- les réglages, comme la page les enregistre
const r0 = await enregistrer({
  TTS_APP_KEY: 'key123', TTS_APP_SECRET: 'secret456', TTS_SERVICE_ID: '7000', GMAIL_USER: 'eleve@gmail.com',
  GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', NOM: 'Karim', aucun_colis: true,
  entrepots: [{ nom: 'Logisticien Nord', contact: 'Sami', email: 'sami@entrepot.fr', handover: 'DROP_OFF', mots_produit: '' }],
});
assert.ok(r0.ok, JSON.stringify(r0.erreurs));
const brut = fs.readFileSync('.data/reglages.json', 'utf8');
assert.ok(!brut.includes('secret456') && !brut.includes('abcdefgh'), 'les secrets sont chiffrés sur le disque');
const refus = await enregistrer({ GMAIL_APP_PASSWORD: '1234' });
assert.equal(refus.ok, false, 'un mot de passe Google de 4 caractères est refusé');
await writeJson('tokens.json', { access_token: 'AT', refresh_token: 'RT', access_expires_at: now + 7 * 86400, refresh_expires_at: now + 300 * 86400, shops: [{ name: 'Ma boutique', region: 'FR', cipher: 'CIPH', code: 'FRX' }] });

const pdfA6 = await (async () => { const d = await PDFDocument.create(); d.addPage([298, 420]); d.addPage([298, 420]); return Buffer.from(await d.save()); })();

// --- la fausse boutique
const paquets = {
  P1: { package_status: 'TO_FULFILL', shipping_type: 'TIKTOK', shipping_provider_name: 'Colissimo.' },
  P3: { package_status: 'PROCESSING', shipping_type: 'SELLER' }, // expédié par le vendeur : ignoré
  P4: { package_status: 'PROCESSING', shipping_type: 'TIKTOK', tracking_number: 'TRK4' }, // préparé à la main
};
const commandes = {
  AWAITING_SHIPMENT: [{ id: 'O1', rts_sla_time: now + 2 * 86400, packages: [{ id: 'P1' }], line_items: [{ product_name: 'Organiseurs de valise, lot de 6 cubes de rangement compressibles pour voyage', sku_name: 'Gris', package_id: 'P1' }, { product_name: 'Organiseurs de valise, lot de 6 cubes de rangement compressibles pour voyage', sku_name: 'Gris', package_id: 'P1' }] }],
  AWAITING_COLLECTION: [
    { id: 'O3', packages: [{ id: 'P3' }], line_items: [{ product_name: 'Bougie' }] },
    { id: 'O4', packages: [{ id: 'P4' }], line_items: [{ product_name: 'Bougie' }] },
  ],
};
const ships = {};
let docTries = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (code, data, message = 'Success') => new Response(JSON.stringify({ code, data, message, request_id: 'r1' }), { headers: { 'content-type': 'application/json' } });
  if (u.host === 'open-api.tiktokglobalshop.com') {
    const q = Object.fromEntries(u.searchParams); const sign = q.sign; delete q.sign;
    let s = u.pathname; for (const k of Object.keys(q).sort()) s += k + q[k];
    if ((init.method || 'GET') !== 'GET' && init.body) s += init.body;
    assert.equal(sign, crypto.createHmac('sha256', 'secret456').update('secret456' + s + 'secret456').digest('hex'), 'signature');
    assert.equal(init.headers['x-tts-access-token'], 'AT');
  }
  if (u.pathname === '/authorization/202309/shops') return json(0, { shops: [{ name: 'Ma boutique', region: 'FR', cipher: 'CIPH', code: 'FRX' }] });
  if (u.pathname === '/logistics/202309/warehouses') return json(0, { warehouses: [] });
  if (u.pathname === '/order/202309/orders/search') {
    const body = JSON.parse(init.body);
    assert.equal(body.shipping_type, 'TIKTOK');
    return json(0, { orders: commandes[body.order_status] ?? [] });
  }
  const m = u.pathname.match(/^\/fulfillment\/202309\/packages\/(P\d)(\/.*)?$/);
  if (m) {
    const [, pid, suite] = m;
    if (!suite) return json(0, paquets[pid] ?? { package_status: 'TO_FULFILL', shipping_type: 'TIKTOK' });
    if (suite === '/handover_time_slots') return json(0, { can_pickup: true, can_drop_off: true, pickup_slots: [{ start_time: now + 3600, end_time: now + 7200, avaliable: true }] });
    if (suite === '/ship') { ships[pid] = JSON.parse(init.body); paquets[pid].package_status = 'PROCESSING'; return json(0, {}); }
    if (suite === '/shipping_documents') {
      if (pid === 'P1' && docTries++ === 0) return json(11034037, {}, 'still being generated');
      return json(0, { doc_url: `https://docs.test/${pid}.pdf`, tracking_number: `TRK-${pid}` });
    }
  }
  if (u.host === 'docs.test') return new Response(pdfA6, { headers: { 'content-type': 'application/pdf' } });
  throw new Error('URL inattendue ' + url);
};
const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => origSetTimeout(fn, Math.min(ms, 5), ...a);

const gmail = [];
const { _transportPourLesTests } = await import('../lib/mail.js');
_transportPourLesTests({ sendMail: async (m) => { gmail.push(m); return { messageId: 'g' + gmail.length }; } });
const { runOnce, veille, rattrapage, article } = await import('../lib/run.js');
const pages = async (b) => (await PDFDocument.load(b)).getPageCount();

// 1. Le test à blanc : il lit, il n'expédie rien, il n'écrit à personne.
await chargerReglages();
const blanc = await runOnce({ dryRun: true });
assert.equal(Object.keys(ships).length, 0, 'rien expédié à blanc');
assert.equal(gmail.length, 0, 'aucun mail à blanc');
assert.match(blanc.packages.find((p) => p.package_id === 'P1').action, /arrangerait/);

// 2. Le passage de midi
const r1 = await runOnce({});
assert.equal(r1.errors.length, 0, JSON.stringify(r1.errors));
assert.deepEqual(ships.P1, { handover_method: 'DROP_OFF' }, 'expédition arrangée en dépôt');
assert.equal(r1.labels.length, 1, 'seul P1 : P3 (vendeur) ignoré, P4 (à la main) pas renvoyé');
assert.equal(gmail.length, 1);
const m1 = gmail[0];
assert.deepEqual(m1.to, ['sami@entrepot.fr']);
assert.deepEqual(m1.cc, ['eleve@gmail.com'], "l'élève est en copie");
assert.equal(m1.from, 'Karim <eleve@gmail.com>');
assert.match(m1.subject, /1 colis \(2 × Organiseurs de valise, lot de 6 cubes de…/);
assert.match(m1.html, /Bonjour Sami/);
assert.match(m1.html, /Karim<\/p>$/);
assert.equal(await pages(m1.attachments[0].content), 2, 'étiquette + fiche de préparation');
assert.equal(r1.packages.find((p) => p.package_id === 'P3').action, 'ignoré (expédition par le vendeur)');

// 3. Un second appel le même jour ne renvoie rien.
const r2 = await runOnce({});
assert.ok(r2.deja_fait, 'passage du jour déjà fait');
assert.equal(gmail.length, 1);

// 4. Le rattrapage de 17 h : midi a tout fait, rien n'est refait.
const ra = await rattrapage({});
assert.equal(ra.midi, 'déjà fait');
assert.equal(gmail.length, 1);

// 5. Commande annulée après son étiquette : l'entrepôt est prévenu.
paquets.P1.package_status = 'CANCELLED';
commandes.AWAITING_SHIPMENT = [];
await veille({});
const annul = gmail.find((m) => /annulé/.test(m.subject));
assert.ok(annul, "mail d'annulation");
assert.deepEqual(annul.to, ['sami@entrepot.fr']);
assert.match(annul.html, /ne pas envoyer ce colis/);
assert.ok(gmail.some((m) => /⚠️/.test(m.subject) && m.to.includes('eleve@gmail.com')), "l'élève reçoit l'alerte");

// 6. Deux entrepôts : le colis va à celui dont le mot est dans le nom du produit ; sinon chez l'élève.
const r3 = await enregistrer({
  entrepots: [
    { nom: 'Logisticien Nord', contact: 'Sami', email: 'sami@entrepot.fr', mots_produit: 'valise, cube' },
    { nom: 'Atelier bougies', contact: '', email: 'bougies@atelier.fr', mots_produit: 'bougie', handover: 'PICKUP' },
  ],
});
assert.ok(r3.ok, JSON.stringify(r3.erreurs));
const sansMots = await enregistrer({ entrepots: [{ email: 'a@b.fr' }, { email: 'c@d.fr' }] });
assert.equal(sansMots.ok, false, 'avec deux entrepôts, les mots sont obligatoires');
paquets.P5 = { package_status: 'TO_FULFILL', shipping_type: 'TIKTOK' };
paquets.P6 = { package_status: 'TO_FULFILL', shipping_type: 'TIKTOK' };
commandes.AWAITING_SHIPMENT = [
  { id: 'O5', packages: [{ id: 'P5' }], line_items: [{ product_name: 'Bougie parfumée ambre', package_id: 'P5' }] },
  { id: 'O6', packages: [{ id: 'P6' }], line_items: [{ product_name: 'Tapis de yoga', package_id: 'P6' }] },
];
gmail.length = 0;
const r4 = await runOnce({ force: true });
assert.equal(r4.errors.length, 0, JSON.stringify(r4.errors));
assert.equal(ships.P5.handover_method, 'PICKUP', "l'atelier bougies est en enlèvement");
assert.ok(ships.P5.pickup_slot, 'créneau d’enlèvement choisi');
const bougies = gmail.find((m) => m.to.includes('bougies@atelier.fr'));
assert.ok(bougies && /^Bonjour,/.test(bougies.text), 'mail à l’atelier, sans prénom');
const orphelin = gmail.find((m) => /sans entrepôt trouvé/.test(m.subject));
assert.ok(orphelin && orphelin.to.includes('eleve@gmail.com'), 'le tapis (aucun mot) part chez l’élève');
assert.ok(gmail.some((m) => m.to.includes('sami@entrepot.fr') && /aucun colis/.test(m.subject)), '« aucun colis » pour Sami');

// 7. Sans « aucun colis », pas de mail les jours vides.
await enregistrer({ aucun_colis: false });
const st = await readJson('state.json');
st.midi = { jour: '2000-01-01', entrepots: {} };
await writeJson('state.json', st);
commandes.AWAITING_SHIPMENT = [];
gmail.length = 0;
await runOnce({});
assert.equal(gmail.filter((m) => /aucun colis/.test(m.subject)).length, 0, 'aucun mail vide');

// 8. Les noms d'articles
assert.equal(article({ product_name: 'Bougie', sku_name: 'Default' }), 'Bougie');
assert.equal(article({ product_name: 'Bougie', sku_name: 'Ambre' }), 'Bougie (Ambre)');

fs.rmSync('.data', { recursive: true, force: true });
console.log('mock.test.js : tout est bon');
