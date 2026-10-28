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
- **Mélange IA** (avec ta clé Google Gemini ou OpenAI), quatre modes :
  - ta photo repeinte dans le style de l'illustration officielle ;
  - le sujet de ta photo intégré dans la scène originale ;
  - ta photo transformée en art fantasy ;
  - l'illustration originale réinterprétée selon tes instructions (ex. « style estampe japonaise »).
- **Planche d'impression** avec quantités : PDF A4 (ou US Letter), 9 cartes par page au format réel
  63 × 88 mm, traits de coupe et espacement réglable.
- **Partage** de chaque carte en image PNG (feuille de partage du téléphone).
- **Import de decklist** (Moxfield, Archidekt, MTG Arena…), avec option pour ignorer les terrains de base.
- **Sauvegarde locale** : la planche et la carte en cours sont conservées sur l'appareil, même après fermeture.

## Mettre l'app en ligne (5 minutes, gratuit)

L'app est un simple site statique. Le plus simple est de l'héberger avec GitHub Pages :

1. Sur GitHub, ouvre le dépôt **aivlis-code/Museum_application** puis **Settings → Pages**.
2. Dans **Build and deployment → Source**, choisis **Deploy from a branch**.
3. Dans **Branch**, choisis `claude/magic-proxy-generator-rgt9ef` (ou `master` une fois la branche
   fusionnée), dossier `/ (root)`, puis **Save**.
4. Une à deux minutes plus tard, l'app est disponible sur
   **https://aivlis-code.github.io/Museum_application/magic-proxy/**

Sur iPhone : ouvre ce lien dans Safari, puis **Partager → Sur l'écran d'accueil**. L'app s'ouvre ensuite
en plein écran comme une vraie application. Sur Android : menu ⋮ de Chrome → **Ajouter à l'écran d'accueil**.

> Le dépôt est public : n'importe qui peut ouvrir l'app, mais ta clé API et tes cartes restent stockées
> uniquement sur ton téléphone.

## Activer l'IA (Google Gemini recommandé)

1. Va sur [Google AI Studio](https://aistudio.google.com/apikey) et crée une clé API.
2. Dans l'app : **Réglages → Clé API**, colle la clé, puis **Tester la clé et charger les modèles**.
3. Laisse le modèle sur **Automatique** : l'app choisit le modèle d'image « flash » le plus récent
   disponible sur ton compte (rapide et moins cher). Tu peux en forcer un autre dans la liste.

OpenAI fonctionne aussi ([créer une clé](https://platform.openai.com/api-keys)) avec ses modèles `gpt-image`.

**Coûts.** Chaque image générée est facturée sur ton compte Google ou OpenAI. Vérifie les tarifs à jour sur
les pages officielles ([Gemini](https://ai.google.dev/gemini-api/docs/pricing),
[OpenAI](https://openai.com/api/pricing/)) : ils changent souvent et dépendent du modèle et de la résolution.
À titre indicatif, Google annonçait environ 0,039 $ par image pour Gemini 2.5 Flash Image à son lancement.
Les modèles « pro » coûtent nettement plus cher.

**Confidentialité.** La clé est enregistrée dans le navigateur de ton appareil et envoyée uniquement à
Google ou OpenAI, directement depuis le téléphone. Aucun serveur intermédiaire.

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
cd magic-proxy
python3 -m http.server 8765      # puis ouvrir http://localhost:8765
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
- `js/ai.js` : appels Gemini et OpenAI, choix automatique du modèle, prompts.
- `js/pdf.js` : générateur PDF minimal (JPEG intégrés, 3 × 3 cartes, traits de coupe).
- `js/decklist.js` : lecture des decklists.
- `js/app.js` : interface.
