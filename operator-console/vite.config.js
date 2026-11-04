import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const page = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

export default defineConfig({
  // Pré-optimisation explicite : évite un rechargement de page à la première visite
  optimizeDeps: {
    include: [
      'three',
      'three/addons/controls/OrbitControls.js',
      'three/addons/objects/Sky.js',
      'three/addons/renderers/CSS2DRenderer.js',
      'three/addons/geometries/RoundedBoxGeometry.js',
    ],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      // Deux pages : la simulation 3D (le terrain) et la console opérateur
      input: {
        main: page('index.html'),
        console: page('console.html'),
      },
    },
  },
});
