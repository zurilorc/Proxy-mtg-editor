# Proxy Forge : générateur de proxies Magic

Web app (fonctionne sur iPhone, Android et ordinateur) pour créer des proxies Magic: The Gathering
avec **ta propre illustration**. Tout le reste de la carte (cadre, texte, symboles) reste identique à la vraie.

## Ce que fait l'app (version 1)

- **Recherche** par nom en français ou en anglais (autocomplétion), par filtres (couleurs, identité de
  commandant, type, rareté, valeur de mana, extension, texte), avec la syntaxe Scryfall avancée, ou au hasard.
- **Choix de la langue et de l'édition** pour chaque carte (FR, EN, DE, JA…). Par défaut, l'app choisit
  l'édition la plus adaptée à un proxy : scan HD, cadre moderne, bordure noire, pas de « full art ».
- **Ta photo à la place de l'illustration** : la zone d'art est détectée automatiquement, quel que soit le
  cadre. Tu peux ensuite glisser et pincer pour cadrer, et régler luminosité, contraste, saturation et
  « harmonie » (reprise des couleurs de l'illustration originale). La zone reste ajustable à la main.
- **Mélange IA**, quatre modes :
  - ta photo repeinte dans le style de l'illustration officielle ;
  - le sujet de ta photo intégré dans la scène originale ;
  - ta photo transformée en art fantasy ;
  - l'illustration originale réinterprétée selon tes instructions (ex. « style estampe japonaise »).

  Un seul bouton **Générer** : par défaut, l'image est créée **gratuitement** par un modèle ouvert hébergé
  sur Hugging Face, sans quitter l'app. Une clé Gemini ou OpenAI peut le remplacer dans les réglages.
  Si le quota gratuit du jour est épuisé, un secours passe par l'app Gemini.
- **Planche d'impression** avec quantités : PDF A4 (ou US Letter), 9 cartes par page au format réel
  63 × 88 mm, traits de coupe et espacement réglable.
- **Partage** de chaque carte en image PNG (feuille de partage du téléphone).
- **Import de decklist** (Moxfield, Archidekt, MTG Arena…), avec option pour ignorer les terrains de base.
- **Sauvegarde locale** : la planche et la carte en cours sont conservées sur l'appareil, même après fermeture.

## Mettre l'app en ligne (gratuit)

L'app est un simple site statique, sans serveur ni étape de build.

**Option A : GitHub Pages.** Gratuit pour un dépôt public ; pour un dépôt privé, GitHub Pages demande un
abonnement payant ([doc GitHub](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages)).

1. Rends le dépôt public : **Settings → General → Danger Zone → Change visibility**.
2. **Settings → Pages → Build and deployment → Source : Deploy from a branch**, choisis la branche qui
   contient l'app (par exemple `main`), dossier `/ (root)`, puis **Save**.
3. Une à deux minutes plus tard, l'app est disponible sur **https://zurilorc.github.io/Proxy-mtg-editor/**

**Option B : garder le dépôt privé.** Des hébergeurs comme Cloudflare Pages ou Netlify publient
gratuitement un site depuis un dépôt GitHub privé : connecte le dépôt, laisse la commande de build vide
et publie la racine du dépôt.

Sur iPhone : ouvre le lien dans Safari, puis **Partager → Sur l'écran d'accueil**. L'app s'ouvre ensuite
en plein écran comme une vraie application. Sur Android : menu ⋮ de Chrome → **Ajouter à l'écran d'accueil**.

> Si le site est public, n'importe qui peut ouvrir l'app, mais ta clé API éventuelle et tes cartes restent
> stockées uniquement sur ton téléphone.

## Générer l'illustration avec l'IA

Dans l'éditeur, ajoute ta photo, choisis un type de mélange, ajoute éventuellement des instructions, puis
touche **Générer**. L'image arrive directement dans l'app ; il ne reste qu'à la cadrer.

### Moteur gratuit : Hugging Face (par défaut)

L'app utilise un modèle d'édition d'image ouvert (Qwen-Image-Edit ou FLUX.1 Kontext) hébergé dans un
« Space » Hugging Face. Elle lit la description de son interface, et passe automatiquement à un autre modèle
si le premier ne répond pas.

- **Sans compte**, ça fonctionne, mais le quota est très réduit.
- **Avec un compte gratuit**, crée un jeton de type « Read » sur
  [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) et colle-le dans
  **Réglages → Jeton Hugging Face**. La doc indique un quota de calcul de quelques minutes par jour pour un
  compte gratuit ([doc ZeroGPU](https://huggingface.co/docs/hub/en/spaces-zerogpu)), soit quelques images.
- La génération prend souvent de 30 s à 2 min, file d'attente comprise.
- Tu peux imposer un Space précis dans **Réglages → Modèle (Space)**, par exemple
  `black-forest-labs/FLUX.1-Kontext-Dev`. Si le modèle n'accepte qu'une image, l'app envoie l'illustration
  et ta photo côte à côte.

Ta photo est envoyée au Space choisi pour la génération.

### Quota épuisé : secours par l'app Gemini

Sous le bouton **Générer**, le bloc « Quota épuisé ? Passer par l'app Gemini » prépare les images et les
consignes (copiées automatiquement) pour l'app Gemini gratuite. Tu génères dans Gemini, puis tu
réimportes le résultat. L'app Gemini a son propre quota quotidien
([aide Google](https://support.google.com/gemini/answer/14286560)).

### Clé Gemini ou OpenAI (facultatif)

Dans **Réglages → Moteur**, choisis Google Gemini ou OpenAI et colle ta clé
([Google AI Studio](https://aistudio.google.com/apikey), [OpenAI](https://platform.openai.com/api-keys)).
Sans facturation activée sur ton compte Google, rien ne peut t'être facturé, mais la génération d'images
ne semble pas incluse dans le quota gratuit de l'API
([forum Google](https://discuss.ai.google.dev/t/free-tier-api-image-generation/177423)). Avec facturation,
chaque image est payante ([tarifs Gemini](https://ai.google.dev/gemini-api/docs/pricing),
[tarifs OpenAI](https://openai.com/api/pricing/)).

**Confidentialité.** Clés et jetons restent dans le navigateur de ton appareil et ne sont envoyés qu'au
service concerné.

## Bon à savoir

- **Choisis une édition « classique »** (icône ⚠ = sans bordure ou full art). Sur ces versions, l'illustration
  passe sous le texte et le remplacement est imparfait.
- **Impression** : imprime toujours à **100 % / taille réelle**, jamais « ajuster à la page ». Un papier
  épais (200 à 250 g) glissé dans une pochette devant une carte commune donne un bon résultat.
- Le **nom de l'artiste original** reste imprimé sur la carte, puisqu'on garde le cadre officiel. La
  version 2 (carte reconstruite) permettra de le modifier.
- Données et images : [Scryfall](https://scryfall.com/docs/api). L'app espace ses requêtes d'au moins
  100 ms, comme Scryfall le demande.
- **Règles** : les proxies sont tolérés pour jouer entre amis, pas en tournoi officiel, et ne doivent jamais
  être vendus ([Fan Content Policy de Wizards](https://company.wizards.com/en/legal/fancontentpolicy)).
  L'option « Mention PROXY » (activée par défaut) les rend identifiables.

## Prochaine étape prévue : carte reconstruite

Redessiner entièrement la carte (cadre, texte, symboles de mana) à partir des données Scryfall. Ça permettra
des versions full art ou extended art avec ton illustration, ton nom comme artiste, et une traduction libre
du texte.

## Pour développer

Aucune dépendance ni étape de build : HTML, CSS et modules JavaScript.

```bash
python3 -m http.server 8765      # à la racine du dépôt, puis ouvrir http://localhost:8765
```

Tests de bout en bout (Scryfall et Gemini simulés, cartes synthétiques), avec Playwright et Pillow
installés et le serveur ci-dessus lancé :

```bash
python3 tests/gen_assets.py tests/assets      # génère les cartes et photos de test
node tests/e2e.js                             # BASE=http://localhost:8765/ par défaut
```

Structure :

- `js/scryfall.js` : client Scryfall (file d'attente, recherche, éditions par langue).
- `js/artbox.js` : détection de la zone d'illustration par corrélation (scan complet vs `art_crop`).
- `js/render.js` : rendu de la carte, retouches et harmonie des couleurs.
- `js/ai.js` : appels Gemini et OpenAI, choix automatique du modèle, consignes.
- `js/hf.js` : génération gratuite via un Space Hugging Face (lecture de l'interface, envoi, résultat).
- `js/pdf.js` : générateur PDF minimal (JPEG intégrés, 3 × 3 cartes, traits de coupe).
- `js/decklist.js` : lecture des decklists.
- `js/app.js` : interface.
