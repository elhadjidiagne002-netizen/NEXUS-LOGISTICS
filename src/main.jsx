import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { MODE } from './lib/backend.js';
import { installErrorReporter } from './lib/report.js';

if (MODE === 'api' && import.meta.env.PROD) installErrorReporter();

createRoot(document.getElementById('root')).render(<App />);

// Application installable et utilisable sans réseau (service worker en production seulement)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
