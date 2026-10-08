// Remontée des erreurs de l'interface (version complète) : POST /api/errors, 5 par page au plus, sans doublon.
const seen = new Set();
function send(message, stack) {
  const key = String(message).slice(0, 200);
  if (!message || seen.has(key) || seen.size >= 5) return;
  seen.add(key);
  const body = JSON.stringify({ message: key, stack: String(stack ?? '').slice(0, 4000), url: location.pathname });
  try {
    if (!navigator.sendBeacon?.('/api/errors', new Blob([body], { type: 'application/json' }))) {
      fetch('/api/errors', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* jamais bloquant */ }
}
export function installErrorReporter() {
  addEventListener('error', (e) => send(e.message, e.error?.stack));
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    // erreurs métier et coupures réseau : déjà affichées à l'utilisateur, pas des pannes
    if (r?.name === 'RpcError' || r?.name === 'NetworkError' || r?.code) return;
    send(r?.message ?? String(r), r?.stack);
  });
}
