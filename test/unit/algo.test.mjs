import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, isPoint, optimizeRoute, gauge, loadPlan, compatibility, etas, rankTrips, cashGap, driverPay,
  normalizeCode, isPackageCode, fcfa, formatF } from '../../src/lib/algo.js';

const HUB = { lat: 14.7065, lng: -17.4355 };
const Z = { // zones réelles (delivery_zones)
  Plateau: { lat: 14.67, lng: -17.438 }, Medina: { lat: 14.683, lng: -17.454 }, Mermoz: { lat: 14.708, lng: -17.475 },
  Ouakam: { lat: 14.722, lng: -17.49 }, Yoff: { lat: 14.755, lng: -17.473 }, Parcelles: { lat: 14.767, lng: -17.429 },
  Pikine: { lat: 14.755, lng: -17.39 }, Rufisque: { lat: 14.715, lng: -17.273 },
};

test('haversine : Plateau → Rufisque ≈ 18 km ; points nuls rejetés', () => {
  const d = haversine(Z.Plateau, Z.Rufisque);
  assert.ok(d > 17000 && d < 19000, String(d));
  assert.equal(haversine({ lat: null, lng: null }, Z.Yoff), null);
  assert.equal(isPoint({ lat: 0, lng: 0 }), false, 'Number(null) === 0 ne doit pas devenir un arrêt');
  assert.equal(isPoint({ lat: '14.7', lng: '-17.4' }), true);
});

test('optimizeRoute : ne fait jamais pire que l\'ordre de saisie, arrêts sans GPS à la fin', () => {
  const stops = [Z.Rufisque, Z.Ouakam, Z.Pikine, Z.Plateau, Z.Yoff, Z.Medina, Z.Parcelles, Z.Mermoz]
    .map((p, i) => ({ id: `s${i}`, ...p }));
  stops.push({ id: 'nogps', lat: null, lng: null });
  const r = optimizeRoute(HUB, stops);
  assert.equal(r.order.length, 9);
  assert.equal(r.order.at(-1), 'nogps');
  // ordre de saisie : hub → s0 → s1 → … → s7, mêmes règles de distance
  let naive = 0; let prev = HUB;
  for (const s of stops.slice(0, 8)) { naive += haversine(prev, s) / 1000 * 1.35; prev = s; }
  assert.ok(r.km <= naive, `${r.km} > ${naive}`);
  // tournée raisonnable : moins de 70 km pour 8 quartiers de Dakar à Rufisque
  assert.ok(r.km < 70, String(r.km));
  // Rufisque est le plus loin : il ne doit pas être au milieu de la tournée urbaine
  const iRuf = r.order.indexOf('s0');
  assert.ok(iRuf === 0 || iRuf >= 6, `Rufisque en position ${iRuf}`);
});

test('optimizeRoute : une collecte reste avant sa livraison (P2)', () => {
  const stops = [
    { id: 'livraison', ...Z.Ouakam },
    { id: 'collecte', ...Z.Pikine, mustBefore: 'livraison' },
    { id: 'autre', ...Z.Mermoz },
  ];
  const r = optimizeRoute(HUB, stops);
  assert.ok(r.order.indexOf('collecte') < r.order.indexOf('livraison'), r.order.join(','));
});

test('gauge : la mesure la plus contraignante décide (exemple corrigé du dossier)', () => {
  const g = gauge({ weightG: 15000, volumeL: 600, count: 12 }, { capacityKg: 100, capacityL: 1000, maxPackages: 40 });
  assert.equal(g.weightPct, 15);
  assert.equal(g.fillPct, 60);
  assert.equal(g.limiting, 'volume');
  assert.equal(gauge({ weightG: 95000 }, { capacityKg: 100 }).alert, true);
  assert.equal(gauge({ weightG: 100000 }, { capacityKg: 100 }).blocked, true);
});

test('compatibilité (annexe C)', () => {
  assert.equal(compatibility(['alimentaire'], ['chimique']), 'separate');
  assert.equal(compatibility(['vivant'], ['fragile']), 'forbidden');
  assert.equal(compatibility(['liquide'], ['fragile']), 'liquid_below');
  assert.equal(compatibility(['fragile'], ['alimentaire']), 'ok');
});

test('loadPlan : dernier livré au fond, fragile en haut, lourd près de la porte signalé', () => {
  const pk = [
    { code: 'A', stopSeq: 1, weightG: 2000, handling: ['fragile'] },
    { code: 'B', stopSeq: 1, weightG: 20000, handling: [] },
    { code: 'C', stopSeq: 2, weightG: 3000, handling: [] },
    { code: 'D', stopSeq: 3, weightG: 5000, handling: ['liquide'] },
    { code: 'E', stopSeq: 3, weightG: 1000, handling: ['chimique'] },
    { code: 'F', stopSeq: 2, weightG: 1000, handling: ['alimentaire'] },
  ];
  const { plan, warnings } = loadPlan(pk, { kind: 'fourgonnette' });
  const by = Object.fromEntries(plan.map((p) => [p.code, p]));
  assert.equal(plan[0].stopSeq, 3, 'chargé en premier = dernier arrêt');
  assert.equal(by.D.zone, 'fond'); assert.equal(by.A.zone, 'porte');
  assert.equal(by.A.layer, 'haut'); assert.equal(by.D.layer, 'bas');
  assert.ok(by.B.loadSeq < by.A.loadSeq, 'lourd avant fragile dans la même zone');
  assert.ok(warnings.some((w) => w.kind === 'heavy_near_door' && w.code === 'B'));
  assert.ok(warnings.some((w) => w.kind === 'separate'));
  assert.equal(loadPlan(pk, { kind: 'moto' }).plan[0].zone, 'caisson');
});

test('etas : croissantes, temps sur place compris', () => {
  const now = Date.parse('2026-10-07T09:00:00Z');
  const r = etas(HUB, [{ id: 1, ...Z.Medina }, { id: 2, ...Z.Plateau }], { now });
  assert.ok(r[0].eta.getTime() > now);
  assert.ok(r[1].eta.getTime() - r[0].eta.getTime() >= 8 * 60000);
});

test('rankTrips : éliminatoires puis note', () => {
  const order = { ...Z.Yoff, weightG: 5000, volumeL: 20, count: 1, handling: ['froid'], codFcfa: 20000, zone: 'Yoff' };
  const trips = [
    { id: 'moto', zones: [], vehicle: { kind: 'moto', capacityKg: 40, capacityL: 90, maxPackages: 6, equipment: [] }, load: { weightG: 0, volumeL: 0, count: 0 }, stops: [], codFcfa: 0 },
    { id: 'tri', zones: [], vehicle: { kind: 'tricycle', capacityKg: 300, capacityL: 1200, maxPackages: 20, equipment: ['glacière'] }, load: { weightG: 100000, volumeL: 100, count: 5 }, stops: [{ ...Z.Ouakam }], codFcfa: 0 },
    { id: 'tri2', zones: [], vehicle: { kind: 'tricycle', capacityKg: 300, capacityL: 1200, maxPackages: 20, equipment: ['glacière'] }, load: { weightG: 10000, volumeL: 10, count: 1 }, stops: [{ ...Z.Rufisque }], codFcfa: 0 },
    { id: 'cash', zones: [], vehicle: { kind: 'voiture', capacityKg: 300, equipment: ['glacière'] }, load: { weightG: 0, volumeL: 0, count: 0 }, stops: [], codFcfa: 140000, cashLimitFcfa: 150000 },
  ];
  const r = rankTrips(order, trips);
  assert.equal(r[0].id, 'tri', 'le plus proche et le plus rempli');
  assert.deepEqual(r.find((x) => x.id === 'moto').reasons, ['glacière']);
  assert.deepEqual(r.find((x) => x.id === 'cash').reasons, ['espèces']);
});

test('caisse et rémunération', () => {
  assert.deepEqual(cashGap([{ method: 'cash', amount: 12500 }, { method: 'wave', amount: 3000 }], 12000),
    { expected: 12500, remitted: 12000, gap: -500 });
  assert.equal(driverPay({ delivered: 8, failed: 0 }, { perPackage: 500, bonusZeroFailure: 1000 }).total, 5000);
  assert.equal(driverPay({ delivered: 8, failed: 1 }, { perPackage: 500, bonusZeroFailure: 1000 }, 500).total, 3500);
});

test('codes colis et montants', () => {
  assert.equal(normalizeCode('nxp7k4m2q'), 'NXP-7K4M2Q');
  assert.equal(normalizeCode('7k4m2q'), 'NXP-7K4M2Q');
  assert.equal(isPackageCode('NXP-7K4M2Q'), true);
  assert.equal(isPackageCode('6111234500017'), false, 'un code-barres produit n\'est pas un colis');
  assert.equal(isPackageCode('NXP-7K4M0Q'), false, '0 exclu de l\'alphabet');
  assert.equal(fcfa(34.99), 22952);
  assert.equal(formatF(47500), '47 500 F');
});
