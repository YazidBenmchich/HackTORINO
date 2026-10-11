# HelioScan — Inspection d'une centrale solaire par drone autonome

Simulation web en **Three.js** : un quadricoptère autonome inspecte une centrale photovoltaïque de **3 zones de 20 panneaux** (60 panneaux). Chaque panneau est analysé **de très près**, en longeant ses côtés. Un retour caméra embarqué s'affiche en direct (RGB ou thermique), avec un HUD, une vue de synthèse par zone et une interface de supervision. Un petit serveur Node.js permet aussi de piloter le drone depuis l'extérieur de la page, via une API REST.

Tout est généré de façon procédurale (drone, panneaux, textures, ciel) : **aucun asset externe**, l'application fonctionne hors ligne une fois les dépendances installées.

---

## Installation et lancement

Prérequis : **Node.js 20.19+ ou 22.12+** (exigence de Vite 8).

```bash
npm install
npm run dev
```

Puis ouvrir **http://localhost:3000**.

`npm run dev` démarre le serveur Express, qui sert l'application (Vite en middleware, rechargement à chaud), ouvre la WebSocket et expose l'API REST, le tout sur un seul port.

| Commande        | Rôle                                                              |
|-----------------|-------------------------------------------------------------------|
| `npm run dev`   | Développement : serveur + Vite + API sur le port 3000             |
| `npm run build` | Build de production dans `dist/`                                   |
| `npm start`     | Sert le build de production (`dist/`) avec l'API                   |

Pour changer de port : `PORT=8080 npm run dev` (PowerShell : `$env:PORT=8080; npm run dev`).

---

## La centrale

- **3 zones** (A, B, C) alignées d'ouest en est. Chacune compte **4 rangées de 5 panneaux** sur un terrain gravillonné marqué au sol (« ZONE A »…).
- Les panneaux sont identifiés par **zone + numéro** : `A01` à `A20`, `B01` à `B20`, `C01` à `C20`. La numérotation va du nord-ouest au sud-est de chaque zone.
- La plateforme de décollage est au sud de la zone B.
- Le décor a été volontairement épuré : sol uni, sans herbe, arbres ni clôture.

---

## Contrôles

### Souris (vue principale)
| Action                          | Effet                                                       |
|---------------------------------|-------------------------------------------------------------|
| Clic sur un panneau             | Le drone va l'inspecter (analyse rapprochée, mode manuel)    |
| Clic sur une zone (sol, étiquette) | **Survol de zone** : le drone va se placer à 22 m au-dessus de la zone, caméra à la verticale, pour une vue d'ensemble de ce qui s'y passe (aucune analyse) |
| `Maj` + clic sur le sol         | Le drone va survoler ce point puis reste en stationnaire     |
| Clic sur le sol hors des zones  | Idem : survol du point                                       |
| Glisser (clic gauche)           | Orbiter autour de la scène                                   |
| Clic droit + glisser            | Déplacer la vue                                              |
| Molette                         | Zoom                                                         |
| Survol d'un panneau / d'une zone | Infobulle : identifiant, état, progression                  |

### Clavier
| Touche          | Effet                                                   |
|-----------------|---------------------------------------------------------|
| `1` / `2` / `3` | Survol de la zone A / B / C                             |
| `Espace`        | Pause / reprise                                         |
| `F`             | Mode « suivre le drone »                                |
| `V`             | Caméra principale en vue d'ensemble (ferme la fiche de zone) |
| `T`             | Retour caméra : RGB ↔ thermique                         |
| `C`             | Agrandir / réduire le retour caméra                     |
| `Échap`         | Quitter le plein écran caméra, sinon fermer la fiche de zone |

### Interface
- **Barre d'outils** (en haut à gauche) : suivre le drone, vue d'ensemble, étiquettes des panneaux, vitesse de simulation ×1 / ×2 / ×4 / ×8, compteur d'images par seconde.
- **Panneau latéral** :
  - état de la mission ;
  - boutons *Démarrer la mission* (toute la centrale), *Pause / Reprendre*, *Retour base*, *Réinitialiser* (nouveaux défauts aléatoires) ;
  - progression globale (X / 60) et télémétrie ;
  - **onglets de zones** (progression, défauts) qui filtrent la liste cliquable des 20 panneaux de la zone ;
  - journal d'événements horodaté.
- **Fiche de survol de zone** (en haut à droite, après un clic sur une zone) : uniquement ce qui se passe, sans information sur les défauts. Elle montre la progression, une **mini-carte** des 20 panneaux (non analysé / en cours / analysé) avec la position du drone en direct, l'activité du drone (« en route pour le survol », « en survol de la zone à 22 m », « analyse B12 (45 %) »…) et un bouton **Inspecter cette zone**. Elle est masquée quand le retour caméra est en plein écran.
- **Retour caméra** (en bas à gauche, ~30 % de la largeur) : bouton *Thermique* et bouton d'agrandissement plein écran.

---

## Fonctionnement

### Mission
Machine à états : `IDLE → TAKEOFF → TRANSIT → POSITIONING → SCANNING → (panneau suivant) → RETURN → LANDING`
(plus `HOVER`, le vol stationnaire en mode manuel, et `OVERVIEW`, le survol d'une zone).

- **Mission complète** : décollage, puis la zone la plus proche, parcourue en **serpentin** rangée par rangée, et ainsi de suite pour les autres zones. Retour et atterrissage à la fin.
- **Mission de zone** : le bouton *Inspecter cette zone* (ou l'API) limite la mission aux panneaux restants d'une zone.
- Relancer une mission n'inspecte que les panneaux restants. Si tout a été analysé, une nouvelle passe complète démarre.
- Une commande manuelle (clic, liste, API) **interrompt** la mission en cours.
- **Pause** et **Retour base** fonctionnent à tout moment : le drone freine en douceur et tient sa position.

Durées indicatives à ×1 : environ 15 s par panneau, soit environ 5 min par zone et 15 min pour la centrale entière. Les vitesses ×4 et ×8 servent à visualiser une mission complète rapidement.

### Analyse rapprochée d'un panneau
1. **Transit** au-dessus du coin de départ (altitude de croisière, ou saut court à faible hauteur entre panneaux voisins).
2. **Positionnement** : descente jusqu'à **~0,65 m du verre**, cap au nord, gimbal incliné à −60°. La caméra vise donc **perpendiculairement** à la surface inclinée à 30°, l'angle idéal en thermographie. Puis stabilisation.
3. **Balayage en U le long des côtés** : passe lente (0,7 m/s) le long du **bord haut**, descente le long du petit côté, puis passe le long du **bord bas**. Le drone ralentit et s'arrête en douceur à chaque angle. L'empreinte de la caméra (rectangle lumineux) et la pyramide de visée suivent le drone sur le panneau.
4. Le panneau passe à `OK` (contour vert) ou `défaut` (contour rouge pulsant), puis le drone remonte vers le panneau suivant.

**Panneau défectueux** : un point d'arrêt est inséré dans la passe (haute ou basse) la plus proche du défaut. Le drone s'y place caméra centrée sur le défaut et **reste 5 s de plus** devant lui (`defectHoldTime`). Le HUD affiche alors « ANOMALIE REPÉRÉE · EXAMEN n s » et le journal note l'examen prolongé. Le balayage reprend ensuite.

Dans le flux caméra, le HUD indique la progression et la portion en cours (*PASSE HAUTE*, *CÔTÉ*, *VERS LE DÉFAUT*, *PASSE BASSE*). Un repère **ΔT** signale le défaut dès qu'il entre dans le champ.

### Défauts
À chaque réinitialisation, **3 ou 4 panneaux par zone** reçoivent un défaut caché, tiré au hasard : *point chaud*, *cellule fissurée* ou *salissure*. Le défaut est visible sur le panneau (brûlure, fissures, poussière et fientes) et apparaît comme une zone chaude en vue thermique. Il n'est révélé dans l'interface qu'après analyse.

### Animation du drone (sans physique)
- Profil de vitesse « freinage » (√(2·a·d)) et **accélération lissée** (jerk limité) : démarrages et arrêts sans à-coups.
- **Inclinaison** (tangage / roulis) proportionnelle à l'accélération, amortie par un ressort, avec un retour progressif à l'horizontale.
- **Lacet progressif** vers la cible sur les longs trajets ; déplacement latéral à cap constant pendant l'analyse et entre panneaux voisins.
- **Remontée de sécurité** : près des panneaux, le drone remonte presque à la verticale avant tout déplacement latéral.
- **Flottement** en stationnaire, **hélices** à régime variable avec disque de flou, **LED** rouge / vert clignotantes, **gimbal stabilisé**.

### Retour caméra
- Une seconde caméra Three.js est attachée à la nacelle. Elle est rendue dans un `WebGLRenderTarget` (HDR, MSAA ×4), puis composée en incrustation avec tone mapping ACES, vignettage et grain.
- **HUD** épuré : réticule, bande de cap, altitude, vitesses, gimbal, batterie, mode, cible, état, horodatage, « ● REC ». Le seul cadre affiché est le **rectangle bleu qui localise le panneau** analysé, borné à l'écran (en vue rapprochée, le panneau remplit l'image), avec une étiquette texte.
- **Vue thermique** : les matériaux sont substitués par des matériaux « chaleur », puis un shader de fausses couleurs (bleu → cyan → jaune → orange → rouge) est appliqué. Les points chauds y sont nettement visibles et une échelle de température est affichée.

---

## API REST

Le serveur relaie chaque commande à la page ouverte via WebSocket et attend son acquittement (3 s maximum). La page renvoie son état au serveur **5 fois par seconde**.

> Une page de simulation doit être ouverte dans le navigateur, sinon l'API répond `503`.

| Méthode | Route                  | Corps                              | Effet                                              |
|---------|------------------------|------------------------------------|----------------------------------------------------|
| POST    | `/api/goto`            | `{ "x": number, "z": number }`     | Survoler un point (mètres, \|x\|, \|z\| ≤ 140)      |
| POST    | `/api/goto`            | `{ "panel": "B07" }`               | Inspecter un panneau (A01 à C20)                   |
| POST    | `/api/mission/start`   | — ou `{ "zone": "B" }`             | Mission complète, ou limitée à une zone            |
| POST    | `/api/mission/pause`   | —                                  | Mettre en pause                                    |
| POST    | `/api/mission/resume`  | —                                  | Reprendre après une pause                          |
| POST    | `/api/mission/reset`   | —                                  | Réinitialiser (nouveaux défauts)                   |
| POST    | `/api/return`          | —                                  | Retour à la base et atterrissage                   |
| POST    | `/api/zone/:id/view`   | —                                  | Envoyer le drone survoler une zone (A, B ou C)     |
| GET     | `/api/status`          | —                                  | État du drone, de la mission, des zones et panneaux |

Codes de retour : `200` OK, `400` requête invalide, `404` panneau, zone ou route inconnus, `409` commande refusée dans l'état courant (par exemple une pause alors que le drone est au sol), `503` aucune page connectée.

Repère : +X = est, −Z = nord, +Z = sud. Les centres des zones sont en x = −24 (A), 0 (B) et +24 (C), avec z = 0. La plateforme est en (0, 17).

### Exemples `curl` (bash, macOS, Linux, Git Bash)

```bash
# Inspecter le panneau B07
curl -X POST http://localhost:3000/api/goto -H "Content-Type: application/json" -d '{"panel":"B07"}'

# Survoler le point x = 5, z = -15
curl -X POST http://localhost:3000/api/goto -H "Content-Type: application/json" -d '{"x":5,"z":-15}'

# Mission complète, ou seulement la zone C
curl -X POST http://localhost:3000/api/mission/start
curl -X POST http://localhost:3000/api/mission/start -H "Content-Type: application/json" -d '{"zone":"C"}'

curl -X POST http://localhost:3000/api/mission/pause
curl -X POST http://localhost:3000/api/mission/resume
curl -X POST http://localhost:3000/api/return

# Envoyer le drone survoler la zone A (vue d'ensemble)
curl -X POST http://localhost:3000/api/zone/A/view

# État
curl http://localhost:3000/api/status
```

### Exemples Windows PowerShell

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/api/goto -ContentType 'application/json' -Body '{"panel":"B07"}'
Invoke-RestMethod -Method Post http://localhost:3000/api/mission/start -ContentType 'application/json' -Body '{"zone":"C"}'
Invoke-RestMethod http://localhost:3000/api/status | ConvertTo-Json -Depth 5
```

(Avec `curl.exe` sous PowerShell, échappez les guillemets du JSON : `-d '{\"panel\":\"B07\"}'`.)

### Exemple de réponse `GET /api/status`

```json
{
  "connected": true,
  "updatedAt": "2026-10-10T13:15:02.789Z",
  "ageMs": 84,
  "drone": {
    "position": { "x": -4.1, "y": 1.45, "z": 3.0 },
    "altitude": 1.3, "speed": 0.7, "verticalSpeed": 0,
    "heading": 0, "battery": 91.4, "gimbalPitch": -60
  },
  "mission": {
    "state": "SCANNING", "label": "Analyse", "mode": "mission", "paused": false,
    "zone": "B", "currentPanel": "B12", "scanProgress": 0.45,
    "queue": ["B13", "B14", "B15", "..."],
    "analyzed": 11, "total": 60, "defects": 2, "elapsed": 168.3
  },
  "zones": [
    { "id": "A", "name": "Zone A", "ok": 0, "defect": 0, "done": 0, "total": 20 },
    { "id": "B", "name": "Zone B", "ok": 9, "defect": 2, "done": 11, "total": 20 },
    { "id": "C", "name": "Zone C", "ok": 0, "defect": 0, "done": 0, "total": 20 }
  ],
  "panels": [
    { "id": "B01", "zone": "B", "row": 1, "col": 1, "x": -6, "z": -8.04, "status": "ok", "defect": null },
    { "id": "B04", "zone": "B", "row": 1, "col": 4, "x": 3, "z": -8.04, "status": "defect", "defect": "salissure" },
    { "id": "B12", "zone": "B", "row": 3, "col": 2, "x": -3, "z": 2.68, "status": "scanning", "defect": null }
  ],
  "view": { "thermal": false, "cameraFullscreen": false, "follow": false, "selectedZone": "B", "simSpeed": 1, "fps": 60 }
}
```

`status` vaut `pending` (non analysé), `scanning` (en cours), `ok` ou `defect`. Le champ `defect` n'est renseigné qu'après analyse. `mission.zone` vaut `null` pour une mission sur toute la centrale.

---

## Console opérateur (société d'exploitation)

**http://localhost:3000/console.html** (ou `/console`) : l'écran de l'opérateur de la société qui surveille la centrale. La simulation 3D joue le rôle du **terrain** (la centrale et le drone réels) ; la console est le poste de supervision à distance.

> Ouvrez d'abord la simulation (`http://localhost:3000`) dans une **fenêtre à part**, puis la console. La simulation continue de tourner même si son onglet est masqué (cadence de secours à 20 Hz), mais elle doit rester ouverte.

### Ce que fait la console
- **Supervision** : puissance de la centrale (mesurée et attendue, 15 min), ratio de performance, irradiance, vent (vol autorisé ou non), carte des 60 modules dont la **luminosité suit le courant mesuré** : un module qui décroche s'assombrit. Marques d'inspection (conforme, non inspecté, défaut), drone, trace et route en violet. Retour vidéo du drone, commandes rapides, alertes actives, activité.
- **Pilotage** : vidéo plein cadre, sortie de base (**Décoller**), **Atterrir ici**, **Pause**, **Retour base**, **Prendre la main** (pilotage manuel), caméra visible / thermique, inclinaison de la nacelle, lancement d'une inspection (modules ou structures, centrale ou zone). Mini-carte : clic sur le sol = survol du point, clic sur un module = inspection.
- **Panneaux** : courant, attendu, écart, puissance et état d'inspection des 60 modules (tri, filtre par zone ou « en alerte »), fiche détaillée de chaque module (courbe 5 min).
- **Alertes** : alertes actives et historique, chaîne *Détection → Drone envoyé → Analyse → Diagnostic → Ordre de travail*, courbe du courant avec le début de l'alerte, **photo prise par le drone** pendant l'examen, historique horodaté ; journal d'exploitation complet.
- **Interventions** : ordres de travail créés automatiquement après chaque diagnostic (action recommandée, priorité, perte estimée, photo), affectation à une équipe, planification, clôture. Clôturer un ordre **remet le module en état** (courant normal, défaut effacé dans la simulation).
- **Notifications** : bandeaux à l'écran, signal sonore (coupable), notifications du navigateur quand la console est en arrière-plan, compteur dans le titre de l'onglet.

### Pilotage manuel
*Prendre la main* fait passer le drone en mode `MANUAL` (au sol : décollage puis prise en main). Commandes :
- clavier (touches physiques, AZERTY comme QWERTY) : `Z Q S D` / `W A S D` déplacement, `↑ ↓` altitude, `← →` rotation ;
- manches virtuels à l'écran (souris ou tactile, mode 2) ;
- manette de jeu (API Gamepad, mode 2).

Les consignes partent à 20 Hz. Sans consigne pendant 0,6 s (liaison coupée, touche relâchée), le drone freine et tient sa position (homme mort). Barrière virtuelle : plafond 40 m, plancher 2,2 m au-dessus des zones de panneaux (0,8 m ailleurs), périmètre de ±120 m. *Atterrir ici* est refusé au-dessus des panneaux. Posé hors base, *Retour base* redécolle puis rentre.

### Supervision électrique et envoi autonome du drone
Le serveur simule la télémétrie de chaque module (courant, tension, puissance), l'irradiance de chaque zone (capteur de référence), la température et le vent, avec des passages nuageux. La détection compare le **courant mesuré au courant attendu pour l'irradiance de la zone** : un nuage ne déclenche rien, seul un module qui décroche est signalé.

| Écart au courant attendu | Durée | Effet |
|---|---|---|
| ≤ −6 % | 4 s | Alerte *surveillance* |
| ≤ −15 % | 3 s | Escalade en *critique* |
| > −3 % | 15 s | Alerte clôturée (retour à la normale) |

Les défauts tirés par la simulation (point chaud, cellule fissurée, salissure) se déclarent électriquement un par un (le premier ~25 s après la connexion, puis toutes les 70 à 120 s), avec une baisse progressive. Dès qu'une alerte s'ouvre, **le drone part de lui-même** (si *Envoi auto du drone* est activé) : décollage, analyse rapprochée du module, photo de l'anomalie, diagnostic, ordre de travail, puis retour à la base s'il n'y a plus rien à diagnostiquer. Une alerte critique interrompt une mission d'inspection en cours ; une alerte attend si l'opérateur pilote, et un envoi interrompu est relancé quand le drone se libère.

Par défaut, **aucune alerte automatique** : les défauts spontanés sont désactivés (activables dans la vue *Scénarios* ou le menu *Démo*). C'est l'équipe qui crée les incidents.

### Scénarios de démo (vue *Scénarios*)
Chaque scénario pose un incident **dans la simulation** (défaut visible sur le module, pied endommagé, objet au sol, météo), puis il est détecté comme il le serait sur le terrain. Le drone part de lui-même (envoi automatique), fait l'inspection adaptée, prend une photo, et un ordre de travail est créé. Clôturer l'ordre de travail (ou *Réparer* dans la vue Scénarios) remet tout en état, y compris dans la 3D.

| Famille | Scénario | Détecté par | Le drone | Constat |
|---|---|---|---|---|
| Module | Point chaud | courant du module (−35 %) | analyse rapprochée | point chaud (thermique) |
| Module | Cellule fissurée | courant (−21 %) | analyse rapprochée | cellule fissurée |
| Module | Salissure, fientes | courant (−12 %) | analyse rapprochée | salissure → nettoyage |
| Module | Défaut électrique | courant (−30 %) | analyse rapprochée | rien de visible → contrôle électrique |
| Structure | Inclinaison anormale | inclinomètre de table (+2,6°) | vol bas, arrêt devant les 4 pieds | pied déformé |
| Structure | Tassement de fondation | inclinomètre (dérive lente) | inspection des pieds | fondation fissurée |
| Structure | Corrosion | station météo (humidité cumulée) | inspection des pieds | pied corrodé |
| Structure | Coup de vent (zone) | anémomètre (rafale 96 km/h) | **attend la fin des rafales** (vol interdit > 36 km/h), puis inspecte 3 modules de bordure | pied déformé |
| Terrain | Fortes pluies (zone) | pluviomètre (48 mm/h) | survol du sol, caméra verticale | ravinement dans une allée |
| Terrain | Ombrage par la végétation (zone) | courants de la rangée sud (−8 à −11 %) | survol du pied de rangée | végétation envahissante |
| Terrain | Défaut d'isolement (zone) | onduleur (Riso 180 kΩ) | survol du sol | eau stagnante |
| Terrain | Affaissement du sol (zone) | inclinomètres de plusieurs tables | survol du sol | affaissement dans une allée |

Cible : un module précis ou au hasard (modules et structures), une zone précise ou au hasard (coup de vent, terrain). Plusieurs incidents peuvent être en cours : le drone les traite l'un après l'autre, les critiques d'abord. Réglages de démo : *Centrale saine* (aucun défaut caché, seuls vos incidents existent), *Tirage aléatoire*, vitesse de simulation, envoi automatique.

**Pourquoi inspecter les structures** (pieds, poutres, fondations) : dérive d'un inclinomètre (pied flambé, fondation qui s'enfonce), coup de vent au-delà du seuil de conception, exposition corrosive (humidité, brouillard salin), choc d'un engin, gel-dégel. **Pourquoi inspecter le terrain** : ravinement après de fortes pluies (fondations déchaussées), eau stagnante (défaut d'isolement à l'onduleur), végétation (ombrage, risque d'incendie), affaissement ou tassement du sol, terriers d'animaux.

### Fluidité
- **Retour vidéo** : la simulation redessine l'image du drone dans une petite cible hors écran, lit ses pixels sans attendre le GPU (lecture asynchrone WebGL 2), et l'encodage JPEG se fait dans un Web Worker. Résultat : **20 i/s** dans la console (contre ~11 avant), sans ralentir la 3D, y compris quand la fenêtre de simulation est en arrière-plan.
- **Qualité adaptative** de la 3D : si la simulation descend sous 50 i/s, la résolution de rendu baisse par paliers (×1,75 → ×1,5 → ×1,25 → ×1 → ×0,8), puis la carte d'ombres n'est plus recalculée qu'une image sur deux ; elle remonte quand la marge revient. Le palier courant s'affiche au survol du compteur d'images.
- La simulation continue de tourner (20 Hz) et d'envoyer son état quand son onglet est masqué.

### API ajoutée

| Méthode | Route | Corps | Effet |
|---|---|---|---|
| POST | `/api/takeoff` | — ou `{ "pilot": true }` | Sortie de base (vol stationnaire, ou pilotage manuel) |
| POST | `/api/land` | — | Atterrissage sur place (hors panneaux) |
| POST | `/api/pilot` | `{ "on": true \| false }` | Prise en main / fin du pilotage manuel |
| POST | `/api/gimbal` | `{ "pitch": -45 }` | Nacelle en pilotage manuel (−90 à 0°) |
| POST | `/api/thermal` | `{ "on": true \| false }` | Caméra thermique / visible |
| GET | `/api/scada` | — | Télémétrie électrique, météo, zones |
| GET | `/api/alerts` | — | Alertes (actives et historique) |
| POST | `/api/alerts/:id/ack` · `/dispatch` · `/close` | — | Prise en compte, envoi du drone, clôture |
| GET | `/api/alerts/:id/snapshot.jpg` | — | Photo du drone pendant le diagnostic |
| GET | `/api/workorders` | — | Ordres de travail |
| POST | `/api/workorders/:id` | `{ "status": "planned" \| "done", "assignee": "…" }` | Planifier, affecter, clôturer |
| GET | `/api/frame.jpg` | — | Dernière image du retour vidéo |
| POST | `/api/demo/fault` | — ou `{ "panel": "B07" }` | Faire décrocher un module maintenant |
| GET | `/api/demo/scenarios` | — | Catalogue des scénarios |
| POST | `/api/demo/scenario` | `{ "id": "tilt", "panel": "B07" }` ou `{ "id": "rain", "zone": "A" }` | Déclencher un incident simulé |
| GET | `/api/demo/incidents` | — | Incidents simulés et leur état |
| POST | `/api/demo/incidents/:id/repair` · `/api/demo/repair-all` | — | Réparer un incident, ou tous |
| POST | `/api/mission/reset` | — ou `{ "clean": true }` | Réinitialiser (centrale saine avec `clean`) |

La console utilise sa propre WebSocket (`/console-ws`) : état du drone (5 Hz), télémétrie électrique (1 Hz), alertes, ordres de travail, journal, et images JPEG du retour vidéo (≈ 12 i/s, produites seulement quand une console regarde). Les manches de pilotage passent par la même liaison, sans acquittement.

---

## Prototype mobile

Les pages du prototype téléphone (mires à imprimer, scanner) ne font pas partie de ce dossier. Le serveur garde la route qui permet à un téléphone de remonter un résultat dans le journal de la simulation :

| Route | Corps | Effet |
|---|---|---|
| `POST /api/mobile/report` | `{ "panel": "B07", "kind": "defect" | "ok" | "complete", "defects": [...] }` | Relayé au journal de la simulation |

---

## Configuration

Tous les paramètres sont regroupés dans [`src/shared/config.js`](../src/shared/config.js) :

- **Centrale** : liste des zones (identifiant, nom, centre), rangées et colonnes par zone, dimensions et inclinaison des panneaux, espacements, nombre de défauts par zone.
- **Drone** : altitude de transit, hauteur des sauts courts, hauteur de sécurité, vitesses et accélérations, lissage, lacet, inclinaison maximale.
- **Analyse rapprochée** : distance caméra ↔ verre (`scanStandoff`), vitesse le long du panneau (`scanSpeed`), décalage des deux passes (`scanEdgeOffset`), dépassement aux extrémités (`scanOvershoot`), durée de stabilisation, examen prolongé devant un défaut (`defectHoldTime`, 5 s).
- **Survol de zone** : altitude (`zoneOverviewAltitude`, 22 m).
- **Caméra** : champ de vision, taille de l'incrustation, angles du gimbal au sol et en transit. L'angle d'analyse est déduit de l'inclinaison des panneaux.
- **Rendu**, **réseau** et **échelle thermique**.

---

## Architecture

```
index.html                       Simulation 3D (le terrain)
console.html                     Console opérateur
server/server.js                 Express + WebSocket (ws) + API REST ; Vite en middleware en développement
server/operations.js             Supervision électrique simulée, alertes, envoi autonome du drone, ordres de travail
server/scenarios.js              Catalogue des scénarios de démo
src/shared/config.js             Paramètres de la simulation
src/shared/utils.js              Bruit procédural, aléatoire, fonctions mathématiques
src/shared/panelArt.js           Dessin des panneaux (cellules, défauts, chaleur)
src/simulation/main.js           Assemblage, interactions souris, survol de zone, mode suivi, boucle de rendu
src/simulation/scene.js          Rendu, ciel (Sky), carte d'environnement, soleil et ombres, plateforme
src/simulation/terrain.js        Terrain de la centrale
src/simulation/solarPlant.js     Zones et panneaux, structures (InstancedMesh), textures, défauts, contours, empreinte de scan
src/simulation/drone.js          Modèle procédural du drone et animation visuelle (inclinaison, hélices, LED, gimbal)
src/simulation/droneController.js  Machine à états, cinématique lissée, trajectoire d'analyse rapprochée
src/simulation/cameraFeed.js     Caméra embarquée, render target, post-traitement RGB / thermique, HUD
src/simulation/ui.js             Panneau latéral, onglets et fiche de zone, journal, infobulles
src/simulation/network.js        Client WebSocket : commandes entrantes, état sortant (5 Hz), reconnexion automatique
src/simulation/streamer.js       Retour vidéo vers la console (JPEG, à la demande)
src/console/main.js              Console : état, vues, commandes, notifications
src/console/plantMap.js          Carte SVG des modules (luminosité = courant), drone, trace, route
src/console/charts.js            Courbes temporelles (mesuré / attendu, début d'alerte, survol)
src/console/pilot.js             Pilotage manuel : clavier, manches virtuels, manette
src/console/video.js             Affichage du retour vidéo
src/console/notify.js            Bandeaux, son, notifications du navigateur
```

### Performances
- Structures, cadres et plots béton des 60 panneaux en `InstancedMesh`.
- Une seule texture de cellules haute résolution (2048 × 1024) partagée par les 60 panneaux. Chaque défaut est un calque transparent posé sur son panneau, ce qui limite fortement la mémoire graphique.
- La carte d'ombres est calculée **une seule fois par image** et réutilisée pour la caméra embarquée. Le HUD est redessiné à 30 Hz.
- La sélection du sol utilise une intersection analytique avec un plan. En plein écran caméra, la vue principale n'est plus rendue.

### Débogage
- `?debug` dans l'URL réactive la vérification de compilation des shaders. Elle est coupée par défaut, car ANGLE/Direct3D y ajoute des avertissements bénins.
- En développement, `window.__sim` donne accès aux objets de la simulation depuis la console du navigateur.
