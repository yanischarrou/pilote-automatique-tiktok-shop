// Le `state` OAuth : tiré au hasard au départ, gardé dans un cookie signé, vérifié au retour.
// Sans lui, n'importe qui pourrait faire enregistrer SA boutique à la place de la nôtre
// en envoyant un lien de retour fabriqué (CSRF de connexion).
import crypto from 'node:crypto';
import { egal } from './http.js';

export const STATE_COOKIE = 'tts_oauth_state';
const DUREE_S = 10 * 60;

function signer(charge, secret) {
  return crypto.createHmac('sha256', secret).update(charge).digest('base64url');
}

/** Un nouveau state et la valeur du cookie qui le porte (state.expiration.signature). */
export function nouvelEtat(secret, maintenant = Date.now()) {
  if (!secret) throw new Error('CRON_SECRET manquant');
  const state = crypto.randomBytes(24).toString('base64url');
  const expire = Math.floor(maintenant / 1000) + DUREE_S;
  const charge = `${state}.${expire}`;
  return { state, valeur: `${charge}.${signer(charge, secret)}` };
}

/** Le state contenu dans le cookie, ou null s'il est absent, trafiqué ou expiré. */
export function lireEtat(valeur, secret, maintenant = Date.now()) {
  if (!valeur || !secret) return null;
  const parts = valeur.split('.');
  if (parts.length !== 3) return null;
  const [state, expire, signature] = parts;
  if (!egal(signature, signer(`${state}.${expire}`, secret))) return null;
  if (!(Number(expire) > Math.floor(maintenant / 1000))) return null;
  return state;
}

export function cookieEtat(valeur) {
  return `${STATE_COOKIE}=${valeur}; Path=/api/auth; Max-Age=${DUREE_S}; HttpOnly; Secure; SameSite=Lax`;
}

export function cookieEfface() {
  return `${STATE_COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
