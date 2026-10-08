// Scénario commun aux tests des cycles C5 et suivants : entreprise prête (zones, tarif, catalogue, équipe, véhicules),
// commande préparée et mise à quai, voyage chargé et scellé.
import assert from 'node:assert/strict';
import { Client, invite } from './api-client.js';

export const ev = () => crypto.randomUUID();

export async function setup(env, email = 'awa@express.sn', company = 'Express Dakar') {
  const admin = new Client(env); await admin.register(email, { company });
  await admin.rpc('lg_zones_seed');
  await admin.rpc('lg_upsert_rate_card', { p: { max_weight_g: 200000, price_fcfa: 1500 } });
  const me = await admin.rpc('lg_me');
  await admin.rpc('lg_hub_upsert', { p_id: me.hubs[0].id, p_name: 'Dépôt', p_lat: 14.716, p_lng: -17.467 });
  const P = {};
  P.rice = (await admin.rpc('lg_product_upsert', { p: { name: 'Riz 5 kg', sku: 'RIZ-5', price_fcfa: 5000, weight_g: 5000, stock: 10 } })).id;
  P.oil = (await admin.rpc('lg_product_upsert', { p: { name: 'Huile 1 L', sku: 'HUI-1', price_fcfa: 1500, weight_g: 1000, stock: 10 } })).id;
  const slug = email.split('@')[0];
  const picker = await invite(env, admin, `prep-${slug}@x.sn`, { staff: ['picker'], name: 'Fatou' });
  const dock = await invite(env, admin, `quai-${slug}@x.sn`, { staff: ['dock_chief'], name: 'Ousmane' });
  const disp = await invite(env, admin, `disp-${slug}@x.sn`, { staff: ['dispatcher'], name: 'Aïssatou' });
  const support = await invite(env, admin, `sav-${slug}@x.sn`, { staff: ['support'], name: 'Coumba' });
  const cashier = await invite(env, admin, `caisse-${slug}@x.sn`, { staff: ['cashier'], name: 'Mame' });
  const accountant = await invite(env, admin, `compta-${slug}@x.sn`, { staff: ['accountant'], name: 'Seynabou' });
  const driver = await invite(env, admin, `moussa-${slug}@x.sn`, { role: 'courier', name: 'Moussa Ndiaye' });
  const driver2 = await invite(env, admin, `ibou-${slug}@x.sn`, { role: 'courier', name: 'Ibrahima' });
  const couriers = await admin.rpc('lg_couriers_list');
  const C = { moussa: couriers.find((c) => c.name === 'Moussa Ndiaye').id, ibou: couriers.find((c) => c.name === 'Ibrahima').id };
  const V = {};
  V.van = (await dock.rpc('lg_upsert_vehicle', { p: { plate: 'DK-1234-A', kind: 'fourgonnette', capacity_kg: 500, max_packages: 40 } })).id;
  V.moto = (await dock.rpc('lg_upsert_vehicle', { p: { plate: 'DK-5678-B', kind: 'moto', capacity_kg: 30, max_packages: 6 } })).id;
  return { env, admin, picker, dock, disp, support, cashier, accountant, driver, driver2, P, C, V };
}

/** Commande préparée et mise à quai ; renvoie { order, codes }. */
export async function ready(S, items, { zone = 'Yoff', lat = null, lng = null, method = 'prepaid', phone = null } = {}) {
  const o = await S.support.rpc('lg_order_create', { p_customer: { name: 'Awa Diop', phone: phone ?? `77${Math.floor(1e6 + Math.random() * 8e6)}`, lat, lng },
    p_zone: zone, p_items: items.map(([product_id, quantity]) => ({ product_id, quantity })), p_payment_method: method });
  if (method === 'cod') await S.support.rpc('lg_confirm_cod', { p_order: o.id });
  const t = (await S.picker.rpc('lg_pick_queue')).find((x) => x.order_id === o.id);
  await S.picker.rpc('lg_pick_take', { p_task: t.id });
  const d = await S.picker.rpc('lg_pick_task_detail', { p_task: t.id });
  for (const l of d.lines) for (let i = 0; i < l.qty_ordered; i++) await S.picker.rpc('lg_pick_scan', { p_task: t.id, p_code: l.sku, p_event: ev() });
  const pk = await S.picker.rpc('lg_pack', { p_task: t.id, p_event: ev(), p_packages: [{ weight_g: d.lines.reduce((s, l) => s + l.weight_g * l.qty_ordered, 0) }] });
  for (const p of pk.packages) await S.picker.rpc('lg_stage', { p_code: p.code, p_event: ev() });
  return { order: o, codes: pk.packages.map((p) => p.code) };
}

/** Voyage chargé et scellé avec les commandes données ; renvoie l'id du voyage. */
export async function sealedTrip(S, orders, { vehicle = S.V.van, courier = S.C.moussa } = {}) {
  const tr = await S.disp.rpc('lg_trip_create', { p_vehicle: vehicle, p_courier: courier });
  for (const x of orders) {
    await S.disp.rpc('lg_trip_add_order', { p_trip: tr.trip_id, p_order: x.order.id });
    for (const c of x.codes) await S.dock.rpc('lg_load_package', { p_trip: tr.trip_id, p_code: c, p_event: ev() });
  }
  assert.equal((await S.dock.rpc('lg_trip_seal', { p_trip: tr.trip_id, p_signature_path: `${tr.trip_id}/signature-depart.png` })).ok, true);
  return tr.trip_id;
}

export const otpOf = (env, orderId) => env.DB.db.prepare('SELECT code, attempts_left FROM delivery_codes WHERE order_id = ?').get(orderId);
export const tokenOf = (env, orderId) => env.DB.db.prepare('SELECT tracking_token FROM orders WHERE id = ?').get(orderId).tracking_token;

