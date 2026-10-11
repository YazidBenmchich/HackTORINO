---
name: HelioScan
description: Console opérateur d'une centrale photovoltaïque inspectée par drone : graphite, vert énergie, modules dessinés comme leurs propres cellules.
colors:
  ground: "#0c0e12"
  surface: "#121519"
  surface-2: "#181c22"
  surface-3: "#20252d"
  rail: "#08090c"
  rail-2: "#15191f"
  line: "rgba(205, 212, 222, .09)"
  line-2: "rgba(205, 212, 222, .16)"
  line-3: "rgba(205, 212, 222, .3)"
  busbar-silver: "#c7ccd4"
  text: "#eceef1"
  text-2: "#b4bac3"
  muted: "#949ba6"
  cell-blue: "#2f62e0"
  cell-dead: "#070e22"
  primary: "#10b981"
  primary-hi: "#34d399"
  primary-ink: "#04140e"
  series: "#14a877"
  series-area: "rgba(20, 168, 119, .13)"
  drone: "#a78bfa"
  drone-ink: "#ddd6fe"
  drone-bg: "rgba(167, 139, 250, .14)"
  drone-line: "rgba(167, 139, 250, .55)"
  ok: "#22c55e"
  ok-ink: "#86efac"
  warn: "#f59e0b"
  warn-ink: "#fbbf24"
  warn-bg: "rgba(245, 158, 11, .12)"
  warn-line: "rgba(245, 158, 11, .5)"
  crit: "#ef4444"
  crit-ink: "#f87171"
  crit-bg: "rgba(239, 68, 68, .13)"
  crit-line: "rgba(239, 68, 68, .55)"
  focus: "#6ee7b7"
  video-black: "#050608"
typography:
  display:
    fontFamily: "'Archivo Variable', 'Archivo', system-ui, sans-serif"
    fontSize: "clamp(44px, 4.2vw, 64px)"
    fontWeight: 300
    lineHeight: 0.95
    letterSpacing: "-0.035em"
    fontVariation: "'wdth' 118"
    fontFeature: "'tnum'"
  headline:
    fontFamily: "'Archivo Variable', 'Archivo', system-ui, sans-serif"
    fontSize: "27px"
    fontWeight: 420
    lineHeight: 1.05
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 112"
    fontFeature: "'tnum'"
  panel-id:
    fontFamily: "'Archivo Variable', 'Archivo', system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 115"
  title:
    fontFamily: "'Archivo Variable', 'Archivo', system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 112"
  body:
    fontFamily: "'Archivo Variable', 'Archivo', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    fontVariation: "'wdth' 100"
    fontFeature: "'tnum'"
  body-small:
    fontFamily: "'Archivo Variable', 'Archivo', system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "'Archivo Variable', 'Archivo', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 650
    letterSpacing: "0.13em"
    fontVariation: "'wdth' 72"
  telemetry:
    fontFamily: "'Martian Mono Variable', 'Martian Mono', ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "-0.01em"
    fontFeature: "'tnum'"
rounded:
  none: "0px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.none}"
    padding: "0 14px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hi}"
    textColor: "{colors.primary-ink}"
  button-secondary:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: "0 14px"
    height: "38px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-3}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.none}"
    padding: "0 14px"
    height: "38px"
  button-drone-active:
    backgroundColor: "{colors.drone-bg}"
    textColor: "{colors.drone-ink}"
    rounded: "{rounded.none}"
  button-small:
    padding: "0 10px"
    height: "30px"
  chip-status:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.none}"
    padding: "0 11px"
    height: "30px"
  input-field:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: "0 10px"
    height: "34px"
  nav-rail-item:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    width: "76px"
  nav-rail-item-active:
    backgroundColor: "{colors.rail-2}"
    textColor: "{colors.text}"
  sev-pill-warning:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn}"
    rounded: "{rounded.none}"
    padding: "4px 9px"
  sev-pill-critical:
    backgroundColor: "{colors.crit-bg}"
    textColor: "{colors.crit-ink}"
    rounded: "{rounded.none}"
    padding: "4px 9px"
  kpi-cell:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    padding: "14px 16px"
---

# Design System: HelioScan

Portée : ce système gouverne les surfaces opérateur (la console `console.html`, styles dans `src/console/console.css`). Le simulateur 3D (`index.html`) garde son style historique (`src/style.css`) et n'est pas régi par ce fichier.

## Overview

**Creative North Star: "La cellule photovoltaïque"**

La centrale se lit comme ses propres cellules. Chaque panneau est dessiné en module PV (trame de cellules, deux busbars argent) et sa luminosité suit le courant mesuré : un module qui décroche s'assombrit sous les yeux, du bleu cellule vers le silicium éteint. Autour, l'interface est du graphite neutre, étagé par paliers de ton, avec des filets clairs à faible opacité comme seule structure ; les modules bleus et le drone violet en ressortent comme les seuls objets colorés du terrain. Pas de cartes flottantes, pas de verre, pas d'arrondis : la modernité tient aux surfaces étagées, à une fine arête claire en haut des cadres (`--sheen`) et à un seul accent, le vert énergie.

La densité est celle d'une salle de contrôle allumée toute la journée : des cadres partagés découpés par des filets de 1 px, des libellés de données en capitales condensées, et un contraste d'échelle fort entre ces libellés minuscules et des chiffres monumentaux, étendus, en graisse légère. Une couleur porte un seul rôle : le vert émeraude pour l'action et la production mesurée, le bleu cellule pour les modules (donnée physique), le violet pour le drone, le vert clair, l'ambre et le rouge pour l'état. L'état s'affiche comme une marque carrée dans une case fixe, toujours au même endroit.

**Key Characteristics:**
- Graphite neutre, paliers de surface tonaux, filets clairs comme unique armature, arête claire en haut des cadres.
- Coins vifs partout (0 px), y compris curseurs, interrupteurs, pastilles et sélecteurs.
- Archivo variable exploitée en largeur : libellés à 72 %, chiffres à 112–118 %.
- Une couleur = un rôle ; l'émeraude n'appartient qu'à l'action, le violet qu'au drone.
- État = marque carrée pleine, creuse ou barrée dans une case fixe.

## Colors

Du graphite neutre, un seul accent vert énergie pour agir, et deux couleurs « du terrain » : le bleu silicium des modules et le violet du drone.

### Primary
- **Vert émeraude** (`primary`) : bouton primaire d'un groupe (Décoller, Lancer l'inspection, Déclencher), soulignement du segment actif, indicateur du rail, sélection du texte, caret, anneau de focus (`focus`). Texte sombre `primary-ink` sur l'émeraude (le blanc n'y atteint pas 4,5:1). Le survol (`primary-hi`) s'éclaircit.
- **Vert série** (`series`) : la courbe mesurée des graphiques temporels et son aire (`series-area`).
- **Bleu cellule** (`cell-blue`) : le module PV à son courant attendu. La rampe va de `cell-dead` (module éteint) à `cell-blue`, resserrée sur la zone utile : −5 % se voit, −25 % est presque noir. Le bleu ne sert qu'aux modules : c'est la couleur réelle du silicium.

### Secondary
- **Violet drone** (`drone`) : exclusivement le drone : position, cap, route en pointillé, trace, étiquette d'état active, manche de pilotage, interrupteur armé, étape « en cours » de la chaîne d'avancement. `drone-ink` pour le texte violet, `drone-bg` pour les fonds actifs, `drone-line` pour les contours.

### Tertiary
- **Vert conforme** (`ok`), **Ambre surveillance** (`warn`), **Rouge critique** (`crit`) : les trois états, en marques pleines, contours de module, repères de terrain et pastilles. Chaque état a une encre claire pour le texte (`ok-ink`, `warn-ink`, `crit-ink`), un fond à ~12 % (`warn-bg`, `crit-bg`) et un contour (`warn-line`, `crit-line`).

### Neutral
- **Graphite** (`ground`) : fond de page, barre supérieure, champs de saisie.
- **Surfaces** (`surface`, `surface-2`, `surface-3`) : trois paliers ; cadres de cartes, de tableaux et colonnes latérales, puis boutons, en-têtes et blocs de mesure, puis sélection, survol et calques flottants.
- **Rail** (`rail`, `rail-2`) : rail de navigation, plus sombre que la page, et son état actif.
- **Filets** (`line`, `line-2`, `line-3`) : gris clair à 9, 16 et 30 % ; séparateurs internes, cadres, contours de contrôles.
- **Argent** (`busbar-silver`) : busbars des modules, courbe attendue en tirets, marque « non inspecté ».
- **Texte** (`text`, `text-2`, `muted`) : primaire, secondaire, libellés et métadonnées.
- **Noir vidéo** (`video-black`) : fond des flux caméra et photos.

### Named Rules
**The One Color One Role Rule.** Chaque teinte a un seul emploi. L'émeraude n'apparaît que sur l'action et la mesure, le violet que sur le drone, le bleu que sur les modules ; vert clair, ambre et rouge ne décorent jamais.

**The Living Cell Rule.** Le remplissage d'un module vient de son courant mesuré, jamais d'une couleur d'état. L'état s'ajoute par-dessus (contour, marque), il ne remplace pas la luminosité.

## Typography

**Display Font:** Archivo Variable (axe de largeur 62–125), avec repli Archivo, system-ui
**Body Font:** Archivo Variable
**Label/Mono Font:** Martian Mono Variable, avec repli ui-monospace

**Character:** Une seule famille jouée sur sa largeur : condensée et serrée pour nommer, étendue et légère pour mesurer. Martian Mono porte la télémétrie, l'horloge, les heures et les axes des graphiques. Tous les chiffres sont tabulaires.

### Hierarchy
- **Display** (300, clamp(44px, 4.2vw, 64px), 0.95, largeur 118 %) : la puissance de la centrale ; la même voix à 46 px pour l'identifiant du panneau en tête d'alerte.
- **Headline** (420, 27px, 1.05, largeur 112 %) : les autres indicateurs (ratio, irradiance, panneaux en alerte, vent) ; 23 px dans les métriques d'alerte. Unités en `small` à 15 px, 500, largeur 100 %, `muted`.
- **Panel ID** (500, 24px, 1, largeur 115 %) : identifiant de panneau dans les listes d'alertes (A07, C14).
- **Title** (650, 22px, largeur 112 %) : titre de vue dans la barre supérieure. Titres de tiroir à 26 px, 400, largeur 115 %.
- **Body** (400, 13px, 1.45) : texte courant ; 12.5px pour les lignes de liste et de journal ; 12px pour `.sub` en `muted`.
- **Label** (650, 11px, 0.13em, largeur 72 %, capitales) : noms de données et en-têtes de section, toujours en `muted`.
- **Telemetry** (Martian Mono, 11px, −0.01em) : valeurs instrumentales.

### Named Rules
**The Scale Contrast Rule.** Un chiffre important est grand, léger et étendu ; son nom est petit, gras et condensé. Ne jamais rapprocher les deux.

**The Width Axis Rule.** La hiérarchie se fait d'abord par l'axe `wdth`, ensuite par la taille. Pas de seconde famille d'affichage.

## Layout

Cadre en grille plein écran : rail de navigation de 76 px à gauche, barre supérieure de 64 px, puis la vue. La supervision sépare une zone principale fluide et une colonne droite de 440 px (380 px sous 1360 px) : vidéo 16:9, rangée de trois commandes, file d'alertes. Les blocs de données partagent un cadre commun découpé par des filets de 1 px (bandeau KPI, bande de zones, métriques d'alerte, chaîne d'avancement) plutôt que d'être des cartes séparées.

Rythme : marges de vue 18 px vertical / 22 px horizontal (14/16 px en mobile), 16 px entre blocs, sections latérales 16 × 18 px, gouttières internes 6 à 12 px. La carte de la centrale garde l'ordre des rangées et colonnes du terrain (zones de 5 × 4 modules au format 2:1) et choisit la disposition qui donne les plus grands modules : côte à côte, sur deux colonnes, ou empilée.

Adaptation : sous 1720 px le bandeau KPI passe à puissance + 2 × 2 ; sous 1100 px les colonnes latérales passent sous le contenu et la page défile ; sous 760 px le rail devient une barre d'onglets fixe de 62 px en bas et le titre de vue s'efface au profit des outils.

## Elevation & Depth

Système plat : la profondeur vient des paliers de surface (`ground` → `surface` → `surface-2` → `surface-3`) et des filets argent, pas d'ombre au repos. Seuls les calques réellement flottants (menu, popover, tiroir, info-bulle, toast) portent une ombre portée douce et sombre pour se détacher de la vidéo et de la carte. Les états actifs s'expriment par des filets internes (`inset`) de 1 à 2 px, jamais par un soulèvement.

### Shadow Vocabulary
- **Calque flottant** (`box-shadow: 0 18px 40px -12px rgba(0, 0, 0, .7)`) : menus et popovers.
- **Tiroir** (`box-shadow: -24px 0 50px -20px rgba(0, 0, 0, .7)`) : tiroir de détail panneau, à droite.
- **Toast** (`box-shadow: 0 16px 34px -14px rgba(0, 0, 0, .8)`) et **info-bulle** (`0 10px 24px -8px rgba(0, 0, 0, .7)`).
- **Filet actif** (`box-shadow: inset 0 -2px 0 <couleur>`) : segment actif (argent), commande drone active (violet), rail actif (filets haut et bas `line-3`).

### Named Rules
**The Flat Silicon Rule.** Ce qui est posé dans la page est plat et cerné d'un filet. Une ombre signifie « ce calque flotte au-dessus », rien d'autre.

## Shapes

Coins vifs sans exception (0 px) : boutons, champs, sélecteurs natifs, pastilles, curseurs de plage, poignée de l'interrupteur, manches de pilotage, marques d'état. Les bordures sont d'1 px en argent translucide ; 1.5 px pour les marques carrées, 2 px pour la chaîne d'avancement active et le cadre de pilotage. Les icônes suivent le même langage : tracés 24 × 24, trait 1.6, extrémités carrées, jointures en onglet. Le carré est la forme de l'état ; seul le drone est un losange (carré tourné à 45°).

## Components

### Buttons
Tactiles et sobres, cernés d'argent.
- **Shape:** coins vifs, hauteur 38 px (30 px en petit, 46 px dans la rangée de commandes et le pilotage).
- **Primary:** fond `primary`, texte blanc, 600, largeur 96 %. Une seule par groupe.
- **Secondary:** fond `surface-2`, filet `line-3` ; survol `surface-3` avec filet argent plein ; appui décalé de 1 px vers le bas ; désactivé à 42 % d'opacité.
- **Ghost:** transparent, filet `line-2`, texte `text-2`.
- **Drone actif:** fond `drone-bg`, filet violet, texte `drone-ink` (Prendre la main armé). Dans la rangée de commandes, filet bas violet de 2 px.
- **Icon button:** carré de 32 px, filet `line-2`.

### Chips
- **Style:** statut de liaison dans la barre supérieure, 30 px, filet `line-2`, carré d'état de 7 px.
- **State:** l'avertissement et la coupure teintent le filet et le texte (ambre, rouge) ; la marque reste un carré plein.

### Cards / Containers
- **Corner Style:** vif.
- **Background:** `surface` pour la carte de centrale, le tableau et les colonnes latérales ; `surface-2` pour les en-têtes collants et les renvois (ordre de travail).
- **Shadow Strategy:** aucune (voir Elevation & Depth).
- **Border:** `line-2` en cadre, `line` entre les lignes internes.
- **Internal Padding:** 14 × 16 px pour les cellules KPI, 16 × 18 px pour les sections latérales.

### Inputs / Fields
- **Style:** fond `ground`, filet `line-3`, 34 px, coins vifs ; sélecteurs natifs en `surface-2`, 32 px.
- **Focus:** le filet passe en `focus` ; ailleurs, contour `focus` de 2 px décalé de 2 px.
- **Range:** piste de 2 px `line-3`, poignée carrée de 14 px, argent au repos, violet quand le pilotage est actif.
- **Switch:** piste carrée 30 × 16, poignée carrée ; armé = violet.

### Navigation
Rail vertical `rail` de 76 px : icône 20 px au-dessus d'un libellé de 11 px, 600, largeur 78 %, texte `#a9b8d8`. Survol et vue courante en `rail-2` et texte blanc ; la vue courante ajoute des filets haut et bas `line-3` et une icône argent. Badge d'alertes carré en coin (ambre, rouge si critique, argent si discret). Sous 760 px : barre d'onglets en bas, la vue courante marquée d'un filet argent supérieur.

### Severity Mark & Pill
- **Marque :** carré de 10 px (8 px dans les légendes et le tableau) : creux argent = en attente, plein vert = conforme, plein rouge = défaut, plein violet = en cours d'analyse.
- **Pastille :** capitales, 11.5px, 700, largeur 85 %, filet de la couleur d'état, fond à ~12 %.

### Plant Map Module (signature)
Rectangle 2:1 rempli selon le courant (rampe `cell-dead` → `cell-blue`, transition linéaire de 1.2 s), trame de 10 × 6 cellules à 16 % et deux busbars argent à 62 %. Case fixe au coin nord-ouest pour la marque d'inspection (barrée de blanc en cas de défaut). Contour extérieur ambre en surveillance, rouge pulsé en critique. Sélection = contour blanc, cible du drone = contour violet. Le drone est un losange violet avec halo, cap et altitude en Martian Mono ; sa route est en pointillé violet, sa trace en violet à 40 %.

### Time Chart
Grille en `line`, axe Y en Martian Mono 11 px, courbe mesurée `series` de 2 px avec aire à 14 %, courbe attendue argent en tirets 4/4, repères d'événements en tirets colorés par sévérité. Info-bulle en `surface-3` avec valeurs en mono.

### Progress Pipe
Chaîne Détection → Drone → Analyse → Diagnostic → OT : carrés de 9 px reliés par des filets ; fait = argent plein, en cours = violet clignotant, à venir = creux.

## Do's and Don'ts

### Do:
- **Do** garder tous les coins à 0 px, y compris sur les contrôles natifs (`border-radius: 0`).
- **Do** structurer par filets argent translucides (`line`, `line-2`, `line-3`) et par paliers de surface, dans un cadre partagé.
- **Do** réserver le violet `drone` à tout ce qui concerne le drone, et seulement à lui.
- **Do** exprimer un état par une marque carrée dans une case fixe, doublée d'un libellé texte.
- **Do** poser les chiffres clés en Archivo légère et étendue (300, largeur 112–118 %) et leurs noms en capitales condensées de 11 px (largeur 72 %).
- **Do** utiliser Martian Mono pour la télémétrie, les heures et les axes ; chiffres tabulaires partout.
- **Do** dessiner les icônes en tracés 24 × 24, trait 1.6, extrémités carrées.
- **Do** respecter `prefers-reduced-motion` (animations et transitions neutralisées).

### Don't:
- **Don't** construire une grille de cartes KPI grises à accent bleu, séparées et ombrées.
- **Don't** arrondir un coin ni utiliser de verre dépoli ou de flou d'arrière-plan.
- **Don't** poser d'ombre sur un élément posé dans la page ; l'ombre est réservée aux calques flottants.
- **Don't** colorer un module de la carte par son état : sa luminosité appartient au courant mesuré.
- **Don't** utiliser le violet pour une action générique, ni le vert, l'ambre ou le rouge comme décoration.
- **Don't** ajouter une seconde famille d'affichage ; la hiérarchie passe par l'axe de largeur d'Archivo.
