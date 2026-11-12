# Préparation d’étape et suivi GPS — validation

Validation du 12 novembre 2026, application Android de développement installée sur le Pixel 10a connecté.

## Fonctionnement

- Accueil : trois GR classés par distance à vol d’oiseau jusqu’au tracé, après demande de localisation. L’index simplifié est réservé à cette recherche et conserve les coupures ; sa tolérance géométrique est de 75 m. La carte de France reste agrandie sur tous les écrans. « Tout voir » efface la région et la recherche, puis affiche les 93 sentiers ; il est désactivé lorsque tous sont déjà affichés.
- Approche : après localisation, « Itinéraire vers le sentier » calcule un trajet piéton vers le point géométriquement le plus proche du GR ouvert. BRouter utilise son profil `hiking-beta` et reçoit les coordonnées uniquement au clic. La ligne orange pointillée représente le trajet retourné, avec distance et durée estimées ; aucun segment droit n’est ajouté pour combler un accès manquant. Un décalage de plus de 50 m à une extrémité fait refuser le résultat. Google Maps reste accessible en cas d’échec. L’approche est effacée si le GPS est arrêté, si la position devient ancienne/imprécise, si l’application passe en arrière-plan ou si le départ s’est déplacé de plus de 100 m. Ce trajet nécessite Internet et reste une proposition fondée sur OpenStreetMap, pas une garantie d’accès sur le terrain.
- Préparation : départ, arrivée puis résumé. Sélection d’une ville, d’un point de la carte ou de la position actuelle proche du sentier. Une seule liste de choix à la fois ; le nombre de jours reste facultatif.
- Suivi : position avec cercle de précision, portion restante en orange, kilomètres mesurés le long du tracé sélectionné dans les deux sens, recentrage manuel et arrêt explicite. Le GPS s’arrête à la sortie de la page et se suspend en arrière-plan. Une perte temporaire du signal déclenche une nouvelle recherche.
- Le calcul est suspendu si la position a plus de 30 secondes, si sa précision dépasse 100 m, si elle s’éloigne de l’étape ou si une interruption connue précède l’arrivée. Aux croisements, la position précédente aide à éviter un saut vers une autre portion.
- Le geste Android ferme d’abord le préparateur ou la sélection sur carte, puis revient à l’accueil. Depuis l’accueil, il conserve l’application ouverte.

## Vérifications reproductibles

```text
npm ci
npm test
npm run routes:check
node scripts/build-nearby-index.cjs --check
npm run mobile:prepare
npm run test:ui
npx cap sync android
node scripts/run-gradle.mjs assembleDebug
```

Les tests de navigateur utilisent Edge en mode headless et des réponses locales. Le test d’interactions accepte aussi `BROWSER_CHANNEL`. Ils ne téléchargent pas les tuiles des serveurs cartographiques et simulent les positions GPS. Les 19 tests Node comprennent une comparaison des projections sur chacun des 93 GR, les distances cumulées, les coupures, le sens inverse, les croisements, les autorisations, le pont Android sans bundler et la validation des itinéraires d’approche.

Mise en page contrôlée à 320×568, 390×844, 720×480, 844×390, 1024×768 et 1440×900. Scénarios interactifs : carte de France toujours visible, réinitialisation des deux filtres, refus/réessai/effacement de localisation, étapes guidées, choix sur carte et annulation, départ GPS, progression, arrivée, signal périmé/imprécis, hors-tracé, pause/reprise/arrêt, reprise après perte de signal, itinéraire orange jusqu’au point le plus proche, absence de requête avant clic, annulation d’un calcul, déplacement du départ, panne réseau et lien de repli.

Sur le Pixel : installation sans effacement des données, demande d’autorisation native, résultats de proximité avec une vraie position, affichage du GPS sur la carte, geste latéral réel du préparateur vers la carte puis l’accueil, bouton Retour à l’accueil, pause en arrière-plan et arrêt. La progression en marchant et les cas limites sont simulés ; ce test sur téléphone n’est pas une validation terrain de chaque sentier.

Complément sur le Pixel : carte de France agrandie et remise à zéro des deux filtres vérifiées. Depuis une position publique simulée à Paris, un appel réel à BRouter a affiché une approche de 2,7 km (33 minutes estimées) jusqu’au GR75. Le tracé orange, son effacement et l’arrêt du GPS ont été contrôlés ; le téléphone a ensuite été remis à l’accueil, sans simulation active.

## Performances et limites des données

L’index de proximité représente 1 347 626 octets contre 29 386 089 octets pour les 93 caches détaillés (95,4 % de données en moins). Il se charge uniquement après la demande de localisation. Les mises à jour GPS utilisent un index de boîtes englobantes ; les tracés ne sont plus recopiés dans localStorage sur Android et le dénivelé est chargé à l’ouverture du préparateur. La surbrillance n’est recalculée qu’en cas de modification de l’étape.

L’[audit de toutes les randonnées](route-audit.md) relève 97 raccords de plus de 30 m sur 43 GR, sans erreur structurelle des caches. Ces interruptions sont signalées par des repères sur la carte et dans le résumé ; elles ne deviennent pas des liaisons artificielles. Les distances affichées dans le résumé excluent les passages manquants. Les corrections définitives des raccords exigent une géométrie documentée du sentier. Aucun contrôle géométrique ne certifie l’accessibilité réelle ou le balisage officiel.

Les fonds de carte dépendent de la connexion et de leur cache existant ; cette version n’ajoute pas un téléchargement de cartes hors ligne.
