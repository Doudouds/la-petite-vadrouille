# Préparation Play Store

Ce dossier centralise les éléments de publication Android pour La petite vadrouille.

## Ce qui est déjà prêt

- projet web emballable via Capacitor
- page de confidentialité locale: `privacy.html`
- texte de fiche Play Store en français
- checklist de publication et de signature
- visuels générés dans `play-store/assets`

## Assets générés

- `play-store/assets/icon-512.png`
- `play-store/assets/feature-graphic.png`
- `play-store/assets/screenshots/home-list.png`
- `play-store/assets/screenshots/home-search.png`
- `play-store/assets/screenshots/route-planner.png`
- `play-store/assets/screenshots/route-summary.png`

## Ce qui reste externe au dépôt

- compte Google Play Console
- clé de signature de publication
- installation locale de Java et du SDK Android
- export des captures d'écran et du feature graphic aux dimensions Play Store

## Commandes utiles

- `npm install`
- `npm run android:assets`
- `npm run mobile:prepare`
- `npm run android:add`
- `npm run android:sync`
- `npm run android:doctor`
- `npm run android:bundle`

## Publication

1. Installer Java 17+ et Android SDK.
2. Générer ou renseigner la clé de signature.
3. Lancer `npm run android:bundle`.
4. Déposer le `.aab` dans la Play Console.
5. Renseigner la fiche magasin avec les fichiers du dossier `play-store`.