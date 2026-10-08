import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { installErrorReporter } from './lib/report.js';

if (import.meta.env.PROD) installErrorReporter();

createRoot(document.getElementById('root')).render(<App />);

// Ancienne démonstration (base PGlite dans le navigateur, retirée le 08/10/2026) : libérer la place qu'elle occupait
try {
  if (localStorage.getItem('lg-demo-uid') !== null || localStorage.getItem('lg-demo-session') !== null) {
    indexedDB.deleteDatabase('/pglite/nexus-logistics-demo-v1');
    localStorage.removeItem('lg-demo-uid'); localStorage.removeItem('lg-demo-session');
  }
} catch { /* stockage indisponible */ }

// Application installable et utilisable sans réseau (service worker en production seulement)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
