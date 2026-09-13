# Checklist de sortie Android

1. Vérifier le nom définitif "La petite vadrouille" et l'identifiant de package technique `fr.lapetitevadrouille.metropole`.
2. [x] Héberger `privacy.html` en ligne : https://doudouds.github.io/la-petite-vadrouille/privacy.html
3. Installer Java 17+, Android SDK, platform tools et build tools.
4. [x] Générer la clé de signature Play App Signing (`.jks`) avec l'alias `mon-alias-unique`.
5. [x] Configurer `keystore.properties` avec les mots de passe et l'alias correct.
6. Capturer au moins 4 captures d'écran (Phone) depuis l'application réelle et vérifier les visuels générés (icon, feature graphic).
7. [x] Lancer `npm install` puis `npm run android:sync` / `npm run android:open`
8. [x] Générer le bundle release avec `npm run android:bundle`.
9. Tester le `.aab` sur un appareil ou via l'Internal Testing track.
10. Remplir les sections fiche magasin, confidentialité et Data Safety dans la Play Console.