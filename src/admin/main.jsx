// Point d'entrée du tableau de bord d'administration (/admin/) : page séparée de l'application des entreprises,
// mêmes composants et même style ; les fonctions passent par /api/admin/rpc/ (session d'administration).
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { useAdminRpc } from '../lib/backend.js';
import { ToastProvider, NavProvider } from '../components/ui.jsx';
import AdminApp from './AdminApp.jsx';

useAdminRpc();
try { const t = localStorage.getItem('lg-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* stockage indisponible */ }
createRoot(document.getElementById('root')).render(<ToastProvider><NavProvider><AdminApp /></NavProvider></ToastProvider>);
