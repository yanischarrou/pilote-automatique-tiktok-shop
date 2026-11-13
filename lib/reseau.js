// Les nouvelles tentatives quand le réseau coupe : chaque appel du robot réessaie, avec des pauses croissantes
// (environ 1 min en tout).
//
// Deux cas :
// - une lecture (chercher les commandes, lire un colis, télécharger l'étiquette, une notification) se refait sans
//   risque : on réessaie sur toute coupure ;
// - une action (arranger l'expédition d'un colis) ne se refait que si la demande n'est sûrement jamais partie
//   (adresse introuvable, connexion refusée) : sinon TikTok l'a peut-être déjà reçue.

export const PAUSES_MS = [2000, 5000, 10000, 20000, 30000];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// La demande n'est jamais partie : la refaire ne peut rien doubler.
const JAMAIS_PARTIE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT']);
const STATUTS_PASSAGERS = new Set([429, 502, 503, 504]);

// Le code système d'une erreur de fetch (Node range la vraie cause dans `cause`, parfois dans une liste).
export function codeReseau(e) {
  const c = e?.cause;
  return c?.code ?? c?.errors?.find((x) => x?.code)?.code ?? e?.code ?? null;
}

export function estCoupure(e) {
  return (e instanceof TypeError && /fetch failed/i.test(e.message)) || typeof codeReseau(e) === 'string';
}

export function jamaisPartie(e) {
  return JAMAIS_PARTIE.has(codeReseau(e));
}

/**
 * fetch avec nouvelles tentatives.
 * @param {boolean} repetable  true pour une lecture ; false pour une action (seulement si la demande n'est pas partie)
 */
export async function fetchReessai(url, options = {}, { repetable = true, log } = {}) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, options);
      if (repetable && STATUTS_PASSAGERS.has(res.status) && i < PAUSES_MS.length) {
        log?.(`Réseau : ${new URL(url).host} répond ${res.status}, nouvel essai dans ${PAUSES_MS[i] / 1000} s.`);
        await pause(PAUSES_MS[i]);
        continue;
      }
      return res;
    } catch (e) {
      const ok = repetable ? estCoupure(e) : jamaisPartie(e);
      if (!ok || i >= PAUSES_MS.length) throw e;
      (log ?? console.log)(`Réseau coupé (${codeReseau(e) ?? e.message}) vers ${new URL(url).host}, nouvel essai dans ${PAUSES_MS[i] / 1000} s.`);
      await pause(PAUSES_MS[i]);
    }
  }
}

/** Refait `essai()` tant qu'il échoue sur une erreur passagère (`passagere(err)` vrai). */
export async function reessayer(essai, passagere, { quoi = 'appel', log } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await essai();
    } catch (e) {
      if (!passagere(e) || i >= PAUSES_MS.length) throw e;
      (log ?? console.log)(`${quoi} : échec passager (${e.message}), nouvel essai dans ${PAUSES_MS[i] / 1000} s.`);
      await pause(PAUSES_MS[i]);
    }
  }
}
