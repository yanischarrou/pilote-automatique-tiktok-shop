// Client minimal TikTok Shop Open API (version 202309).
// Signature : HMAC-SHA256(app_secret, app_secret + path + {k}{v} triés + body + app_secret), en hex.
import crypto from 'node:crypto';
import { fetchReessai } from './reseau.js';

const API_HOST = 'https://open-api.tiktokglobalshop.com';
const AUTH_HOST = 'https://auth.tiktok-shops.com';

export class TikTokError extends Error {
  constructor(message, code, requestId) {
    super(message);
    this.code = code;
    this.requestId = requestId;
  }
}

export function makeClient({ appKey, appSecret, accessToken, shopCipher }) {
  if (!appKey || !appSecret) throw new Error('TTS_APP_KEY et TTS_APP_SECRET sont obligatoires');

  function sign(path, query, body) {
    const keys = Object.keys(query)
      .filter((k) => k !== 'sign' && k !== 'access_token')
      .sort();
    let s = path;
    for (const k of keys) if (!Array.isArray(query[k])) s += `${k}${query[k]}`;
    if (body) s += body;
    s = appSecret + s + appSecret;
    return crypto.createHmac('sha256', appSecret).update(s).digest('hex');
  }

  async function call(method, path, { query = {}, body, withCipher = true } = {}) {
    const q = { ...query, app_key: appKey, timestamp: Math.floor(Date.now() / 1000) };
    if (withCipher && shopCipher && !('shop_cipher' in q)) q.shop_cipher = shopCipher;
    const raw = body === undefined ? undefined : JSON.stringify(body);
    q.sign = sign(path, q, method === 'GET' ? undefined : raw);
    const url = `${API_HOST}${path}?${new URLSearchParams(q).toString()}`;
    const headers = { 'content-type': 'application/json' };
    if (accessToken) headers['x-tts-access-token'] = accessToken;
    // Une lecture se refait sur toute coupure ; une action (arranger l'expédition) seulement si elle n'est pas partie.
    const repetable = method === 'GET' || path.endsWith('/search');
    const res = await fetchReessai(url, { method, headers, body: method === 'GET' ? undefined : raw }, { repetable });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      throw new TikTokError(`Réponse non JSON (${res.status}) sur ${path}: ${text.slice(0, 200)}`, res.status);
    }
    if (json.code !== 0) {
      const err = new TikTokError(`${path} → ${json.code} ${json.message}`, json.code, json.request_id);
      err.refus = true; // TikTok a répondu et a dit non : rien n'a été fait
      throw err;
    }
    return json.data ?? {};
  }

  return {
    // Autorisation (pas de shop_cipher sur ces routes)
    getAuthorizedShops: () => call('GET', '/authorization/202309/shops', { withCipher: false }),

    // Commandes
    searchOrders: async ({ orderStatus, shippingType = 'TIKTOK' } = {}) => {
      const orders = [];
      let pageToken;
      do {
        const query = { page_size: 100, sort_field: 'create_time', sort_order: 'ASC' };
        if (pageToken) query.page_token = pageToken;
        const body = {};
        if (orderStatus) body.order_status = orderStatus;
        if (shippingType) body.shipping_type = shippingType;
        const data = await call('POST', '/order/202309/orders/search', { query, body });
        orders.push(...(data.orders ?? []));
        pageToken = data.next_page_token || undefined;
      } while (pageToken);
      return orders;
    },

    // Colis
    getPackage: (packageId) => call('GET', `/fulfillment/202309/packages/${packageId}`),
    shipPackage: (packageId, { handoverMethod = 'DROP_OFF', pickupSlot } = {}) => {
      const body = { handover_method: handoverMethod };
      if (pickupSlot) body.pickup_slot = pickupSlot;
      return call('POST', `/fulfillment/202309/packages/${packageId}/ship`, { body });
    },
    getHandoverTimeSlots: (packageId) => call('GET', `/fulfillment/202309/packages/${packageId}/handover_time_slots`),
    // Les entrepôts de la boutique (ID, nom) : chaque pays a les siens.
    getWarehouses: () => call('GET', '/logistics/202309/warehouses'),
    getShippingDocument: (packageId, { documentType = 'SHIPPING_LABEL_AND_PACKING_SLIP', documentSize = 'A6' } = {}) =>
      call('GET', `/fulfillment/202309/packages/${packageId}/shipping_documents`, {
        query: { document_type: documentType, document_size: documentSize, document_format: 'PDF' },
      }),
  };
}

// --- OAuth (hôte différent, pas de signature, succès = code 0 dans le corps) ---
async function authCall(path, params) {
  const url = `${AUTH_HOST}${path}?${new URLSearchParams(params).toString()}`;
  // Le renouvellement du jeton ne se refait que s'il n'est pas parti (un jeton peut ne servir qu'une fois).
  const res = await fetchReessai(url, {}, { repetable: false });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new TikTokError(`${path} → ${json.code} ${json.message ?? ''}`, json.code, json.request_id);
  return json.data;
}

export function authorizeUrl(appKey, state) {
  // Le Partner Center donne aussi un lien d'autorisation tout fait ; celui-ci est l'équivalent générique.
  return `https://services.tiktokshop.com/open/authorize?service_id=&state=${encodeURIComponent(state)}&app_key=${encodeURIComponent(appKey)}`;
}

export function exchangeCode({ appKey, appSecret, code }) {
  return authCall('/api/v2/token/get', { app_key: appKey, app_secret: appSecret, auth_code: code, grant_type: 'authorized_code' });
}

export function refreshToken({ appKey, appSecret, refreshToken }) {
  return authCall('/api/v2/token/refresh', { app_key: appKey, app_secret: appSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
}

// Normalise la réponse de token/get ou token/refresh en un objet stockable.
export function normalizeTokens(data) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // TikTok renvoie soit des timestamps absolus (access_token_expire_in) soit rien : on garde les deux lectures.
    access_expires_at: data.access_token_expire_in > now ? data.access_token_expire_in : now + (data.access_token_expire_in || 7 * 86400),
    refresh_expires_at: data.refresh_token_expire_in > now ? data.refresh_token_expire_in : now + (data.refresh_token_expire_in || 365 * 86400),
    open_id: data.open_id,
    seller_name: data.seller_name,
    seller_base_region: data.seller_base_region,
    user_type: data.user_type,
    updated_at: new Date().toISOString(),
  };
}
