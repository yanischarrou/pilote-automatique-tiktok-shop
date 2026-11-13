# Pilote automatique TikTok Shop

Chaque jour vers midi, ce robot :

1. cherche tes commandes TikTok Shop **à expédier** (expédition par TikTok, avec l'étiquette TikTok) ;
2. arrange l'expédition de chaque colis (dépôt chez le transporteur, ou enlèvement) ;
3. récupère les bordereaux et les fiches de préparation, réunis dans **un seul PDF** ;
4. l'envoie **depuis ton Gmail** à ton entrepôt, avec la liste des colis. Tu es en copie.

Il tourne en ligne, sur Vercel (gratuit) : **ton ordinateur peut rester éteint**. Tu n'es prévenu qu'en cas de
problème (une commande annulée après son étiquette, un colis pas pris en charge, un passage raté).

## L'installer

Suis le tuto pas à pas, puis clique ici :

[![Déployer sur Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyanischarrou%2Fpilote-automatique-tiktok-shop&project-name=pilote-automatique&repository-name=pilote-automatique&env=CRON_SECRET&envDescription=Le%20mot%20de%20passe%20de%20ton%20robot%20%3A%20invente-le%2C%2012%20caract%C3%A8res%20minimum&stores=%5B%7B%22type%22%3A%22blob%22%7D%5D)

Ensuite, tout se règle sur la page de ton robot (`https://<ton-projet>.vercel.app`) : les 3 codes de ton app TikTok
Shop, ton Gmail, ton entrepôt, l'autorisation de ta boutique, le test à blanc, puis « Activer ».

## Bon à savoir

- **Expédition par TikTok seulement.** Les commandes « expédiées par le vendeur » (ton propre transporteur) sont
  ignorées.
- **L'heure.** Le passage a lieu entre midi et 13 h (entre 13 h et 14 h l'été), puis un second passage vers 17 h
  rattrape ce qui aurait raté. Sur le plan gratuit de Vercel, l'heure n'est pas précise à la minute.
- **Un seul mail par jour et par entrepôt.** Une commande arrivée après le passage part le lendemain.
- **Tes codes sont chiffrés** avec le mot de passe de ton robot. Si tu changes ce mot de passe, recolle tes réglages
  et autorise à nouveau ta boutique.
- **Tous les pays** : si ta boutique vend dans plusieurs pays d'Europe, autorise-les tous au moment de l'autorisation.

## Pour les curieux

`npm test` lance les tests sur une fausse boutique (rien ne sort de ton ordinateur).

Licence : usage personnel, pas de revente (voir `LICENSE`).
