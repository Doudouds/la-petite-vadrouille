# Checklist de sortie Android

1. Vérifier le nom définitif "La petite vadrouille" et l'identifiant de package technique `fr.lapetitevadrouille.metropole`.
2. Mettre à jour le nom de l'application dans `privacy.html`, renseigner le contact éditeur et héberger le fichier en ligne (URL publique requise par Google).
3. Installer Java 17+, Android SDK, platform tools et build tools.
4. Générer la clé de signature Play App Signing.
5. Copier `android/keystore.properties.example` vers `android/keystore.properties` puis renseigner la signature release.
6. Capturer au moins 4 captures d'écran (Phone) depuis l'application réelle et vérifier les visuels générés (icon, feature graphic).
7. Lancer `npm install` puis `npm run android:sync` / `npm run android:open`
8. Générer le bundle release avec `npm run android:bundle`.
9. Tester le `.aab` sur un appareil ou via l'Internal Testing track.
10. Remplir les sections fiche magasin, confidentialité et Data Safety dans la Play Console.