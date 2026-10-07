// Une journée de démonstration, JOUÉE par les vraies fonctions (aucune donnée posée à la main
// dans les tables logistiques) : si le scénario passe, le parcours fonctionne.
// rpc(nom, args, uid) ; query(sql, params) pour simuler le site qui enregistre les commandes.

export const P = {
  admin: '00000000-0000-4000-a000-000000000001', picker: '00000000-0000-4000-a000-000000000002',
  dock: '00000000-0000-4000-a000-000000000003', dispatcher: '00000000-0000-4000-a000-000000000004',
  cashier: '00000000-0000-4000-a000-000000000005', moussa: '00000000-0000-4000-a000-000000000006',
  vendor: '00000000-0000-4000-a000-000000000007', support: '00000000-0000-4000-a000-000000000010',
  ibrahima: '00000000-0000-4000-a000-000000000009',
};
const VAN = '30000000-0000-4000-a000-000000000001';
const MOTO = '30000000-0000-4000-a000-000000000002';
const C_MOUSSA = '20000000-0000-4000-a000-000000000001';
const C_IBRA = '20000000-0000-4000-a000-000000000002';
const PR = { riz: '41000000-0000-4000-a000-000000000001', huile: '42000000-0000-4000-a000-000000000002',
  oeufs: '43000000-0000-4000-a000-000000000003', savon: '44000000-0000-4000-a000-000000000004',
  ventilo: '45000000-0000-4000-a000-000000000005' };

// Commandes fictives : [client, zone, lat, lng, repère, mode, lignes]
const ORDERS = [
  ['Awa Diop', 'Rufisque', 14.7161, -17.2701, 'Keury Souf, face pharmacie', 'cod', [['riz', 2], ['huile', 1], ['oeufs', 1]]],
  ['Ibrahima Sarr', 'Rufisque', 14.7189, -17.2795, 'Arafat, derrière la mosquée', 'cod', [['ventilo', 1]]],
  ['Ndèye Fall', 'Bargny', 14.6952, -17.2244, 'près du marché', 'mobile', [['savon', 3], ['huile', 2]]],
  ['Moussa Kane', 'Diamniadio', 14.7275, -17.1838, 'cité Sipres', 'cod', [['riz', 1]]],
  ['Fatou Ndiaye', 'Pikine', 14.7541, -17.3912, 'Pikine Icotaf, boutique Cheikh', 'cod', [['huile', 3]]],
  ['Mamadou Ba', 'Pikine', 14.7566, -17.3865, 'Tally Boubess', 'mobile', [['riz', 2]]],
  ['Aminata Sow', 'Parcelles', 14.7668, -17.4301, 'Unité 15, rond-point', 'cod', [['savon', 2], ['oeufs', 1]]],
  ['Cheikh Gueye', 'Yoff', 14.7549, -17.4731, 'cité Djily Mbaye', 'mobile', [['ventilo', 1], ['huile', 1]]],
  ['Khady Mbaye', 'Mermoz', 14.7083, -17.4751, 'Mermoz pyrotechnie', 'cod', [['riz', 1], ['savon', 1]]],
  ['Ousmane Diallo', 'Médina', 14.6829, -17.4538, 'rue 11 x 22', 'cod', [['huile', 1]]],
  ['Rokhaya Thiam', 'Ouakam', 14.7221, -17.4902, 'cité Avion', 'cod', [['oeufs', 2]]],
  ['Babacar Faye', 'Guédiawaye', 14.7702, -17.4061, 'Golf Sud', 'cod', [['riz', 3]]],
];

export async function runScenario(rpc, query) {
  const ev = () => crypto.randomUUID();
  const now = new Date();

  // 1. réglages, tarifs, flotte
  await rpc('lg_set_config', { p: { manager_phone: '+221770000001', tracking_base_url: globalThis.location?.origin ? `${globalThis.location.origin}/suivi/` : undefined } }, P.admin);
  for (const r of [
    { max_weight_g: 20000, price_fcfa: 1500 }, { max_weight_g: 150000, price_fcfa: 4000, vehicle_kind: 'tricycle' },
    { zone: 'Rufisque', max_weight_g: 20000, price_fcfa: 2500 }, { zone: 'Bargny', max_weight_g: 20000, price_fcfa: 3000 },
    { zone: 'Diamniadio', max_weight_g: 20000, price_fcfa: 3000 }, { zone: 'Thiès', max_weight_g: 20000, price_fcfa: 5000, lead_hours: 48 },
    { zone: 'Mbour', max_weight_g: 20000, price_fcfa: 5000, lead_hours: 48 },
    { max_weight_g: 20000, price_fcfa: 3000, service: 'express', lead_hours: 3 },
  ]) await rpc('lg_upsert_rate_card', { p: r }, P.admin);
  await rpc('lg_set_zone', { p_zone: 'Dakar-Plateau', p: { free_above_fcfa: 30000 } }, P.admin);
  await rpc('lg_upsert_pay_rule', { p: { per_package: 500, bonus_zero_failure: 1000 } }, P.admin);
  const d = (days) => new Date(now.getTime() + days * 864e5).toISOString().slice(0, 10);
  await rpc('lg_add_document', { p_vehicle: VAN, p_courier: null, p_kind: 'assurance', p_number: 'ASK-2026-4471', p_expires_at: d(10) }, P.admin);
  await rpc('lg_add_document', { p_vehicle: VAN, p_courier: null, p_kind: 'visite_technique', p_number: 'VT-88213', p_expires_at: d(140) }, P.admin);
  await rpc('lg_add_document', { p_vehicle: MOTO, p_courier: null, p_kind: 'assurance', p_number: 'ASK-2026-5120', p_expires_at: d(200) }, P.admin);
  await rpc('lg_add_document', { p_vehicle: null, p_courier: C_MOUSSA, p_kind: 'permis', p_number: 'SN-B-1029384', p_expires_at: d(700) }, P.admin);
  await rpc('lg_create_slots', { p_zone: 'Rufisque', p_from: d(1), p_days: 3, p_times: ['09:00-12:00', '15:00-18:00'], p_capacity: 8 }, P.dispatcher);

  // 2. le site enregistre les commandes (comme la prod : panier JSON, prix en EUR)
  const ids = [];
  for (const [name, zone, lat, lng, landmark, method, lines] of ORDERS) {
    const products = lines.map(([k, q]) => ({ id: PR[k], quantity: q }));
    const { rows } = await query(
      `with x as (select (e->>'id')::uuid id, (e->>'quantity')::int q from jsonb_array_elements($1::jsonb) e),
            p as (select jsonb_agg(jsonb_build_object('id', x.id, 'quantity', x.q, 'price', pr.price, 'name', pr.name)) j,
                         sum(pr.price * x.q) s from x join public.products pr on pr.id = x.id)
       insert into public.orders (status, payment_status, payment_method, products, total, subtotal, buyer_name, buyer_phone,
                                  buyer_address, shipping_city, delivery_zone, vendor_id, vendor_name, delivery_lat, delivery_lng,
                                  landmark, delivery_fee_fcfa, mobile_money_ref, promised_at)
       select 'pending', case when $2 = 'mobile' then 'paid' else 'pending' end, $2, p.j, p.s, p.s, $3,
              '+22177' || lpad((floor(random() * 10000000))::int::text, 7, '0'), null, $5, $5,
              '00000000-0000-4000-a000-000000000007', 'Boutique Ndèye', $6, $7, $4,
              case when $5 in ('Rufisque', 'Bargny', 'Diamniadio') then 2500 else 1500 end,
              case when $2 = 'mobile' then 'PT-' || upper(substr(md5(random()::text), 1, 8)) end, now() + interval '8 hours'
         from p returning id`,
      [JSON.stringify(products), method, name, landmark, zone, lat, lng]);
    ids.push(rows[0].id);
  }

  // 3. confirmations du paiement à la livraison (deux restent à appeler)
  for (let i = 0; i < ids.length; i++) {
    if (ORDERS[i][5] === 'cod' && i !== 10 && i !== 11) await rpc('lg_confirm_cod', { p_order: ids[i], p_via: i % 2 ? 'appel' : 'whatsapp' }, P.support);
  }

  // 4. préparation : scan de chaque unité, une rupture d'œufs sur la commande d'Aminata
  const prepared = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (const i of prepared) {
    const task = (await query('select id from lg_pick_tasks where order_id = $1', [ids[i]])).rows[0].id;
    await rpc('lg_pick_take', { p_task: task }, P.picker);
    const detail = await rpc('lg_pick_task_detail', { p_task: task }, P.picker);
    for (const l of detail.lines) {
      if (i === 6 && l.name.startsWith('Œufs')) { await rpc('lg_pick_short', { p_task: task, p_line: l.id, p_qty_found: 0, p_event: ev() }, P.picker); continue; }
      for (let q = 0; q < l.qty_ordered; q++) {
        if (l.barcode) await rpc('lg_pick_scan', { p_task: task, p_code: l.barcode, p_event: ev() }, P.picker);
        else await rpc('lg_pick_scan', { p_task: task, p_code: '', p_event: ev(), p_manual: true, p_line: l.id }, P.picker);
      }
    }
    const weight = detail.lines.reduce((s, l) => s + (l.weight_g ?? 500) * (l.status === 'short' ? 0 : l.qty_ordered), 0) + 150;
    const packed = await rpc('lg_pack', { p_task: task, p_event: ev(), p_packages: [{ weight_g: Math.max(weight, 300), length_cm: 40, width_cm: 30, height_cm: 25 }] }, P.picker);
    for (const pk of packed.packages) await rpc('lg_stage', { p_code: pk.code, p_event: ev() }, P.picker);
  }
  // une commande en cours de préparation (prise, 1 article scanné)
  const t9 = (await query('select id from lg_pick_tasks where order_id = $1', [ids[9]])).rows[0].id;
  await rpc('lg_pick_take', { p_task: t9 }, P.picker);

  // 5. voyage n° 1 — fourgonnette de Moussa vers l'est : chargé, parti, 1 livré, 1 échec
  const tripA = (await rpc('lg_trip_create', { p_vehicle: VAN, p_courier: C_MOUSSA, p_label: 'Dakar → Rufisque · Diamniadio',
    p_departure: new Date(now.getTime() - 2 * 3600e3).toISOString() }, P.dispatcher)).trip_id;
  for (const i of [0, 1, 2, 3, 4]) await rpc('lg_trip_add_order', { p_trip: tripA, p_order: ids[i] }, P.dispatcher);
  const viewA = await rpc('lg_trip_loading_view', { p_trip: tripA }, P.dock);
  // ordre des arrêts : Pikine, Rufisque, Rufisque, Bargny, Diamniadio
  const order = [...viewA.stops].sort((a, b) => a.lng - b.lng).map((s) => s.id);
  await rpc('lg_trip_reorder', { p_trip: tripA, p_stop_ids: order }, P.dispatcher);
  for (const s of viewA.stops) for (const p of s.packages)
    await rpc('lg_load_package', { p_trip: tripA, p_code: p.code, p_event: ev(), p_device_at: new Date().toISOString() }, P.dock);
  await rpc('lg_vehicle_check', { p_vehicle: VAN, p_checklist: { pneus: true, freins: true, feux: true, carburant: true, documents: true, caisson: true }, p_odometer_km: 48210, p_trip: tripA }, P.dock);
  await rpc('lg_trip_seal', { p_trip: tripA, p_signature_path: 'demo/signature-moussa.png' }, P.dock);
  await rpc('lg_trip_start', { p_trip: tripA, p_event: ev(), p_lat: 14.7065, p_lng: -17.4355 }, P.moussa);
  let day = await rpc('lg_my_day', {}, P.moussa);
  let stops = day.trips[0].stops;
  // arrêt 1 livré (code du client lu dans le message envoyé)
  const s1 = stops[0];
  const otp = (await query("select vars->>'code' c from notification_outbox where event_key = 'lg_out_for_delivery' and vars->>'commande' = upper(left($1::text, 8))", [s1.order_id])).rows[0].c;
  await rpc('lg_stop_arrive', { p_stop: s1.id, p_event: ev(), p_lat: s1.lat, p_lng: s1.lng }, P.moussa);
  await rpc('lg_deliver', { p_stop: s1.id, p_event: ev(), p_codes: s1.packages.map((p) => p.code), p_otp: otp,
    p_payments: s1.cod_due_fcfa ? [{ method: 'cash', amount: s1.cod_due_fcfa }] : [], p_photo_path: 'demo/photo-livraison-1.jpg',
    p_lat: s1.lat + 0.0002, p_lng: s1.lng - 0.0001 }, P.moussa);
  // arrêt 2 : client absent après appel
  const s2 = stops[1];
  await rpc('lg_stop_arrive', { p_stop: s2.id, p_event: ev(), p_lat: s2.lat, p_lng: s2.lng }, P.moussa);
  await rpc('lg_stop_call', { p_stop: s2.id }, P.moussa);
  await rpc('lg_fail', { p_stop: s2.id, p_event: ev(), p_reason: 'absent', p_photo_path: 'demo/photo-echec-2.jpg',
    p_lat: s2.lat, p_lng: s2.lng, p_note: 'Portail fermé, voisin absent' }, P.moussa);
  day = await rpc('lg_my_day', {}, P.moussa);
  const next = day.trips[0].stops.find((s) => s.status === 'en_route');
  if (next) await rpc('lg_driver_ping', { p_lat: (s2.lat + next.lat) / 2, p_lng: (s2.lng + next.lng) / 2 }, P.moussa);

  // 6. voyage n° 2 — moto d'Ibrahima, en cours de chargement (Parcelles, Yoff)
  const tripB = (await rpc('lg_trip_create', { p_vehicle: MOTO, p_courier: C_IBRA, p_label: 'Parcelles · Yoff',
    p_departure: new Date(now.getTime() + 3600e3).toISOString() }, P.dispatcher)).trip_id;
  for (const i of [6, 7]) await rpc('lg_trip_add_order', { p_trip: tripB, p_order: ids[i] }, P.dispatcher);
  const viewB = await rpc('lg_trip_loading_view', { p_trip: tripB }, P.dock);
  await rpc('lg_load_package', { p_trip: tripB, p_code: viewB.stops[0].packages[0].code, p_event: ev(), p_device_at: new Date().toISOString() }, P.dock);

  // 7. reste à affecter : Pikine (Mamadou) et Mermoz (Khady) sont à quai
  // 8. un incident ouvert, une demande client
  await rpc('lg_open_incident', { p_kind: 'damaged', p_description: 'Carton de savon écrasé à la réception', p_code: null, p_severity: 'normal' }, P.dock);
  const tok = (await query('select tracking_token from orders where id = $1', [ids[1]])).rows[0].tracking_token;
  await rpc('lg_track_request', { p_token: tok, p_kind: 'reschedule', p_payload: { choice: 'demain', message: 'Je serai là après 17 h' } }, null);
  await rpc('lg_watchdog', {}, null);

  // 9. historique de 4 semaines (prévision) : volume plus fort le vendredi (Louma) et le samedi
  await query(`insert into public.orders (status, payment_status, payment_method, total, buyer_name, delivery_zone, created_at)
    select 'delivered', 'paid', 'mobile', 12, 'Historique', z, d + time '11:00'
      from generate_series(1, 28) g, lateral (select ((now() at time zone 'Africa/Dakar')::date - g) d) dd,
           lateral unnest(array['Rufisque', 'Pikine', 'Parcelles', 'Yoff', 'Mermoz', 'Médina', 'Guédiawaye']) z,
           lateral generate_series(1, case extract(dow from d) when 5 then 3 when 6 then 2 when 0 then 0 else 1 end) n`);
  const friday = new Date(); friday.setDate(friday.getDate() + ((5 - friday.getDay() + 7) % 7 || 7));
  await rpc('lg_set_config', { p: { peak_days: [{ date: friday.toISOString().slice(0, 10), label: 'Louma du vendredi', factor: 1.5 }] } }, P.admin);
  return { orders: ids, trips: [tripA, tripB] };
}
