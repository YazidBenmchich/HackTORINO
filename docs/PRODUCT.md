# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Opérateurs de maintenance qui supervisent l'inspection d'une centrale photovoltaïque et repèrent les panneaux défectueux. Le projet est aussi présenté en démo à un jury lors du hackathon de Turin (équipe suisse), donc il doit se comprendre vite en présentation.

## Product Purpose
HelioScan simule l'inspection autonome d'une centrale solaire par un quadricoptère : 3 zones (A, B, C) de 20 panneaux, soit 60 panneaux. Chaque panneau est analysé de très près, en longeant ses côtés, avec un retour caméra embarqué (RGB ou thermique), un HUD, une vue de synthèse par zone et une interface de supervision. Le succès : l'opérateur sait quels panneaux ont été inspectés et lesquels ont un défaut.

## Positioning
Inspection autonome rapprochée, panneau par panneau, avec bascule RGB/thermique en direct et pilotage externe possible via une API REST et une WebSocket.

## Operating Context
Application web Three.js servie par un serveur Node.js/Express (Vite en middleware, port 3000). Tout est généré de façon procédurale (drone, panneaux, textures, ciel) : aucun asset externe, utilisable hors ligne une fois les dépendances installées. Les panneaux sont identifiés par zone + numéro (A01 à C20).

## Capabilities and Constraints
- Missions : toute la centrale, une zone, un panneau, survol d'une zone ou d'un point.
- Console opérateur (`console.html`) pour la société d'exploitation : supervision électrique simulée (courant par module), alertes de baisse de courant avec envoi autonome du drone, diagnostic avec photo, ordres de travail, pilotage à distance (sortie de base, pilotage manuel, retour base) et retour vidéo.
- Contrôles souris et clavier, vitesse de simulation ×1 à ×8, mode suivi du drone.
- Interface en anglais (console, simulation, messages du serveur) pour un jury international ; documentation et code commentés en français. Le prototype mobile (scanner, mires) est encore en français.
- Node.js 20.19+ ou 22.12+.
- Contraintes d'accessibilité et de compatibilité API non précisées : à ne pas inventer.

## Evidence on Hand
README détaillé dans `solar-drone-sim/README.md`. Aucun témoignage, client ni benchmark : ne pas en fabriquer.

## Product Principles
- Le drone et la centrale restent le sujet ; l'interface sert la supervision.
- Chaque état d'un panneau (non analysé, en cours, analysé, défaut) se lit d'un coup d'œil.
- Tout reste procédural et utilisable hors ligne.
- Lisible en démonstration devant un jury.
