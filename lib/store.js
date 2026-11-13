// Le petit stockage du robot (réglages, autorisation TikTok, mémoire des colis envoyés) : Vercel Blob en ligne, des
// fichiers locaux pour les tests. Tout est chiffré (AES-256-GCM) avec une clé tirée du mot de passe du robot
// (CRON_SECRET) : même si quelqu'un trouvait le fichier, il ne pourrait rien en lire.
//
// Le magasin Blob peut être « privé » (lecture avec le jeton seulement) ou « public » selon la façon dont Vercel l'a
// créé. En privé, on lit et on écrit le même fichier. En public, chaque écriture crée une nouvelle version au nom
// aléatoire, et on lit la plus récente par la liste du magasin (jamais par l'adresse publique, gardée en cache par le CDN).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN && (!!process.env.VERCEL || process.env.STOCKAGE === 'blob');
const LOCAL_DIR = process.env.PILOTE_DATA || path.resolve(process.cwd(), '.data');
const PREFIX = 'pilote/';
let modeBlob = null; // 'private' | 'public', découvert au premier appel

function cle() {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET manquant : le mot de passe du robot doit être défini dans Vercel.');
  return crypto.scryptSync(secret, 'pilote-automatique-tiktok-shop', 32);
}

export function chiffrer(texte) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cle(), iv);
  const corps = Buffer.concat([c.update(texte, 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: corps.toString('base64') });
}

export class StockageIlisible extends Error {}

export function dechiffrer(brut) {
  let o;
  try {
    o = JSON.parse(brut);
  } catch {
    throw new StockageIlisible('Données illisibles.');
  }
  if (!o || o.v !== 1) throw new StockageIlisible('Données illisibles.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', cle(), Buffer.from(o.iv, 'base64'));
    d.setAuthTag(Buffer.from(o.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new StockageIlisible("Données illisibles avec ce mot de passe (le mot de passe du robot a changé ?).");
  }
}

async function blob() {
  return import('@vercel/blob');
}

function erreurAcces(e) {
  return e?.name === 'BlobAccessError' || e?.constructor?.name === 'BlobAccessError' || /access/i.test(String(e?.message ?? ''));
}

async function lirePublic(nom) {
  const { list } = await blob();
  const { blobs } = await list({ prefix: `${PREFIX}${nom}.` });
  if (!blobs.length) return null;
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  const res = await fetch(`${blobs[0].url}?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Lecture de ${nom} impossible (${res.status})`);
  return res.text();
}

async function ecrirePublic(nom, contenu) {
  const { put, list, del } = await blob();
  const r = await put(`${PREFIX}${nom}.${Date.now()}.json`, contenu, {
    access: 'public',
    addRandomSuffix: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
  });
  // Ménage : on garde les 3 dernières versions.
  try {
    const { blobs } = await list({ prefix: `${PREFIX}${nom}.` });
    blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    const vieux = blobs.filter((b) => b.url !== r.url).slice(2).map((b) => b.url);
    if (vieux.length) await del(vieux);
  } catch {
    /* le ménage peut attendre */
  }
}

async function lireBlob(nom) {
  if (modeBlob !== 'public') {
    const { get } = await blob();
    try {
      const r = await get(PREFIX + nom, { access: 'private', useCache: false });
      modeBlob = 'private';
      if (!r || r.statusCode !== 200 || !r.stream) return null;
      return await new Response(r.stream).text();
    } catch (e) {
      if (e?.name === 'BlobNotFoundError' || e?.constructor?.name === 'BlobNotFoundError') return null;
      if (!erreurAcces(e)) throw e;
      modeBlob = 'public';
    }
  }
  return lirePublic(nom);
}

async function ecrireBlob(nom, contenu) {
  if (modeBlob !== 'public') {
    const { put } = await blob();
    try {
      await put(PREFIX + nom, contenu, {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControlMaxAge: 0,
      });
      modeBlob = 'private';
      return;
    } catch (e) {
      if (!erreurAcces(e)) throw e;
      modeBlob = 'public';
    }
  }
  await ecrirePublic(nom, contenu);
}

// Absent → fallback. Toute autre erreur remonte : mieux vaut un échec visible qu'une mémoire lue vide qui renverrait
// des bordereaux déjà envoyés.
export async function readJson(nom, fallback = null) {
  let brut;
  if (useBlob) brut = await lireBlob(nom);
  else {
    try {
      brut = await fs.readFile(path.join(LOCAL_DIR, nom), 'utf8');
    } catch {
      brut = null;
    }
  }
  if (brut == null || brut === '') return fallback;
  return JSON.parse(dechiffrer(brut));
}

export async function writeJson(nom, valeur) {
  const contenu = chiffrer(JSON.stringify(valeur));
  if (useBlob) return ecrireBlob(nom, contenu);
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  // Écriture atomique : un passage coupé ne laisse jamais un fichier à moitié écrit.
  const cible = path.join(LOCAL_DIR, nom);
  await fs.writeFile(`${cible}.tmp`, contenu, { mode: 0o600 });
  await fs.rename(`${cible}.tmp`, cible);
}

export function stockage() {
  if (!useBlob) return process.env.BLOB_READ_WRITE_TOKEN ? 'fichiers locaux' : 'aucun magasin Blob relié';
  return modeBlob ? `Vercel Blob (${modeBlob === 'private' ? 'privé' : 'public, chiffré'})` : 'Vercel Blob';
}

export const blobRelie = () => !!process.env.BLOB_READ_WRITE_TOKEN || !process.env.VERCEL;
