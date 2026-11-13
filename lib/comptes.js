// Plusieurs autorisations TikTok : un vendeur qui vend dans plusieurs pays peut avoir plusieurs comptes (par exemple la
// France d'un côté, les autres pays d'Europe de l'autre). Chaque compte a sa propre autorisation, donc son propre jeton.
// tokens.json garde la première en haut et les suivantes dans `autres_comptes`.

// La liste des comptes autorisés (le premier, puis les autres).
export function comptes(tokens) {
  if (!tokens?.refresh_token) return [];
  const { autres_comptes = [], ...principal } = tokens;
  return [principal, ...autres_comptes.filter((c) => c?.refresh_token)];
}

// L'inverse : la liste des comptes remise au format de tokens.json.
export function avecComptes(liste) {
  const [principal = {}, ...autres] = liste;
  return autres.length ? { ...principal, autres_comptes: autres } : { ...principal };
}

// Une nouvelle autorisation remplace celle qui couvre les mêmes boutiques ; sinon elle s'ajoute : autoriser un autre
// pays ne fait pas perdre le premier, même si les deux comptes ont le même titulaire (même open_id possible).
// Sans boutique renvoyée, elle remplace celle du même open_id.
export function fusionnerCompte(tokens, nouveau) {
  const liste = comptes(tokens);
  const ciphers = new Set((nouveau.shops ?? []).map((s) => s.cipher));
  const i = ciphers.size
    ? liste.findIndex((c) => (c.shops ?? []).some((s) => ciphers.has(s.cipher)))
    : liste.findIndex((c) => c.open_id && c.open_id === nouveau.open_id);
  if (i >= 0) liste[i] = { ...liste[i], ...nouveau };
  else liste.push(nouveau);
  return avecComptes(liste);
}

// Toutes les boutiques de tous les comptes, sans doublon.
export function toutesBoutiques(tokens) {
  const vues = new Map();
  for (const c of comptes(tokens)) for (const s of c.shops ?? []) if (s.cipher && !vues.has(s.cipher)) vues.set(s.cipher, s);
  return [...vues.values()];
}
