// Les alertes : un mail à toi (ton Gmail), seulement quand il y a un problème. Une alerte ne fait jamais échouer le
// passage.
import { sendMail } from './mail.js';
import { esc } from './http.js';
import { adressePublique } from './config.js';

export async function alerter({ titre, message, lignes = [] }) {
  try {
    const liste = lignes.length ? `<ul>${lignes.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
    const page = adressePublique();
    await sendMail({
      subject: `⚠️ ${titre}`,
      html: `<p>${esc(message)}</p>${liste}${page ? `<p><a href="${esc(page)}">Ouvrir la page du robot</a></p>` : ''}<p style="color:#888;font-size:12px">Alerte automatique de ton pilote automatique TikTok Shop</p>`,
      text: [message, ...lignes, page ? `Page du robot : ${page}` : ''].filter(Boolean).join('\n'),
    });
    return ['mail'];
  } catch (e) {
    console.error('Mail d’alerte impossible :', e.message);
    return [];
  }
}
