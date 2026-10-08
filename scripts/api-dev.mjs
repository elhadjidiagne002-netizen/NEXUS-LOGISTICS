// API de développement sans Cloudflare : server/app.js sur SQLite local (même schéma que D1).
// Usage : node scripts/api-dev.mjs [port] [fichier.sqlite|:memory:] — Vite relaie /api vers ce port.
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handle } from '../server/app.js';
import { D1Mock } from '../test/helpers/d1-mock.js';

const port = Number(process.argv[2] || process.env.API_PORT || 8789);
const dbPath = process.argv[3] || fileURLToPath(new URL('../.wrangler/dev.sqlite', import.meta.url));
if (dbPath !== ':memory:') mkdirSync(new URL('../.wrangler/', import.meta.url), { recursive: true });
const env = { DB: new D1Mock(dbPath), ...Object.fromEntries(['ADMIN_EMAILS', 'CRON_SECRET', 'SECRETS_KEY', 'BREVO_API_KEY'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'origin') headers.set(k, v);
  const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
  const r = await handle(new Request(`http://${req.headers.host || `localhost:${port}`}${req.url}`, { method: req.method, headers, body }), env);
  const out = {};
  r.headers.forEach((v, k) => { out[k] = k === 'set-cookie' ? v.replace(/; Secure/i, '') : v; });
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`API NEXUS Logistics sur http://localhost:${port} (base : ${dbPath})`));
