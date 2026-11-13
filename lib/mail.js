// Les mails partent de ton Gmail, par SMTP, avec un mot de passe d'application Google (16 lettres, à créer sur
// myaccount.google.com/apppasswords). Tu es en copie de chaque mail à l'entrepôt : sa réponse arrive dans ta boîte.
import { env } from './config.js';
import { reessayer } from './reseau.js';

let transportDeTest = null;
export function _transportPourLesTests(t) {
  transportDeTest = t;
}

function listes(v) {
  return (Array.isArray(v) ? v : String(v || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

export function gmailPret() {
  return !!transportDeTest || !!(env('GMAIL_USER') && env('GMAIL_APP_PASSWORD'));
}

async function transport() {
  if (transportDeTest) return transportDeTest;
  const nodemailer = (await import('nodemailer')).default;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: env('GMAIL_USER'), pass: String(env('GMAIL_APP_PASSWORD')).replace(/\s+/g, '') },
  });
}

// Google refuse le mot de passe : on le dit en clair.
function erreurLisible(e) {
  const m = String(e?.message ?? e);
  if (/535|Username and Password not accepted|BadCredentials|Invalid login/i.test(m)) {
    return new Error("Google refuse l'adresse ou le mot de passe d'application. Recrée un mot de passe d'application et recolle-le.");
  }
  return e instanceof Error ? e : new Error(m);
}

// Vers un entrepôt (toi en copie), ou vers toi (sansCopie).
export async function envoyerGmail({ to, subject, html, text, attachments = [], sansCopie = false }) {
  if (!gmailPret()) throw new Error("Gmail pas encore réglé : colle ton adresse Gmail et ton mot de passe d'application sur la page du robot.");
  const user = env('GMAIL_USER');
  const nom = String(env('NOM', '') || '').trim();
  const dest = listes(to);
  const cc = sansCopie ? [] : [user].filter((a) => a && !dest.includes(a));
  const t = await transport();
  const info = await reessayer(
    () =>
      t.sendMail({
        from: nom ? `${nom} <${user}>` : user,
        to: dest,
        cc,
        subject,
        html,
        text,
        attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: 'application/pdf' })),
      }),
    // Un refus du mot de passe ne passera pas en réessayant ; une coupure, si.
    (e) => !/535|auth|credential|Invalid login/i.test(String(e?.message ?? '')),
    { quoi: `Mail « ${subject} »` },
  ).catch((e) => {
    throw erreurLisible(e);
  });
  return { id: info.messageId, via: 'gmail' };
}

// Pour toi : les alertes et les comptes rendus.
export async function sendMail({ subject, html, text, attachments = [] }) {
  return (await envoyerGmail({ to: env('GMAIL_USER'), subject, html, text, attachments, sansCopie: true })).id;
}
