// Banc de test : une base Postgres complète en mémoire (PGlite / WebAssembly),
// avec le miroir des tables NEXUS Market, toutes les migrations et le jeu démo.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

export const migrationFiles = () =>
  readdirSync(join(root, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql') && !f.includes('supabase_only'))
    .sort();

export const U = {
  admin: '00000000-0000-4000-a000-000000000001',
  picker: '00000000-0000-4000-a000-000000000002',
  dock: '00000000-0000-4000-a000-000000000003',
  dispatcher: '00000000-0000-4000-a000-000000000004',
  cashier: '00000000-0000-4000-a000-000000000005',
  driver: '00000000-0000-4000-a000-000000000006',
  vendor: '00000000-0000-4000-a000-000000000007',
  accountant: '00000000-0000-4000-a000-000000000008',
  driver2: '00000000-0000-4000-a000-000000000009',
  support: '00000000-0000-4000-a000-000000000010',
  stranger: '00000000-0000-4000-a000-0000000000ff',
};
export const IDS = {
  hub: '10000000-0000-4000-a000-000000000001',
  courier: '20000000-0000-4000-a000-000000000001',
  courier2: '20000000-0000-4000-a000-000000000002',
  van: '30000000-0000-4000-a000-000000000001',
  moto: '30000000-0000-4000-a000-000000000002',
  tricycle: '30000000-0000-4000-a000-000000000003',
  rice: '41000000-0000-4000-a000-000000000001',
  oil: '42000000-0000-4000-a000-000000000002',
  eggs: '43000000-0000-4000-a000-000000000003',
  soap: '44000000-0000-4000-a000-000000000004',
  fan: '45000000-0000-4000-a000-000000000005',
  course: '49000000-0000-4000-a000-000000000009',
};

export async function createDb({ seed = true } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(read('supabase/stub/prod_subset.sql'));
  for (const f of migrationFiles()) {
    try {
      await db.exec(read(join('supabase/migrations', f)));
    } catch (e) {
      e.message = `${f}: ${e.message}`;
      throw e;
    }
  }
  if (seed) await db.exec(read('supabase/seed/demo.sql'));

  const as = async (uid) => db.query("select set_config('test.uid', $1, false)", [uid ?? '']);

  // Appel d'une fonction RPC comme le ferait supabase.rpc(name, args), sous l'identité uid.
  const rpc = async (uid, name, args = {}) => {
    await as(uid);
    const keys = Object.keys(args);
    const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    const vals = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v)
        : Array.isArray(v) && v.some((x) => typeof x === 'object') ? JSON.stringify(v) : v;
    });
    const { rows } = await db.query(sql, vals);
    return rows[0].r;
  };

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const all = async (sql, params = []) => (await db.query(sql, params)).rows;

  return { db, as, rpc, one, all, ev: () => randomUUID() };
}

// Crée une commande comme le site (orders.products en JSON, prix en EUR)
export async function makeOrder(t, { method = 'cod', paid = false, lines, city = 'Rufisque', lat = 14.7161, lng = -17.2701, name = 'Awa Diop' } = {}) {
  await t.as(null);
  const products = (lines ?? [[IDS.rice, 2], [IDS.oil, 1], [IDS.eggs, 1]]).map(([id, q]) => ({ id, quantity: q }));
  const { rows } = await t.db.query(
    `with p as (
       select jsonb_agg(jsonb_build_object('id', x.id, 'quantity', x.q, 'price', pr.price, 'name', pr.name)) j,
              sum(pr.price * x.q) s
         from jsonb_to_recordset($1::jsonb) as x(id uuid, quantity int, q int)
         join public.products pr on pr.id = x.id)
     insert into public.orders (status, payment_status, payment_method, products, total, subtotal, buyer_name, buyer_phone,
                                buyer_address, shipping_city, vendor_id, vendor_name, delivery_lat, delivery_lng, landmark, delivery_fee_fcfa)
     select 'pending', $2, $3, p.j, p.s, p.s, $4, '+221771112233', 'Keury Souf', $5, $6, 'Boutique Ndèye', $7, $8, 'face pharmacie', 1500
       from p returning id`,
    [JSON.stringify(products.map((p) => ({ id: p.id, q: p.quantity }))), paid ? 'paid' : 'pending', method, name, city, U.vendor, lat, lng]);
  return rows[0].id;
}
