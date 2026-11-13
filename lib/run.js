// Le cœur du robot :
// - le passage de midi : les colis « à expédier » (expédition par TikTok), l'expédition arrangée, les étiquettes +
//   fiches de préparation, un PDF et un mail par entrepôt depuis ton Gmail (toi en copie), « aucun colis » les jours
//   vides si tu le veux ; un seul passage par jour ;
// - la veille (au début du passage de midi, et à 17 h) : un colis annulé après son étiquette (mail à l'entrepôt +
//   alerte), un colis pas pris en charge le jour ouvré suivant, un colis qui risque d'être en retard, et un mail URGENT
//   à l'entrepôt pour un colis étiqueté dont l'échéance de prise en charge approche ou est passée.
// Tu n'es prévenu qu'en cas de problème (un mail).
// Tous les pays : pour l'API, chaque pays est une boutique à part (son propre shop_cipher) ; le robot passe sur toutes
// les boutiques autorisées, et les colis de tous les pays partent dans le même mail par entrepôt.
import { PDFDocument } from 'pdf-lib';
import { makeClient, refreshToken, normalizeTokens, TikTokError } from './tiktok.js';
import { readJson, writeJson } from './store.js';
import { comptes, avecComptes } from './comptes.js';
import { sendMail, envoyerGmail, gmailPret } from './mail.js';
import { alerter } from './alerte.js';
import { esc } from './http.js';
import { fetchReessai } from './reseau.js';
import { env, entrepots, signature, jourParis, dateParis, heureParis, jourAlerteEnlevement, nomPays, adressePublique } from './config.js';

const RETRYABLE_DOC_CODES = new Set([11034037, 11034023, 11006010, 21023022, 36009003]);
const PARTIS = new Set(['FULFILLING', 'IN_TRANSIT', 'COMPLETED', 'DELIVERED']);
const EN_ATTENTE_ENLEVEMENT = new Set(['PROCESSING', 'AWAITING_COLLECTION', 'TO_BE_PICKED_UP']);
const RISQUE_RETARD_S = 6 * 3600; // alerte quand l'échéance d'expédition tombe dans moins de 6 h
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function reauthUrl() {
  return adressePublique() || 'la page de ton robot (bouton « Autoriser ma boutique »)';
}

// Chaque compte autorisé (lib/comptes.js) a son jeton : chacun est rafraîchi à deux jours de son expiration. Un compte
// qui n'y arrive pas n'arrête pas les autres ; si aucun n'y arrive, le passage échoue comme avant.
async function ensureTokens(log) {
  const liste = comptes(await readJson('tokens.json'));
  if (!liste.length) throw new Error('Aucune autorisation TikTok Shop enregistrée. Ouvre ' + reauthUrl());
  const now = Math.floor(Date.now() / 1000);
  let change = false, rates = 0, premiere = null;
  for (let i = 0; i < liste.length; i++) {
    const c = liste[i];
    if (c.access_expires_at - now > 2 * 86400) continue;
    log(`Jeton d'accès${c.seller_name ? ` de ${c.seller_name}` : ''} proche de l'expiration : rafraîchissement.`);
    try {
      const data = await refreshToken({ appKey: env('TTS_APP_KEY'), appSecret: env('TTS_APP_SECRET'), refreshToken: c.refresh_token });
      liste[i] = { ...c, ...normalizeTokens(data) };
      change = true;
    } catch (e) {
      rates++;
      premiere ??= e;
      log(`Rafraîchissement impossible${c.seller_name ? ` pour ${c.seller_name}` : ''} : ${e.message}`);
    }
  }
  if (rates && rates === liste.length) throw premiere;
  if (change) await writeJson('tokens.json', avecComptes(liste));
  return avecComptes(liste);
}

// Les boutiques à traiter : toutes celles que TikTok dit autorisées, pour chaque compte. La liste est relue à chaque
// passage, si bien qu'un pays autorisé plus tard est pris tout seul.
// TTS_SHOPS (« FR,DE ») restreint aux pays donnés.
async function boutiquesAutorisees(tokens, log) {
  const liste = comptes(tokens);
  const vues = [];
  let change = false;
  for (const c of liste) {
    let shops = c.shops ?? [];
    try {
      const client = makeClient({ appKey: env('TTS_APP_KEY'), appSecret: env('TTS_APP_SECRET'), accessToken: c.access_token });
      const lues = (await client.getAuthorizedShops()).shops ?? [];
      if (lues.length) {
        const cle = (l) => l.map((s) => s.cipher).sort().join(',');
        if (cle(lues) !== cle(shops)) {
          log(`Boutiques autorisées${c.seller_name ? ` (${c.seller_name})` : ''} : ${lues.map((s) => s.region).join(', ')} (avant : ${shops.map((s) => s.region).join(', ') || 'aucune'}).`);
          c.shops = lues;
          change = true;
        }
        shops = lues;
      }
    } catch (e) {
      log(`Liste des boutiques illisible${c.seller_name ? ` (${c.seller_name})` : ''} (${msgErreur(e)}) : celle de l'autorisation sert.`);
    }
    for (const s of shops) if (s.cipher && !vues.some((v) => v.shop.cipher === s.cipher)) vues.push({ shop: s, accessToken: c.access_token });
  }
  if (change) await writeJson('tokens.json', avecComptes(liste));
  const voulues = String(env('TTS_SHOPS', '')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const cipherEnv = env('TTS_SHOP_CIPHER');
  return vues.filter(({ shop: s }) => (!cipherEnv || s.cipher === cipherEnv) && (!voulues.length || voulues.includes(String(s.region).toUpperCase())));
}

// Le nom du transporteur tel que TikTok l'écrit (« Colissimo. »), sans le point.
function transporteurPropre(s) {
  return s ? String(s).replace(/\.+\s*$/, '').trim() || null : null;
}

// Les entrepôts TikTok d'un pays (ID → nom), lus une fois par passage, et seulement quand un ID est inconnu.
async function nomsEntrepotsTikTok(b, log) {
  if (!b.entrepotsTikTok) {
    b.entrepotsTikTok = new Map();
    try {
      for (const w of (await b.client.getWarehouses()).warehouses ?? []) b.entrepotsTikTok.set(String(w.id), String(w.name ?? ''));
    } catch (e) {
      log(`${b.region} : entrepôts TikTok illisibles (${msgErreur(e)}).`);
    }
  }
  return b.entrepotsTikTok;
}

function normStatus(s) {
  return String(s ?? '').toUpperCase().replace(/\s+/g, '_');
}

async function fetchDocWithRetry(client, packageId, opts, log, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await client.getShippingDocument(packageId, opts);
    } catch (e) {
      if (e instanceof TikTokError && RETRYABLE_DOC_CODES.has(e.code) && i < tries) {
        log(`Étiquette du colis ${packageId} pas encore prête (${e.code}), nouvel essai dans ${5 * i}s.`);
        await sleep(5000 * i);
        continue;
      }
      throw e;
    }
  }
}

function msgErreur(e) {
  return e instanceof TikTokError ? `${e.message} (request_id ${e.requestId ?? '?'})` : e.message;
}

// L'entrepôt d'un colis : avec un seul entrepôt, toujours lui. Avec plusieurs, dans cet ordre : l'ID d'entrepôt TikTok,
// le nom de l'entrepôt TikTok, puis un mot du nom du produit (« tapis », « bougie »…). Aucun : null (le colis part chez
// toi, à transmettre).
export function entrepotDe(lignes, commande, nomTikTok = '') {
  const liste = entrepots();
  if (liste.length === 1) return liste[0];
  const ids = new Set([commande?.warehouse_id, ...lignes.map((l) => l.warehouse_id)].filter(Boolean).map(String));
  const nom = String(nomTikTok ?? '').toLowerCase();
  const texte = lignes.map((l) => `${l.product_name ?? ''} ${l.sku_name ?? ''}`).join(' ').toLowerCase();
  return (
    liste.find((e) => (e.warehouse_ids ?? []).some((w) => ids.has(String(w)))) ??
    (nom ? liste.find((e) => (e.noms_entrepot ?? []).some((n) => nom.includes(String(n).toLowerCase()))) : undefined) ??
    liste.find((e) => (e.mots_produit ?? []).some((m) => texte.includes(String(m).toLowerCase()))) ??
    null
  );
}

// Le nom d'un article pour le récap de l'entrepôt : le nom du produit, raccourci, et sa variante (« Bleu », « XL »).
function court(t, n = 48) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const c = s.slice(0, n);
  const i = c.lastIndexOf(' ');
  return `${c.slice(0, i > 20 ? i : n)}…`;
}
export function article(ligne) {
  const p = court(ligne.product_name || 'Article');
  const v = String(ligne.sku_name ?? '').trim();
  return v && !/^(default|par d[ée]faut|standard|-)$/i.test(v) ? `${p} (${v})` : p;
}

// L'échéance qui compte pour le taux d'expédition à temps (API 202309) : à expédier → `rts_sla_time` (dernière heure
// pour arranger l'expédition) ; en attente du transporteur → `tts_sla_time` (dernière heure de prise en charge).
// `shipping_due_time` et `collection_due_time` (annulation automatique) servent de repli.
function echeance(o, statut) {
  const t = statut === 'AWAITING_COLLECTION'
    ? Number(o.tts_sla_time || o.collection_due_time || 0)
    : Number(o.rts_sla_time || o.shipping_due_time || 0);
  return t > 0 ? t : null;
}

// Les colis en cours de toutes les boutiques : colis → pays, commandes, articles, entrepôt, transporteur, échéance.
// Expédition par la plateforme seulement. Un pays illisible (coupure, droits) n'empêche pas les autres : il est noté
// dans `echecs` ; si aucun pays n'est lisible, le passage échoue comme avant.
async function colisEnCours(boutiques, log, echecs = []) {
  const colis = new Map();
  const plusieurs = boutiques.length > 1;
  let premiere = null;
  for (const b of boutiques) {
    try {
      for (const st of ['AWAITING_SHIPMENT', 'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION']) {
        const orders = await b.client.searchOrders({ orderStatus: st });
        log(`${plusieurs ? `${b.region} · ` : ''}${orders.length} commande(s) ${st}`);
        for (const o of orders) {
          const lignes = o.line_items ?? [];
          const paquets = (o.packages ?? []).map((p) => String(p.id));
          for (const pid of paquets) {
            const siennes = lignes.filter((l) => paquets.length === 1 || !l.package_id || String(l.package_id) === pid);
            const c = colis.get(pid) ?? { package_id: pid, boutique: b.region, client: b.client, commandes: new Set(), lignes: [], echeance: null, transporteur: null };
            c.commandes.add(String(o.id));
            c.statut ??= st; // AWAITING_COLLECTION = étiqueté, en attente du transporteur
            c.lignes.push(...siennes);
            const ech = echeance(o, st);
            if (ech && (!c.echeance || ech < c.echeance)) c.echeance = ech;
            c.transporteur ||= transporteurPropre(o.shipping_provider || siennes.find((l) => l.shipping_provider_name)?.shipping_provider_name);
            const wid = String(o.warehouse_id || siennes.find((l) => l.warehouse_id)?.warehouse_id || '');
            const parNom = entrepots().some((e) => (e.noms_entrepot ?? []).length);
            const connu = !parNom || !wid || entrepots().some((e) => (e.warehouse_ids ?? []).map(String).includes(wid));
            const nom = connu ? '' : (await nomsEntrepotsTikTok(b, log)).get(wid) ?? '';
            c.entrepot = entrepotDe(c.lignes, o, nom);
            colis.set(pid, c);
          }
        }
      }
    } catch (e) {
      premiere ??= e;
      log(`${b.region} : commandes illisibles (${msgErreur(e)}).`);
      echecs.push({ boutique: b.region, error: `commandes illisibles : ${msgErreur(e)}` });
    }
  }
  if (premiere && echecs.length === boutiques.length) throw premiere;
  return colis;
}

async function contexte(log) {
  const tokens = await ensureTokens(log);
  const vues = await boutiquesAutorisees(tokens, log);
  if (!vues.length) throw new Error('Aucune boutique autorisée trouvée. Ré-autorise via ' + reauthUrl());
  log(`Boutique${vues.length > 1 ? 's' : ''} : ${vues.map(({ shop: s }) => `${s.name} (${s.region ?? '?'})`).join(', ')}`);
  const boutiques = vues.map(({ shop, accessToken }) => ({
    shop,
    region: String(shop.region ?? '?').toUpperCase(),
    client: makeClient({ appKey: env('TTS_APP_KEY'), appSecret: env('TTS_APP_SECRET'), accessToken, shopCipher: shop.cipher }),
    entrepotsTikTok: null,
  }));
  return { boutiques };
}

async function lireEtat() {
  const state = (await readJson('state.json', { sent: {} })) ?? { sent: {} };
  state.sent ??= {};
  state.retard_alerte ??= {};
  state.arranges ??= {}; // les colis dont le robot a lui-même arrangé l'expédition
  state.urgences ??= {}; // colis → { dernier: jour du dernier mail urgent, nb: nombre de mails }
  return state;
}

// ------------------------------------------------------------------------------------------------ les urgences

// Le mail urgent à l'entrepôt : des colis étiquetés que le transporteur n'a pas pris en charge, dont l'échéance TikTok
// tombe dans moins de 18 h ou est passée. Le mail liste chaque colis (pays, commande, suivi, article, échéance), joint
// les étiquettes (chacune suivie de sa fiche) et demande de répondre une fois déposés ; tu es en copie.
const URGENCE_S = 18 * 3600;
const URGENCES_MAX = 5; // au plus 5 mails par colis (un par jour)

function optionsDocument() {
  return { documentType: env('DOCUMENT_TYPE', 'SHIPPING_LABEL_AND_PACKING_SLIP'), documentSize: env('DOCUMENT_SIZE', 'A6') };
}

export function mailUrgent(e, liste, maintenant = new Date()) {
  const maint = Math.floor(maintenant.getTime() / 1000);
  const relance = Math.max(0, ...liste.map((l) => l.nb ?? 0));
  const pays = [...new Set(liste.map((l) => nomPays(l.boutique)))];
  const quand = (ech) => (!ech ? '' : ech < maint ? `en retard depuis le ${dateParis(new Date(ech * 1000))}` : `à faire prendre en charge avant le ${heureParis(new Date(ech * 1000))}`);
  const desc = (l) => `${nomPays(l.boutique)} — commande ${l.order_ids.join(', ')} — ${l.transporteur ?? 'transporteur ?'}${l.tracking ? ` ${l.tracking}` : ''} — ${Object.entries(l.articles).map(([a, n]) => `${n} × ${a}`).join(', ')}${l.echeance ? ` — ${quand(l.echeance)}` : ''}`;
  const transporteurs = [...new Set(liste.map((l) => l.transporteur ?? 'transporteur ?'))];
  const attention = transporteurs.length > 1 ? `Attention, plusieurs transporteurs (${transporteurs.join(', ')}) : dépose chaque colis chez le sien.` : '';
  const sansPdf = liste.filter((l) => !l.pdf).length;
  const pieces = sansPdf ? `Les étiquettes sont dans le PDF joint, sauf ${sansPdf} que TikTok n'a pas pu redonner.` : "Si tu n'as plus ces étiquettes, elles sont toutes dans le PDF joint : chaque étiquette est suivie de sa fiche de préparation à glisser dans le colis.";
  const subject = `${relance ? `RELANCE ${relance + 1} – ` : ''}URGENT – ${liste.length} colis à déposer aujourd’hui (${pays.join(', ')})`;
  const intro = `${liste.length} colis ${liste.length > 1 ? 'ne sont' : "n'est"} toujours pas pris en charge par le transporteur. ${liste.length > 1 ? 'Il faut les' : 'Il faut le'} déposer aujourd'hui.`;
  const html = `<p>Bonjour${e.contact ? ` ${esc(e.contact)}` : ''},</p><p><b>Urgent :</b> ${esc(intro)}</p><ul>${liste.map((l) => `<li>${esc(desc(l))}</li>`).join('')}</ul>${attention ? `<p><b>${esc(attention)}</b></p>` : ''}<p>${esc(pieces)}</p><p>Peux-tu répondre à ce mail dès qu'${liste.length > 1 ? 'ils sont déposés' : 'il est déposé'} ? Merci beaucoup.</p><p>${esc(signature())}</p>`;
  const text = `Bonjour${e.contact ? ` ${e.contact}` : ''},\n\nUrgent : ${intro}\n\n${liste.map((l) => `- ${desc(l)}`).join('\n')}\n\n${attention ? `${attention}\n\n` : ''}${pieces}\n\nPeux-tu répondre à ce mail dès qu'${liste.length > 1 ? 'ils sont déposés' : 'il est déposé'} ? Merci beaucoup.\n\n${signature()}`;
  return { subject, html, text };
}

// Envoie les mails urgents (un par entrepôt) et rend les lignes de l'alerte.
async function envoyerUrgences({ urgents, state, log, maintenant }) {
  const aujourdhui = jourParis(maintenant);
  const lignes = [];
  const parEntrepot = new Map();
  for (const c of urgents) {
    const k = c.entrepot?.cle ?? '';
    if (!parEntrepot.has(k)) parEntrepot.set(k, []);
    parEntrepot.get(k).push(c);
  }
  for (const [cle, liste] of parEntrepot) {
    const e = entrepots().find((x) => x.cle === cle);
    if (!e?.email) {
      lignes.push(`Urgent, sans entrepôt trouvé : ${liste.map((c) => [...c.commandes].join(', ')).join(' ; ')} (à transmettre toi-même)`);
      continue;
    }
    const colisMail = [];
    for (const c of liste) {
      const l = { package_id: c.package_id, order_ids: [...c.commandes], boutique: c.boutique, transporteur: c.transporteur, echeance: c.echeance, nb: state.urgences[c.package_id]?.nb ?? 0, articles: {}, tracking: null, pdf: null };
      for (const ligne of c.lignes) {
        const a = article(ligne);
        l.articles[a] = (l.articles[a] ?? 0) + Number(ligne.quantity ?? 1);
      }
      try {
        const doc = await fetchDocWithRetry(c.client, c.package_id, optionsDocument(), log, 2);
        l.tracking = doc.tracking_number || null;
        const res = await fetchReessai(doc.doc_url);
        if (res.ok) l.pdf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        log(`Urgence : étiquette du colis ${c.package_id} illisible (${msgErreur(err)})`);
      }
      colisMail.push(l);
    }
    const { subject, html, text } = mailUrgent(e, colisMail, maintenant);
    const avecPdf = colisMail.filter((l) => l.pdf);
    try {
      const attachments = avecPdf.length ? [{ filename: `Etiquettes_urgentes_${aujourdhui}_${e.cle}.pdf`, content: await fusion(avecPdf, { errors: [] }) }] : [];
      await envoyerGmail({ to: e.email, subject, html, text, attachments });
      for (const l of colisMail) state.urgences[l.package_id] = { dernier: aujourdhui, nb: l.nb + 1 };
      lignes.push(`Mail urgent envoyé à ${e.nom} : ${colisMail.length} colis à déposer (${[...new Set(colisMail.map((l) => nomPays(l.boutique)))].join(', ')})`);
      log(`Urgence : mail à ${e.cle} pour ${colisMail.length} colis.`);
    } catch (err) {
      lignes.push(`Mail urgent à ${e.nom} impossible (${err.message}) : ${colisMail.map((l) => l.order_ids.join(', ')).join(' ; ')}`);
      log(`Urgence : mail à ${e.cle} impossible (${err.message})`);
    }
  }
  return lignes;
}

// ------------------------------------------------------------------------------------------------ la veille

async function veilleInterne({ boutiques, state, colis, dryRun, log, maintenant = new Date() }) {
  const aujourdhui = jourParis(maintenant);
  const heure = Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(maintenant));
  const nonPris = [], annules = [], retards = [];
  const limite = new Date(maintenant.getTime() - 10 * 86400 * 1000).toISOString().slice(0, 10);
  // Chaque colis se lit dans la boutique de son pays.
  const clients = new Map(boutiques.map((b) => [b.region, b.client]));

  for (const [pid, s] of Object.entries(state.sent)) {
    if (s.parti || s.annule_notifie || (s.date ?? '') < limite) continue;
    const client = clients.get(s.boutique ?? 'FR');
    if (!client) continue; // pays qui n'est plus autorisé
    let d;
    try {
      d = await client.getPackage(pid);
    } catch (e) {
      log(`Veille : colis ${pid} illisible (${msgErreur(e)})`);
      continue;
    }
    const st = normStatus(d.package_status);
    if (PARTIS.has(st)) {
      s.parti = maintenant.toISOString();
    } else if (st === 'CANCELLED') {
      annules.push({ pid, s });
    } else if (EN_ATTENTE_ENLEVEMENT.has(st) && !s.alerte_enlevement && aujourdhui >= jourAlerteEnlevement(s.date) && heure >= 12) {
      nonPris.push({ pid, s });
    }
  }

  for (const c of colis?.values() ?? []) {
    if (!c.echeance || state.retard_alerte[c.package_id]) continue;
    if (state.sent[c.package_id]?.parti) continue;
    if (c.echeance - Math.floor(maintenant.getTime() / 1000) < RISQUE_RETARD_S) retards.push(c);
  }

  // Les urgences pour l'entrepôt : étiqueté, pas pris en charge, échéance dans moins de 18 h ou passée (ou signalé « pas
  // pris en charge »), un mail par jour et par colis au plus.
  const maint = Math.floor(maintenant.getTime() / 1000);
  const nonPrisIds = new Set(nonPris.map(({ pid }) => pid));
  const urgents = [];
  for (const c of colis?.values() ?? []) {
    if (c.statut !== 'AWAITING_COLLECTION' || state.sent[c.package_id]?.parti) continue;
    if (!(c.echeance && c.echeance - maint < URGENCE_S) && !nonPrisIds.has(c.package_id)) continue;
    const u = state.urgences?.[c.package_id];
    if (u?.dernier === aujourdhui || (u?.nb ?? 0) >= URGENCES_MAX) continue;
    urgents.push(c);
  }

  const rapport = { non_pris: nonPris.length, annules: annules.length, retards: retards.length, urgences: urgents.length };
  if (dryRun) return rapport;
  state.urgences ??= {};
  const lignesUrgences = urgents.length ? await envoyerUrgences({ urgents, state, log, maintenant }) : [];

  // Commande annulée après son étiquette : l'entrepôt ne doit pas envoyer le colis.
  for (const { pid, s } of annules) {
    const e = entrepots().find((x) => x.cle === s.entrepot);
    try {
      if (e?.email) {
        await envoyerGmail({
          to: e.email,
          subject: `Colis annulé : ne pas envoyer (commande ${s.orders.join(', ')})`,
          html: `<p>Bonjour${e.contact ? ` ${esc(e.contact)}` : ''},</p><p>La commande <b>${s.orders.map(esc).join(', ')}</b> a été annulée par le client. Merci de <b>ne pas envoyer ce colis</b>${s.tracking ? ` (étiquette n° ${esc(s.tracking)})` : ''} et de le remettre en stock.</p><p>Merci,<br>${esc(signature())}</p>`,
          text: `Bonjour${e.contact ? ` ${e.contact}` : ''},\nLa commande ${s.orders.join(', ')} a été annulée par le client. Merci de ne pas envoyer ce colis${s.tracking ? ` (étiquette n° ${s.tracking})` : ''} et de le remettre en stock.\nMerci,\n${signature()}`,
        });
      }
      s.annule_notifie = maintenant.toISOString();
    } catch (err) {
      log(`Veille : mail d'annulation impossible pour ${pid} (${err.message})`);
    }
  }

  const lignes = [
    ...annules.map(({ s }) => `Annulée après l'étiquette : commande ${s.orders.join(', ')} (${s.entrepot ?? '?'}), entrepôt prévenu`),
    ...nonPris.map(({ s }) => `Pas encore pris en charge : commande ${s.orders.join(', ')}, étiquette du ${s.date} (${s.entrepot ?? '?'})`),
    ...retards.map((c) => `Risque de retard : commande ${[...c.commandes].join(', ')}, échéance ${heureParis(new Date(c.echeance * 1000))}`),
    ...lignesUrgences,
  ];
  if (lignes.length) {
    const parts = [];
    if (annules.length) parts.push(`${annules.length} commande(s) annulée(s) après l'étiquette, entrepôt prévenu`);
    if (nonPris.length) parts.push(`${nonPris.length} colis pas encore pris en charge par le transporteur`);
    if (retards.length) parts.push(`${retards.length} colis risque(nt) d'être en retard`);
    if (urgents.length) parts.push(`${urgents.length} colis en urgence : mail urgent à l'entrepôt`);
    await alerter({ titre: 'Expéditions TikTok Shop', message: parts.join(' · '), lignes });
    for (const { s } of nonPris) s.alerte_enlevement = maintenant.toISOString();
    for (const c of retards) state.retard_alerte[c.package_id] = maintenant.toISOString();
  }
  // Ménage : les alertes de retard de plus de 30 jours
  const vieux = new Date(maintenant.getTime() - 30 * 86400 * 1000).toISOString();
  for (const [k, v] of Object.entries(state.retard_alerte)) if (v < vieux) delete state.retard_alerte[k];
  return rapport;
}

export async function veille({ dryRun = false, log = () => {} } = {}) {
  const { boutiques } = await contexte(log);
  const state = await lireEtat();
  const echecs = [];
  const colis = await colisEnCours(boutiques, log, echecs);
  const rapport = await veilleInterne({ boutiques, state, colis, dryRun, log });
  if (!dryRun) {
    state.last_veille = { at: new Date().toISOString(), ...rapport };
    await writeJson('state.json', state);
  }
  return { mode: 'veille', dry_run: dryRun, ...rapport, ...(echecs.length ? { errors: echecs } : {}) };
}

// ------------------------------------------------------------------------------------------------ midi

// Le récap du mail : le total à préparer, puis une ligne par colis avec son pays et son transporteur. Plusieurs
// transporteurs → une ligne d'avertissement.
function recapHtml(liste) {
  const parArticle = {};
  for (const l of liste) for (const [a, n] of Object.entries(l.articles)) parArticle[a] = (parArticle[a] ?? 0) + n;
  const total = Object.entries(parArticle).map(([a, n]) => `<li><b>${n}</b> × ${esc(a)}</li>`).join('');
  const parTransporteur = {};
  for (const l of liste) {
    const k = `${l.transporteur ?? 'transporteur ?'} (${nomPays(l.boutique)})`;
    parTransporteur[k] = (parTransporteur[k] ?? 0) + 1;
  }
  const melange = Object.keys(parTransporteur).length > 1;
  const transporteurs = Object.entries(parTransporteur).map(([k, n]) => `${n} × ${k}`).join(', ');
  const rows = liste
    .map((l) => `<tr><td>${l.order_ids.map(esc).join('<br>')}</td><td>${esc(nomPays(l.boutique))}</td><td>${esc(Object.entries(l.articles).map(([a, n]) => `${n} × ${a}`).join(', '))}</td><td>${esc(l.transporteur ?? '')}</td><td>${esc(l.tracking ?? '')}</td></tr>`)
    .join('');
  const avertissement = melange ? `<p><b>Attention, plusieurs transporteurs :</b> ${esc(transporteurs)}.</p>` : '';
  return {
    parArticle,
    transporteurs: melange ? transporteurs : '',
    html: `<p>À préparer :</p><ul>${total}</ul>${avertissement}<table border="1" cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:13px"><tr><th>Commande</th><th>Pays</th><th>Articles</th><th>Transporteur</th><th>Suivi</th></tr>${rows}</table>`,
  };
}

async function fusion(etiquettes, report) {
  const merged = await PDFDocument.create();
  for (const l of etiquettes) {
    try {
      const src = await PDFDocument.load(l.pdf, { ignoreEncryption: true });
      (await merged.copyPages(src, src.getPageIndices())).forEach((p) => merged.addPage(p));
    } catch (e) {
      report.errors.push({ package_id: l.package_id, order_ids: l.order_ids, error: `PDF illisible pour la fusion : ${e.message}` });
    }
  }
  return Buffer.from(await merged.save());
}

// autreEssai : un nouvel essai est prévu (à 17 h) si celui-ci a des erreurs ; l'alerte attend donc ce dernier essai.
export async function runOnce({ dryRun = false, force = false, autreEssai = false, log = () => {} } = {}) {
  const startedAt = new Date();
  const jour = jourParis(startedAt);
  const report = { mode: 'midi', started_at: startedAt.toISOString(), dry_run: dryRun, boutiques: [], orders: 0, packages: [], labels: [], errors: [], mails: [] };

  const { boutiques } = await contexte(log);
  report.boutiques = boutiques.map((b) => ({ name: b.shop.name, region: b.region, code: b.shop.code }));
  const state = await lireEtat();

  // Un seul mail par entrepôt et par jour : un nouvel essai ne refait que ce qui a raté.
  if (state.midi?.jour !== jour) state.midi = { jour, entrepots: {} };
  const faits = state.midi.entrepots;
  // Les pays illisibles au dernier essai : leurs commandes sont encore à faire aujourd'hui, même si l'entrepôt a déjà eu
  // son mail (il en reçoit alors un second).
  const aRefaire = new Set(state.midi.pays_a_refaire ?? []);
  // Un colis arrangé aujourd'hui dont l'étiquette n'est pas partie (coupure pendant le passage) : on y retourne.
  const enSuspens = Object.entries(state.arranges).some(([pid, a]) => a.date === jour && !state.sent[pid]);
  if (!entrepots().length) throw new Error("Aucun entrepôt réglé : indique l'adresse de ton entrepôt sur la page du robot.");
  if (!force && !dryRun && !enSuspens && !aRefaire.size && entrepots().every((e) => faits[e.cle])) {
    log(`Passage du jour déjà fait.`);
    return { ...report, deja_fait: faits };
  }

  // Sécurité : une étiquette créée qui ne part pas chez l'entrepôt, c'est un colis en retard. Sans Gmail, le robot ne
  // crée rien.
  if (!dryRun && !gmailPret()) throw new Error("Gmail pas réglé : aucune étiquette créée aujourd'hui.");

  const echecs = [];
  const colis = await colisEnCours(boutiques, log, echecs);
  report.errors.push(...echecs);
  report.orders = new Set([...colis.values()].flatMap((c) => [...c.commandes])).size;
  report.veille = await veilleInterne({ boutiques, state, colis, dryRun, log, maintenant: startedAt });

  const shipMode = env('SHIP_MODE', 'auto');
  const docOpts = { documentType: env('DOCUMENT_TYPE', 'SHIPPING_LABEL_AND_PACKING_SLIP'), documentSize: env('DOCUMENT_SIZE', 'A6') };
  const etiquettes = [];

  for (const c of colis.values()) {
    const packageId = c.package_id;
    const orderIds = [...c.commandes];
    const e = c.entrepot;
    const client = c.client;
    const entry = { package_id: packageId, order_ids: orderIds, boutique: c.boutique, entrepot: e?.cle ?? null, action: null, status: null, tracking: null };
    report.packages.push(entry);
    try {
      const d = await client.getPackage(packageId);
      const status = normStatus(d.package_status);
      entry.status = status;
      entry.tracking = d.tracking_number || null;
      c.transporteur = transporteurPropre(d.shipping_provider_name) || c.transporteur;
      if (normStatus(d.shipping_type) === 'SELLER') { entry.action = 'ignoré (expédition par le vendeur)'; continue; }
      if (['CANCELLED', ...PARTIS].includes(status)) { entry.action = `ignoré (${status})`; continue; }
      if (state.sent[packageId]) { entry.action = `déjà envoyé le ${state.sent[packageId].date}`; continue; }

      if (status === 'TO_FULFILL') {
        if (shipMode !== 'auto') { entry.action = 'en attente : expédition non arrangée (SHIP_MODE=labels_only)'; continue; }
        // Un nouvel essai de l'après-midi ne refait que ce qui a raté : une commande arrivée après le mail du jour de
        // son entrepôt part au passage de demain midi (un seul mail par jour, sauf pour rattraper un colis raté).
        if (e && faits[e.cle] && !force && !state.arranges[packageId] && !aRefaire.has(c.boutique)) { entry.action = 'nouvelle commande : passage de demain'; continue; }
        let methode = e?.handover || env('HANDOVER_METHOD', 'DROP_OFF');
        if (dryRun) { entry.action = `[test] arrangerait l'expédition (${methode})`; continue; }
        const shipOpts = { handoverMethod: methode };
        // Réponse : can_pickup, can_drop_off, pickup_slots[] {start_time, end_time, avaliable (sic)}. Un transporteur
        // d'un autre pays qui ne prend pas de dépôt (can_drop_off: false) : on passe à l'enlèvement.
        let r = null;
        if (methode === 'DROP_OFF') {
          r = await client.getHandoverTimeSlots(packageId).catch(() => null);
          if (r?.can_drop_off === false) { methode = 'PICKUP'; shipOpts.handoverMethod = 'PICKUP'; }
        }
        if (methode === 'PICKUP') {
          r ??= await client.getHandoverTimeSlots(packageId).catch(() => ({}));
          const slot = r.can_pickup === false ? null
            : (r.pickup_slots ?? []).find((x) => x?.start_time && x.avaliable !== false && x.available !== false) ?? null;
          if (slot) shipOpts.pickupSlot = { start_time: slot.start_time, end_time: slot.end_time };
          else { methode = 'DROP_OFF'; shipOpts.handoverMethod = 'DROP_OFF'; } // pas d'enlèvement proposé pour ce colis
        }
        // Noté AVANT l'appel : si internet coupe pendant la réponse, TikTok a peut-être arrangé l'expédition sans que le
        // robot le sache ; le colis reste alors au robot, et le prochain essai récupère son étiquette.
        state.arranges[packageId] = { date: jour, entrepot: e?.cle ?? null, boutique: c.boutique };
        await writeJson('state.json', state); // une étiquette payée ne doit jamais être oubliée
        try {
          await client.shipPackage(packageId, shipOpts);
        } catch (err) {
          if (err instanceof TikTokError && err.refus) {
            delete state.arranges[packageId]; // TikTok a dit non : rien n'est arrangé
            await writeJson('state.json', state);
          }
          throw err;
        }
        log(`Colis ${packageId} : expédition arrangée (${methode}).`);
        entry.action = `expédition arrangée (${methode === 'PICKUP' ? 'enlèvement' : 'dépôt'})`;
        await sleep(3000);
      } else if (EN_ATTENTE_ENLEVEMENT.has(status) && !state.arranges[packageId]) {
        // Préparé à la main dans le Seller Center : l'entrepôt a déjà son étiquette, on ne la renvoie pas (doublon).
        entry.action = 'préparé à la main, pas renvoyé';
        continue;
      } else if (EN_ATTENTE_ENLEVEMENT.has(status)) {
        entry.action = 'déjà arrangé par le robot, étiquette récupérée';
        if (dryRun) { entry.action = "[test] récupérerait l'étiquette"; continue; }
      } else {
        entry.action = `statut ${status}, tentative d'étiquette`;
        if (dryRun) continue;
      }

      const doc = await fetchDocWithRetry(client, packageId, docOpts, log);
      entry.tracking = doc.tracking_number || entry.tracking;
      const res = await fetchReessai(doc.doc_url);
      if (!res.ok) throw new Error(`Téléchargement du PDF impossible (${res.status})`);
      const pdf = Buffer.from(await res.arrayBuffer());
      const articles = {};
      for (const l of c.lignes) {
        const a = article(l);
        articles[a] = (articles[a] ?? 0) + Number(l.quantity ?? 1);
      }
      etiquettes.push({ package_id: packageId, order_ids: orderIds, tracking: entry.tracking, boutique: c.boutique, transporteur: c.transporteur, entrepot: e?.cle ?? null, articles, pdf });
      log(`Colis ${packageId} : étiquette ${pdf.length} octets.`);
    } catch (err) {
      const msg = msgErreur(err);
      entry.action = `ERREUR : ${msg}`;
      report.errors.push({ package_id: packageId, order_ids: orderIds, entrepot: e?.cle ?? null, error: msg });
      log(`Colis ${packageId} : ${msg}`);
    }
  }

  report.labels = etiquettes.map(({ pdf, ...rest }) => rest);
  if (dryRun) {
    report.finished_at = new Date().toISOString();
    return report;
  }

  // Un mail par entrepôt ; « aucun colis » les jours vides, si l'option est cochée.
  const aucunColis = env('aucun_colis', true) !== false && env('MAIL_WHEN_EMPTY', 'true') !== 'false';
  const date = dateParis(startedAt);
  for (const e of entrepots()) {
    const siennes = etiquettes.filter((l) => l.entrepot === e.cle);
    const n = siennes.length;
    if (faits[e.cle] && !n && !force) continue; // déjà prévenu aujourd'hui, rien de nouveau
    // Un colis de cet entrepôt a raté (coupure) : pas de « aucun colis » trompeur, le prochain essai enverra l'étiquette.
    if (!n && report.errors.some((x) => x.package_id && x.entrepot === e.cle)) {
      log(`Mail ${e.cle} : retenu, un colis est en erreur.`);
      continue;
    }
    // Un pays n'a pas pu être lu : ses colis sont peut-être pour cet entrepôt, pas de « aucun colis » non plus.
    if (!n && echecs.length) {
      log(`Mail ${e.cle} : retenu, ${echecs.map((x) => x.boutique).join(', ')} illisible(s).`);
      continue;
    }
    try {
      let mail;
      const bonjour = `Bonjour${e.contact ? ` ${e.contact}` : ''}`;
      if (!n && !aucunColis) {
        faits[e.cle] = new Date().toISOString();
        continue;
      }
      if (!n) {
        mail = await envoyerGmail({
          to: e.email,
          subject: `Expéditions du ${date} : aucun colis`,
          html: `<p>${esc(bonjour)},</p><p>Aucun colis à expédier aujourd'hui.</p><p>Merci,<br>${esc(signature())}</p>`,
          text: `${bonjour},\nAucun colis à expédier aujourd'hui.\nMerci,\n${signature()}`,
        });
      } else {
        const { parArticle, html, transporteurs } = recapHtml(siennes);
        const resume = Object.entries(parArticle).map(([a, k]) => `${k} × ${a}`).join(', ');
        const pdf = await fusion(siennes, report);
        mail = await envoyerGmail({
          to: e.email,
          subject: `Expéditions du ${date} : ${n} colis (${resume})`,
          html: `<p>${esc(bonjour)},</p><p>Voici les <b>${n}</b> étiquette${n > 1 ? 's' : ''} du jour. Dans le PDF, chaque étiquette est suivie de sa fiche de préparation à glisser dans le colis. </p>${html}<p>Merci,<br>${esc(signature())}</p>`,
          text: `${bonjour},\n${n} colis aujourd'hui : ${resume}.\n` + (transporteurs ? `Attention, plusieurs transporteurs : ${transporteurs}.\n` : '') + 'Chaque étiquette est suivie de sa fiche de préparation.\n' + siennes.map((l) => `${l.order_ids.join(', ')} (${nomPays(l.boutique)}) : ${Object.entries(l.articles).map(([a, k]) => `${k} × ${a}`).join(', ')}${l.transporteur ? `, ${l.transporteur}` : ''}`).join('\n') + `\nMerci,\n${signature()}`,
          attachments: [{ filename: `Expeditions_${jour}_${e.cle}.pdf`, content: pdf }],
        });
        for (const l of siennes) {
          state.sent[l.package_id] = { date: jour, orders: l.order_ids, tracking: l.tracking, entrepot: e.cle, boutique: l.boutique };
        }
      }
      faits[e.cle] = new Date().toISOString();
      report.mails.push({ entrepot: e.cle, colis: n, via: mail.via, id: mail.id });
      log(`Mail ${e.cle} (${n} colis) envoyé par ${mail.via}.`);
    } catch (err) {
      report.errors.push({ entrepot: e.cle, error: `mail impossible : ${err.message}` });
      log(`Mail ${e.cle} impossible : ${err.message}`);
    }
  }

  // Un colis sans entrepôt trouvé : il part chez toi, pour que tu le transmettes.
  const orphelines = etiquettes.filter((l) => !l.entrepot);
  if (orphelines.length) {
    try {
      await sendMail({
        subject: `Étiquettes sans entrepôt trouvé – ${date}`,
        html: `<p>${orphelines.length} étiquette(s) dont le produit ne correspond à aucun entrepôt de ta page : à transmettre toi-même. Pour la suite, ajoute un mot de ce produit à l'entrepôt qui l'expédie.</p>`,
        text: `${orphelines.length} étiquette(s) sans entrepôt trouvé, à transmettre toi-même.`,
        attachments: [{ filename: `Expeditions_${jour}_a-trier.pdf`, content: await fusion(orphelines, report) }],
      });
      for (const l of orphelines) state.sent[l.package_id] = { date: jour, orders: l.order_ids, tracking: l.tracking, entrepot: null, boutique: l.boutique };
    } catch (err) {
      report.errors.push({ error: `mail des étiquettes sans entrepôt impossible : ${err.message}` });
    }
  }

  // Problèmes du passage : une seule alerte.
  const pb = [
    ...report.errors.map((x) => (x.order_ids ? `Commande ${x.order_ids.join(', ')} : ${x.error}` : x.boutique ? `${nomPays(x.boutique)} : ${x.error}` : `${x.entrepot ?? ''} ${x.error}`.trim())),
    ...(orphelines.length ? [`${orphelines.length} étiquette(s) sans entrepôt trouvé, envoyées dans ta boîte`] : []),
  ];
  if (pb.length && autreEssai && report.errors.length) {
    log(`${report.errors.length} erreur(s) : nouvel essai à 17 h, l'alerte attend ce dernier essai.`);
  } else if (pb.length) {
    await alerter({ titre: 'Expéditions de midi : à vérifier', message: `${pb.length} point(s) à vérifier sur le passage du ${date}`, lignes: pb });
  }

  const cutoff = new Date(Date.now() - 45 * 86400 * 1000).toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(state.sent)) if (v.date < cutoff) delete state.sent[k];
  for (const [k, v] of Object.entries(state.arranges)) if (v.date < cutoff) delete state.arranges[k];
  state.midi.pays_a_refaire = echecs.map((x) => x.boutique);
  state.last_run = { at: report.started_at, boutiques: report.boutiques.map((b) => b.region), orders: report.orders, labels: etiquettes.length, errors: report.errors.length, mails: report.mails };
  await writeJson('state.json', state);
  report.finished_at = new Date().toISOString();
  return report;
}

// Alerte quand le passage lui-même échoue (autorisation expirée, réseau…).
export async function alertFailure(err) {
  await alerter({
    titre: 'Pilote automatique : passage raté',
    message: `Le passage a échoué : ${err.message}`.slice(0, 300),
    lignes: [`Ouvre la page du robot : ${reauthUrl()}. Si c'est l'autorisation TikTok, clique « Autoriser ma boutique ».`],
  });
}

// Le second passage de la journée (17 h) : la veille, puis ce que le passage de midi n'a pas fini (passage raté,
// pays illisible, colis arrangé sans étiquette envoyée). S'il a tout fait, rien n'est refait.
export async function rattrapage({ log = () => {} } = {}) {
  const r = await veille({ log });
  const state = await lireEtat();
  const jour = jourParis();
  const midi = state.midi?.jour === jour ? state.midi : null;
  const enSuspens = Object.entries(state.arranges ?? {}).some(([pid, a]) => a.date === jour && !state.sent[pid]);
  const aFinir = !midi || (midi.pays_a_refaire ?? []).length || enSuspens || entrepots().some((e) => !midi.entrepots?.[e.cle]);
  if (!aFinir) return { veille: r, midi: 'déjà fait' };
  log('Le passage de midi n\'est pas fini : rattrapage.');
  return { veille: r, midi: await runOnce({ log }) };
}
