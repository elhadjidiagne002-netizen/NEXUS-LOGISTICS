// Cycle C4 — flotte, quai et voyages. Comportement porté de test/sql/parcours (08), cycle1 (collecte vendeur,
// réception), cycle3 (planification automatique), cycle11 (quais), cycle17 (dépôts vendeurs), cycle19 (entretien) ;
// + isolation entre entreprises et rôles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, Client, invite } from '../helpers/api-client.js';

const ev = () => crypto.randomUUID();
const tomorrow = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);

/** Entreprise prête : zones, tarif, catalogue, équipe, deux véhicules et deux chauffeurs. */
async function setup(env, email = 'awa@express.sn', company = 'Express Dakar') {
  const admin = new Client(env); await admin.register(email, { company });
  await admin.rpc('lg_zones_seed');
  await admin.rpc('lg_upsert_rate_card', { p: { max_weight_g: 200000, price_fcfa: 1500 } });
  const me = await admin.rpc('lg_me');
  await admin.rpc('lg_hub_upsert', { p_id: me.hubs[0].id, p_name: 'Dépôt', p_lat: 14.716, p_lng: -17.467 });
  const P = {};
  P.rice = (await admin.rpc('lg_product_upsert', { p: { name: 'Riz 5 kg', sku: 'RIZ-5', price_fcfa: 5000, weight_g: 5000 } })).id;
  P.oil = (await admin.rpc('lg_product_upsert', { p: { name: 'Huile 1 L', sku: 'HUI-1', price_fcfa: 1500, weight_g: 1000, handling: ['liquide'] } })).id;
  P.fish = (await admin.rpc('lg_product_upsert', { p: { name: 'Poisson congelé', sku: 'POI-1', price_fcfa: 4000, weight_g: 2000, handling: ['froid'] } })).id;
  const slug = email.split('@')[0];
  const picker = await invite(env, admin, `prep-${slug}@x.sn`, { staff: ['picker'], name: 'Fatou' });
  const dock = await invite(env, admin, `quai-${slug}@x.sn`, { staff: ['dock_chief'], name: 'Ousmane' });
  const disp = await invite(env, admin, `disp-${slug}@x.sn`, { staff: ['dispatcher'], name: 'Aïssatou' });
  const support = await invite(env, admin, `sav-${slug}@x.sn`, { staff: ['support'], name: 'Coumba' });
  const driver = await invite(env, admin, `moussa-${slug}@x.sn`, { role: 'courier', name: 'Moussa' });
  const driver2 = await invite(env, admin, `ibou-${slug}@x.sn`, { role: 'courier', name: 'Ibrahima' });
  const couriers = await admin.rpc('lg_couriers_list');
  const C = { moussa: couriers.find((c) => c.name === 'Moussa').id, ibou: couriers.find((c) => c.name === 'Ibrahima').id };
  const V = {};
  V.van = (await dock.rpc('lg_upsert_vehicle', { p: { plate: 'dk-1234-a', kind: 'fourgonnette', capacity_kg: 500, capacity_l: 3000, max_packages: 40, default_courier_id: C.moussa } })).id;
  V.moto = (await dock.rpc('lg_upsert_vehicle', { p: { plate: 'DK-5678-B', kind: 'moto', capacity_kg: 30, max_packages: 6, default_courier_id: C.ibou } })).id;
  return { admin, picker, dock, disp, support, driver, driver2, P, C, V };
}

/** Commande payée d'avance, préparée et mise à quai ; renvoie { order, codes }. */
async function ready(S, items, { zone = 'Rufisque', lat = null, lng = null, packages = null, method = 'prepaid' } = {}) {
  const o = await S.support.rpc('lg_order_create', { p_customer: { name: 'Awa Diop', phone: `77${Math.floor(1e6 + Math.random() * 8e6)}`, lat, lng },
    p_zone: zone, p_items: items.map(([product_id, quantity]) => ({ product_id, quantity })), p_payment_method: method });
  if (method === 'cod') await S.support.rpc('lg_confirm_cod', { p_order: o.id });
  const t = (await S.picker.rpc('lg_pick_queue')).find((x) => x.order_id === o.id);
  await S.picker.rpc('lg_pick_take', { p_task: t.id });
  const d = await S.picker.rpc('lg_pick_task_detail', { p_task: t.id });
  for (const l of d.lines) for (let i = 0; i < l.qty_ordered; i++) await S.picker.rpc('lg_pick_scan', { p_task: t.id, p_code: l.sku, p_event: ev() });
  const pk = await S.picker.rpc('lg_pack', { p_task: t.id, p_event: ev(), p_packages: packages ? packages(d.lines) : [{ weight_g: d.lines.reduce((s, l) => s + l.weight_g * l.qty_ordered, 0) }] });
  for (const p of pk.packages) await S.picker.rpc('lg_stage', { p_code: p.code, p_event: ev() });
  return { order: o, codes: pk.packages.map((p) => p.code) };
}

test('flotte : véhicules, documents, contrôle avant départ, entretien au kilométrage', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const fleet = await S.dock.rpc('lg_fleet');
  assert.deepEqual(fleet.map((v) => v.plate).sort(), ['DK-1234-A', 'DK-5678-B']);
  assert.equal(fleet.find((v) => v.plate === 'DK-1234-A').default_courier.name, 'Moussa');
  assert.equal(await S.dock.rpcError('lg_upsert_vehicle', { p: { plate: 'DK-1234-A', kind: 'moto', capacity_kg: 20 } }), 'plate_taken');
  assert.equal(await S.dock.rpcError('lg_upsert_vehicle', { p: { plate: 'X', kind: 'avion', capacity_kg: 20 } }), 'invalid_vehicle');
  assert.equal(await S.picker.rpcError('lg_upsert_vehicle', { p: { plate: 'X', kind: 'moto', capacity_kg: 20 } }), 'forbidden');
  // assurance périmée : départ interdit ; nouvelle assurance : départ possible
  await S.dock.rpc('lg_add_document', { p_vehicle: S.V.moto, p_kind: 'assurance', p_number: 'A-1', p_expires_at: '2020-01-01' });
  assert.equal(await S.disp.rpcError('lg_trip_create', { p_vehicle: S.V.moto, p_courier: S.C.ibou }), 'vehicle_documents_expired');
  assert.equal((await S.dock.rpc('lg_fleet')).find((v) => v.id === S.V.moto).documents[0].expired, true);
  await S.dock.rpc('lg_add_document', { p_vehicle: S.V.moto, p_kind: 'assurance', p_number: 'A-2', p_expires_at: '2099-01-01' });
  // permis du chauffeur
  await S.dock.rpc('lg_add_document', { p_courier: S.C.ibou, p_kind: 'permis', p_expires_at: '2020-01-01' });
  assert.equal(await S.disp.rpcError('lg_trip_create', { p_vehicle: S.V.moto, p_courier: S.C.ibou }), 'license_expired');
  await S.dock.rpc('lg_add_document', { p_courier: S.C.ibou, p_kind: 'permis', p_expires_at: '2099-01-01' });
  assert.ok((await S.disp.rpc('lg_trip_create', { p_vehicle: S.V.moto, p_courier: S.C.ibou })).ok);
  // contrôle avant départ : une case non conforme → alerte (une par jour et par véhicule)
  assert.equal((await S.driver.rpc('lg_vehicle_check', { p_vehicle: S.V.van, p_checklist: { pneus: true, freins: true }, p_odometer_km: 12000 })).conform, true);
  assert.equal((await S.dock.rpc('lg_vehicle_check', { p_vehicle: S.V.van, p_checklist: { pneus: true, feux: false } })).conform, false);
  await S.dock.rpc('lg_vehicle_check', { p_vehicle: S.V.van, p_checklist: { feux: false } });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'overload'").get().n, 1);
  assert.equal(await S.picker.rpcError('lg_vehicle_check', { p_vehicle: S.V.van, p_checklist: {} }), 'forbidden');
  // entretien : vidange à 300 km → « bientôt » ; au-delà → « dépassé »
  await S.dock.rpc('lg_log_maintenance', { p_vehicle: S.V.van, p_kind: 'vidange', p_odometer_km: 12100, p_cost_fcfa: 15000, p_note: 'Vidange', p_next_due_km: 12400 });
  let m = (await S.dock.rpc('lg_fleet')).find((v) => v.id === S.V.van).maintenance;
  assert.deepEqual([m.due_km, m.km, m.state, m.remaining_km], [12400, 12100, 'soon', 300]);
  assert.match(env.DB.db.prepare("SELECT message FROM alerts WHERE kind = 'maintenance_due'").get().message, /vidange dans 300 km/);
  await S.dock.rpc('lg_log_maintenance', { p_vehicle: S.V.van, p_kind: 'kilometrage', p_odometer_km: 12500, p_note: 'relevé' });
  m = (await S.dock.rpc('lg_fleet')).find((v) => v.id === S.V.van).maintenance;
  assert.deepEqual([m.state, m.remaining_km], ['overdue', -100]);
  assert.equal((await S.dock.rpc('lg_fleet')).find((v) => v.id === S.V.van).costs_30d_fcfa, 15000);
  // panne : le véhicule passe à l'atelier ; remis en service
  await S.dock.rpc('lg_log_maintenance', { p_vehicle: S.V.van, p_kind: 'panne', p_note: 'embrayage' });
  assert.equal((await S.dock.rpc('lg_fleet')).find((v) => v.id === S.V.van).status, 'maintenance');
  assert.equal(await S.disp.rpcError('lg_trip_create', { p_vehicle: S.V.van, p_courier: S.C.moussa }), 'vehicle_unavailable');
  assert.equal((await S.dock.rpc('lg_set_vehicle_status', { p_vehicle: S.V.van, p_status: 'available' })).ok, true);
});

test('voyage : création, affectation, chargement contrôlé avec jauge, plan de chargement, bordereau', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const A = await ready(S, [[S.P.rice, 2], [S.P.oil, 1]], { packages: (lines) => lines.map((l) => ({ weight_g: l.weight_g * l.qty_ordered, items: [{ order_item_id: l.order_item_id, quantity: l.qty_ordered }] })) });
  const tr = await S.disp.rpc('lg_trip_create', { p_vehicle: S.V.van, p_courier: S.C.moussa, p_label: 'Dakar → Rufisque' });
  assert.deepEqual([tr.ok, tr.number], [true, 1]);
  assert.equal(await S.disp.rpcError('lg_trip_create', { p_vehicle: S.V.van, p_courier: S.C.ibou }), 'vehicle_busy');
  assert.equal(await S.disp.rpcError('lg_trip_create', { p_vehicle: S.V.moto, p_courier: S.C.moussa }), 'courier_has_open_trip');
  assert.equal((await S.admin.rpc('lg_couriers_list')).find((c) => c.id === S.C.moussa).busy, true);
  const add = await S.disp.rpc('lg_trip_add_order', { p_trip: tr.trip_id, p_order: A.order.id });
  assert.deepEqual([add.packages, add.not_staged], [2, 0]);
  const view0 = await S.dock.rpc('lg_trip_loading_view', { p_trip: tr.trip_id });
  assert.equal(view0.stops[0].cod_due_fcfa, 0, 'payée d\'avance : rien à encaisser');
  assert.deepEqual([view0.gauge.planned, view0.gauge.loaded], [2, 0]);
  // chargement scanné
  // A.codes[0] = huile 1 kg (liquide), A.codes[1] = riz 10 kg
  const g = await S.dock.rpc('lg_load_package', { p_trip: tr.trip_id, p_code: A.codes[0], p_event: ev() });
  assert.deepEqual([g.ok, g.count, g.weight_pct, g.stop_seq], [true, 1, 0, 1]);
  assert.ok(g.warnings.includes('liquid_upright_bottom'));
  assert.equal((await S.dock.rpc('lg_load_package', { p_trip: tr.trip_id, p_code: A.codes[0], p_event: ev() })).error, 'already_loaded');
  assert.equal((await S.dock.rpc('lg_load_package', { p_trip: tr.trip_id, p_code: 'NXP-ZZZZZZ', p_event: ev() })).error, 'unknown_package');
  const seal0 = await S.dock.rpc('lg_trip_seal', { p_trip: tr.trip_id });
  assert.deepEqual([seal0.ok, seal0.error, seal0.codes], [false, 'unloaded_packages', [A.codes[1]]]);
  const g2 = await S.dock.rpc('lg_load_package', { p_trip: tr.trip_id, p_code: A.codes[1], p_event: ev() });
  assert.deepEqual([g2.count, g2.weight_pct, g2.weight_g], [2, 2, 10000]);
  // une 2e commande, pas encore chargée, puis retirée au contrôle de départ
  const B = await ready(S, [[S.P.rice, 1]], { zone: 'Yoff' });
  await S.disp.rpc('lg_trip_add_order', { p_trip: tr.trip_id, p_order: B.order.id });
  const view = await S.dock.rpc('lg_trip_loading_view', { p_trip: tr.trip_id });
  assert.deepEqual(view.stops.map((s) => s.seq), [1, 2]);
  // deux arrêts : le premier livré près de la porte, le second plus loin (fond à partir de 3 arrêts)
  assert.deepEqual([view.stops[0].packages[0].load_zone, view.stops[1].packages[0].load_zone], ['porte', 'milieu']);
  assert.deepEqual(view.stops[1].packages.map((p) => p.load_seq), [1], 'livré en dernier : chargé en premier');
  assert.equal((await S.dock.rpc('lg_unload_package', { p_trip: tr.trip_id, p_code: B.codes[0], p_event: ev(), p_reason: 'test' })).ok, true);
  // ordre des arrêts
  await S.disp.rpc('lg_trip_reorder', { p_trip: tr.trip_id, p_stop_ids: [view.stops[1].id, view.stops[0].id] });
  assert.deepEqual((await S.dock.rpc('lg_trip_loading_view', { p_trip: tr.trip_id })).stops.map((s) => s.order_id), [B.order.id, A.order.id]);
  assert.equal(await S.disp.rpcError('lg_trip_reorder', { p_trip: tr.trip_id, p_stop_ids: ['inconnu'] }), 'unknown_stop');
  // scellé : l'arrêt sans colis disparaît ; véhicule en voyage ; heures estimées calculées
  const seal = await S.dock.rpc('lg_trip_seal', { p_trip: tr.trip_id, p_signature_path: `${tr.trip_id}/sig.png` });
  assert.deepEqual([seal.ok, seal.trip.status, seal.trip.signed, seal.stops.length], [true, 'sealed', true, 1]);
  assert.ok(seal.stops[0].eta && seal.trip.distance_km > 0);
  assert.equal((await S.dock.rpc('lg_fleet')).find((v) => v.id === S.V.van).status, 'on_trip');
  assert.equal((await S.dock.rpc('lg_load_package', { p_trip: tr.trip_id, p_code: B.codes[0], p_event: ev() }).catch((e) => ({ error: e.code }))).error, 'trip_not_loading');
  // le chauffeur voit son voyage, pas celui d'un autre
  assert.equal((await S.driver.rpc('lg_trip_loading_view', { p_trip: tr.trip_id })).trip.number, 1);
  assert.equal(await S.driver2.rpcError('lg_trip_loading_view', { p_trip: tr.trip_id }), 'forbidden');
  const list = await S.dock.rpc('lg_trips_list', { p_scope: 'open' });
  assert.deepEqual([list[0].number, list[0].gauge.loaded, list[0].vehicle.plate, list[0].courier], [1, 2, 'DK-1234-A', 'Moussa']);
  const staged = await S.dock.rpc('lg_staged_packages');
  assert.deepEqual(staged.flatMap((z) => z.packages.map((p) => p.code)), [B.codes[0]], 'le colis retiré revient à quai');
});

test('chargement : surpoids, froid sans glacière, zone du voyage, colis déjà dans un autre voyage', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const heavy = await ready(S, [[S.P.rice, 7]]);  // 35 kg
  const fish = await ready(S, [[S.P.fish, 1]]);
  const moto = await S.disp.rpc('lg_trip_create', { p_vehicle: S.V.moto, p_courier: S.C.ibou, p_zones: ['Rufisque'] });
  assert.equal((await S.dock.rpc('lg_load_package', { p_trip: moto.trip_id, p_code: heavy.codes[0], p_event: ev() })).error, 'overweight');
  assert.equal((await S.dock.rpc('lg_load_package', { p_trip: moto.trip_id, p_code: fish.codes[0], p_event: ev() })).error, 'needs_cooler');
  const yoff = await ready(S, [[S.P.oil, 1]], { zone: 'Yoff' });
  assert.equal((await S.dock.rpc('lg_load_package', { p_trip: moto.trip_id, p_code: yoff.codes[0], p_event: ev() })).error, 'wrong_zone');
  assert.equal(await S.disp.rpcError('lg_trip_add_order', { p_trip: moto.trip_id, p_order: yoff.order.id }), 'wrong_zone');
  const van = await S.disp.rpc('lg_trip_create', { p_vehicle: S.V.van, p_courier: S.C.moussa });
  await S.disp.rpc('lg_trip_add_order', { p_trip: van.trip_id, p_order: heavy.order.id });
  assert.equal(await S.disp.rpcError('lg_trip_add_order', { p_trip: moto.trip_id, p_order: heavy.order.id }), 'order_in_other_trip');
  assert.equal((await S.dock.rpc('lg_load_package', { p_trip: moto.trip_id, p_code: heavy.codes[0], p_event: ev() })).error, 'in_other_trip');
  // retrait d'un arrêt : le colis redevient libre
  const v = await S.dock.rpc('lg_trip_loading_view', { p_trip: van.trip_id });
  await S.dock.rpc('lg_load_package', { p_trip: van.trip_id, p_code: heavy.codes[0], p_event: ev() });
  assert.equal((await S.disp.rpc('lg_trip_remove_stop', { p_trip: van.trip_id, p_stop: v.stops[0].id })).ok, true);
  assert.equal((await S.dock.rpc('lg_trip_loading_view', { p_trip: van.trip_id })).stops.length, 0);
  assert.equal(await S.dock.rpcError('lg_trip_seal', { p_trip: van.trip_id }), 'empty_trip');
  // annulation : véhicule et chauffeur libérés
  assert.equal((await S.disp.rpc('lg_trip_cancel', { p_trip: van.trip_id, p_reason: 'test' })).ok, true);
  assert.ok((await S.disp.rpc('lg_trip_create', { p_vehicle: S.V.van, p_courier: S.C.moussa })).ok);
});

test('suggestions et planification automatique : simulation sans effet, puis voyages créés, ordre calculé', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const spots = [['Rufisque', 14.716, -17.27], ['Bargny', 14.695, -17.225], ['Pikine', 14.755, -17.39], ['Yoff', 14.755, -17.473], ['Ouakam', 14.722, -17.49]];
  const orders = [];
  for (const [zone, lat, lng] of spots) orders.push((await ready(S, [[S.P.oil, 1]], { zone, lat, lng })).order.id);
  assert.equal(await S.picker.rpcError('lg_autoplan_run', { p_apply: false }), 'forbidden');
  const sim = await S.disp.rpc('lg_autoplan_run', { p_apply: false });
  assert.equal(sim.applied, false);
  assert.equal(sim.trips.reduce((s, x) => s + x.orders.length, 0), 5);
  assert.ok(sim.trips[0].label && sim.trips[0].fill_pct >= 0);
  assert.deepEqual(await S.dock.rpc('lg_trips_list', { p_scope: 'open' }), [], 'la simulation ne crée rien');
  const run = await S.disp.rpc('lg_autoplan_run', { p_apply: true });
  assert.equal(run.created.length, sim.trips.length);
  for (const tr of await S.dock.rpc('lg_trips_list', { p_scope: 'open' })) {
    const v = await S.dock.rpc('lg_trip_loading_view', { p_trip: tr.id });
    assert.deepEqual(v.stops.map((s) => s.seq), v.stops.map((_, i) => i + 1));
  }
  assert.equal((await S.disp.rpc('lg_autoplan_run', { p_apply: false })).trips.length, 0, 'plus rien à planifier');
  // suggestion : un voyage ouvert compatible, noté
  const extra = await ready(S, [[S.P.oil, 1]], { zone: 'Yoff', lat: 14.756, lng: -17.47 });
  const sug = await S.disp.rpc('lg_suggest_trips', { p_order: extra.order.id });
  assert.ok(sug.length >= 1 && sug[0].score > 0);
});

test('planification : le plafond d\'espèces répartit le paiement à la livraison sur plusieurs véhicules', async () => {
  const env = makeEnv();
  const S = await setup(env);
  await S.admin.rpc('lg_set_config', { p: { cash_limit_fcfa: 12000 } });
  for (const [zone, lat, lng] of [['Yoff', 14.755, -17.473], ['Ouakam', 14.722, -17.49], ['Mermoz', 14.708, -17.475]]) {
    await ready(S, [[S.P.rice, 1]], { zone, lat, lng, method: 'cod' });
  }
  const sim = await S.disp.rpc('lg_autoplan_run', { p_apply: false });
  for (const tr of sim.trips) assert.ok(tr.cod <= 12000, `${tr.plate} porterait ${tr.cod} F`);
  assert.ok(sim.trips.length + sim.unassigned.length >= 2);
});

test('quais : file d\'attente, un voyage par quai, quai libéré à l\'annulation', async () => {
  const env = makeEnv();
  const S = await setup(env);
  for (const code of ['q1', 'Q2']) await S.dock.rpc('lg_dock_upsert', { p: { code } });
  const A = (await S.disp.rpc('lg_trip_create', { p_vehicle: S.V.van, p_courier: S.C.moussa })).trip_id;
  const B = (await S.disp.rpc('lg_trip_create', { p_vehicle: S.V.moto, p_courier: S.C.ibou })).trip_id;
  assert.equal(await S.driver2.rpcError('lg_dock_checkin', { p_trip: A }), 'forbidden');
  assert.equal((await S.driver.rpc('lg_dock_checkin', { p_trip: A })).ok, true);
  await S.driver2.rpc('lg_dock_checkin', { p_trip: B });
  assert.equal((await S.driver2.rpc('lg_trip_dock', { p_trip: B })).position, 2);
  let board = await S.dock.rpc('lg_dock_board');
  assert.deepEqual(board.queue.map((q) => q.trip_id), [A, B]);
  const q1 = board.docks.find((k) => k.code === 'Q1').id;
  assert.equal((await S.dock.rpc('lg_dock_assign', { p_trip: A, p_dock: q1 })).dock, 'Q1');
  assert.equal((await S.dock.rpc('lg_dock_assign', { p_trip: B, p_dock: q1 })).error, 'dock_busy');
  assert.equal((await S.disp.rpc('lg_dock_assign', { p_trip: B })).dock, 'Q2', 'premier quai libre');
  assert.equal((await S.disp.rpc('lg_dock_assign', { p_trip: B })).dock, 'Q2', 'il garde le sien');
  assert.deepEqual(await S.driver.rpc('lg_trip_dock', { p_trip: A }).then((d) => [d.dock, d.position]), ['Q1', null]);
  board = await S.dock.rpc('lg_dock_board');
  assert.deepEqual([board.queue.length, board.docks.find((k) => k.code === 'Q1').trip.id], [0, A]);
  assert.equal(await S.driver.rpcError('lg_dock_assign', { p_trip: A, p_dock: q1 }), 'forbidden');
  await S.disp.rpc('lg_trip_cancel', { p_trip: A, p_reason: 'test' });
  assert.equal((await S.dock.rpc('lg_dock_board')).docks.find((k) => k.code === 'Q1').trip, null);
});

test('collecte chez le vendeur et dépôt au hub par le vendeur', async () => {
  const env = makeEnv();
  const S = await setup(env);
  await S.admin.rpc('lg_set_config', { p: { prep_at_vendor: true } });
  const vendor = await invite(env, S.admin, 'ndeye@boutique.sn', { role: 'vendor', name: 'Boutique Ndèye' });
  await vendor.rpc('lg_member_location', { p_address: 'Marché Sandaga', p_lat: 14.67, p_lng: -17.43 });
  const pr = await vendor.rpc('lg_product_upsert', { p: { name: 'Bissap', sku: 'BIS-1', price_fcfa: 2000, weight_g: 1000 } });
  const prepare = async () => {
    const o = await vendor.rpc('lg_order_create', { p_customer: { name: 'Client', phone: '770001122' }, p_zone: 'Yoff', p_items: [{ product_id: pr.id, quantity: 1 }], p_payment_method: 'prepaid' });
    const t = (await vendor.rpc('lg_pick_queue')).find((x) => x.order_id === o.id);
    await vendor.rpc('lg_pick_take', { p_task: t.id });
    await vendor.rpc('lg_pick_scan', { p_task: t.id, p_code: 'BIS-1', p_event: ev() });
    const code = (await vendor.rpc('lg_pack', { p_task: t.id, p_event: ev(), p_packages: [{ weight_g: 700 }] })).packages[0].code;
    await vendor.rpc('lg_stage', { p_code: code, p_event: ev() });
    return { o, code };
  };
  const one = await prepare();
  const pend = await S.disp.rpc('lg_pickups_pending');
  assert.deepEqual([pend.length, pend[0].packages, pend[0].vendor, pend[0].address], [1, 1, 'Boutique Ndèye', 'Marché Sandaga']);
  // collecte : arrêt chez le vendeur ; au retour, réception au hub par une autre personne que le chauffeur
  const tr = await S.disp.rpc('lg_trip_create', { p_vehicle: S.V.van, p_courier: S.C.moussa, p_kind: 'pickup' });
  const add = await S.disp.rpc('lg_trip_add_pickup', { p_trip: tr.trip_id, p_vendor: vendor.user.id });
  assert.equal(add.packages, 1);
  assert.equal(await S.disp.rpcError('lg_trip_add_pickup', { p_trip: tr.trip_id, p_vendor: vendor.user.id }), 'nothing_to_collect');
  assert.deepEqual(await S.disp.rpc('lg_pickups_pending'), []);
  // (le chargement chez le vendeur par le chauffeur, lg_collect, arrive au cycle C5 : simulé ici)
  env.DB.db.prepare("UPDATE trip_packages SET loaded_at = ? WHERE stop_id = ?").run(new Date().toISOString(), add.stop_id);
  env.DB.db.prepare("UPDATE packages SET status = 'loaded', holder_type = 'driver' WHERE code = ?").run(one.code);
  assert.equal((await S.dock.rpc('lg_receive', { p_code: one.code, p_event: ev(), p_weight_g: 720 })).next, 'staged');
  const card = await S.dock.rpc('lg_package_card', { p_code: one.code });
  assert.deepEqual([card.package.status, card.package.weight_g, card.holder.type], ['staged', 720, 'hub']);
  assert.equal((await S.dock.rpc('lg_receive', { p_code: one.code, p_event: ev() })).error, 'not_in_transit_to_hub');
  // dépôt : créneaux ouverts par le chef de quai, réservés par le vendeur → plus de collecte proposée
  const two = await prepare();
  assert.equal(await vendor.rpcError('lg_dropoff_slots_create', { p_from: tomorrow(), p_days: 1, p_times: ['09:00-11:00'], p_capacity: 2 }), 'forbidden');
  assert.equal((await S.dock.rpc('lg_dropoff_slots_create', { p_from: tomorrow(), p_days: 1, p_times: ['09:00-11:00', '14:00-16:00'], p_capacity: 2 })).slots, 2);
  const av = await vendor.rpc('lg_dropoff_available', {});
  assert.deepEqual([av.ready_packages, av.slots.length, av.booking], [1, 2, null]);
  const b1 = await vendor.rpc('lg_dropoff_book', { p_slot: av.slots[0].id });
  assert.deepEqual([b1.ok, b1.packages], [true, 1]);
  assert.deepEqual(await S.disp.rpc('lg_pickups_pending'), [], 'dépôt prévu : pas de chauffeur envoyé');
  const b2 = await vendor.rpc('lg_dropoff_book', { p_slot: av.slots[1].id });
  assert.equal((await vendor.rpc('lg_dropoff_available', {})).booking.id, b2.id, 'le nouveau créneau remplace l\'ancien');
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM dropoff_bookings WHERE status = 'booked'").get().n, 1);
  assert.equal(await S.driver.rpcError('lg_dropoff_book', { p_slot: av.slots[0].id }), 'forbidden');
  // le vendeur arrive aujourd'hui : réception directe
  env.DB.db.prepare("UPDATE dropoff_slots SET day = ?, start_time = '00:00', end_time = '23:59' WHERE id = ?").run(new Date().toISOString().slice(0, 10), av.slots[1].id);
  const r = await S.dock.rpc('lg_dropoff_receive', { p_code: two.code, p_event: ev(), p_weight_g: 710 });
  assert.deepEqual([r.ok, r.next, r.booked], [true, 'staged', true]);
  assert.deepEqual((await S.dock.rpc('lg_dropoffs_today')).map((x) => [x.status, x.received, x.packages]), [['arrived', 1, 1]]);
  assert.equal((await S.dock.rpc('lg_dropoff_receive', { p_code: two.code, p_event: ev() })).error, 'not_at_vendor');
  assert.equal((await vendor.rpc('lg_dropoff_cancel', { p_booking: b2.id })).error, 'bad_status');
});

test('créneaux de livraison : le client choisit depuis sa page de suivi', async () => {
  const env = makeEnv();
  const S = await setup(env);
  assert.equal((await S.disp.rpc('lg_create_slots', { p_zone: 'Yoff', p_from: tomorrow(), p_days: 2, p_times: ['09:00-12:00', '15:00-18:00'], p_capacity: 1 })).slots, 4);
  const o = await S.support.rpc('lg_order_create', { p_customer: { name: 'Awa', phone: '771112233' }, p_zone: 'Yoff', p_items: [{ name: 'Colis', quantity: 1 }] });
  const token = o.tracking_url.split('/').pop();
  const anon = new Client(env);
  const slots = await anon.rpc('lg_slots_available', { p_token: token });
  assert.equal(slots.length, 4);
  assert.deepEqual(await anon.rpc('lg_slots_available', { p_zone: 'Yoff' }), [], 'sans jeton ni session : rien');
  assert.equal((await anon.rpc('lg_track_book_slot', { p_token: token, p_slot: slots[0].id })).ok, true);
  assert.equal((await S.support.rpc('lg_order_detail', { p_order: o.id })).promised_at, `${slots[0].day}T12:00:00.000Z`);
  const o2 = await S.support.rpc('lg_order_create', { p_customer: { name: 'Bob', phone: '772223344' }, p_zone: 'Yoff', p_items: [{ name: 'Colis', quantity: 1 }] });
  assert.equal((await anon.rpc('lg_track_book_slot', { p_token: o2.tracking_url.split('/').pop(), p_slot: slots[0].id })).error, 'slot_unavailable', 'complet');
  // changer de créneau libère l'ancien
  await anon.rpc('lg_track_book_slot', { p_token: token, p_slot: slots[1].id });
  assert.equal((await anon.rpc('lg_track_book_slot', { p_token: o2.tracking_url.split('/').pop(), p_slot: slots[0].id })).ok, true);
});

test('isolation : une autre entreprise ne voit ni ne touche rien du cycle C4', async () => {
  const env = makeEnv();
  const A = await setup(env);
  const B = await setup(env, 'bob@rapide.sn', 'Rapide');
  const a = await ready(A, [[A.P.rice, 1]]);
  const tr = await A.disp.rpc('lg_trip_create', { p_vehicle: A.V.van, p_courier: A.C.moussa });
  await A.disp.rpc('lg_trip_add_order', { p_trip: tr.trip_id, p_order: a.order.id });
  await A.dock.rpc('lg_dock_upsert', { p: { code: 'Q1' } });
  const dockA = (await A.dock.rpc('lg_dock_board')).docks[0].id;
  // lectures : chacun ses véhicules (même plaque possible), ses voyages, ses quais
  assert.deepEqual((await B.dock.rpc('lg_fleet')).map((v) => v.id).filter((id) => id === A.V.van), []);
  assert.deepEqual(await B.dock.rpc('lg_trips_list', { p_scope: 'all' }), []);
  assert.deepEqual(await B.dock.rpc('lg_staged_packages'), []);
  assert.deepEqual((await B.dock.rpc('lg_dock_board')).docks, []);
  // écritures : même réponse qu'un objet inexistant
  for (const [fn, args, code] of [
    ['lg_trip_loading_view', { p_trip: tr.trip_id }, 'unknown_trip'],
    ['lg_trip_add_order', { p_trip: tr.trip_id, p_order: a.order.id }, 'unknown_trip'],
    ['lg_trip_seal', { p_trip: tr.trip_id }, 'unknown_trip'],
    ['lg_trip_cancel', { p_trip: tr.trip_id }, 'unknown_trip'],
    ['lg_trip_reorder', { p_trip: tr.trip_id, p_stop_ids: [] }, 'unknown_trip'],
    ['lg_dock_assign', { p_trip: tr.trip_id, p_dock: dockA }, 'unknown_trip'],
    ['lg_upsert_vehicle', { p: { id: A.V.van, plate: 'VOL', kind: 'moto', capacity_kg: 10 } }, 'unknown_vehicle'],
    ['lg_log_maintenance', { p_vehicle: A.V.van, p_kind: 'panne' }, 'unknown_vehicle'],
    ['lg_add_document', { p_vehicle: A.V.van, p_kind: 'assurance', p_expires_at: '2099-01-01' }, 'unknown_vehicle'],
    ['lg_vehicle_check', { p_vehicle: A.V.van, p_checklist: {} }, 'unknown_vehicle'],
    ['lg_trip_create', { p_vehicle: A.V.van, p_courier: B.C.moussa }, 'unknown_vehicle'],
    ['lg_trip_create', { p_vehicle: B.V.van, p_courier: A.C.moussa }, 'courier_not_active'],
    ['lg_suggest_trips', { p_order: a.order.id }, 'unknown_order'],
  ]) assert.equal(await B.dock.rpcError(fn, args), code, fn);
  assert.equal((await B.dock.rpc('lg_set_vehicle_status', { p_vehicle: A.V.van, p_status: 'retired' })).ok, false);
  const bt = await B.disp.rpc('lg_trip_create', { p_vehicle: B.V.van, p_courier: B.C.moussa });
  assert.equal(bt.number, 1, 'numéros de voyage propres à chaque entreprise');
  assert.equal(await B.disp.rpcError('lg_trip_add_order', { p_trip: bt.trip_id, p_order: a.order.id }), 'order_blocked');
  assert.equal((await B.dock.rpc('lg_load_package', { p_trip: bt.trip_id, p_code: a.codes[0], p_event: ev() })).error, 'unknown_package');
  // rien n'a bougé chez A
  assert.equal((await A.dock.rpc('lg_trip_loading_view', { p_trip: tr.trip_id })).stops.length, 1);
  assert.equal((await A.dock.rpc('lg_fleet')).find((v) => v.id === A.V.van).plate, 'DK-1234-A');
});

test('rôles : un préparateur ou un chauffeur ne pilote ni la flotte ni les voyages', async () => {
  const env = makeEnv();
  const S = await setup(env);
  for (const fn of ['lg_fleet', 'lg_upsert_vehicle', 'lg_set_vehicle_status', 'lg_add_document', 'lg_log_maintenance', 'lg_trips_list', 'lg_trip_create',
    'lg_trip_cancel', 'lg_trip_add_order', 'lg_trip_remove_stop', 'lg_load_package', 'lg_unload_package', 'lg_trip_seal', 'lg_pickups_pending', 'lg_trip_add_pickup',
    'lg_dock_upsert', 'lg_dock_assign', 'lg_dock_board', 'lg_dropoff_slots_create', 'lg_create_slots', 'lg_suggest_trips', 'lg_autoplan_run']) {
    assert.equal(await S.driver.rpcError(fn, {}), 'forbidden', `chauffeur : ${fn}`);
    assert.equal(await S.picker.rpcError(fn, {}), 'forbidden', `préparateur : ${fn}`);
  }
});
