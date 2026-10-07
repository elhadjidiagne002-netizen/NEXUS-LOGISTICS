// Algorithmes et règles de calcul (dossier v2.0, chapitre 10).
// Aucune IA : des règles simples, appliquées systématiquement. Pur JS, sans
// dépendance, utilisé par l'app (téléphone du répartiteur) et testé en Node.

export const DETOUR = 1.35; // coefficient de détour par défaut (à régler sur les premières tournées)

const rad = (d) => (d * Math.PI) / 180;

/** Distance à vol d'oiseau en mètres. Accepte {lat, lng}. */
export function haversine(a, b) {
  if (!isPoint(a) || !isPoint(b)) return null;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Un point valide. Number(null) === 0 placerait un arrêt au large du golfe de Guinée. */
export function isPoint(p) {
  return !!p && p.lat !== null && p.lng !== null && p.lat !== undefined && p.lng !== undefined
    && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
    && !(Number(p.lat) === 0 && Number(p.lng) === 0);
}

/** Distance routière estimée en km (vol d'oiseau × détour). */
export function roadKm(a, b, detour = DETOUR) {
  const m = haversine(a, b);
  return m === null ? null : (m / 1000) * detour;
}

function tourLength(start, pts, order, dist, closed) {
  let len = 0;
  let prev = start;
  for (const i of order) { len += dist(prev, pts[i]); prev = pts[i]; }
  if (closed) len += dist(prev, start);
  return len;
}

/**
 * Ordre des arrêts : plus proche voisin depuis le hub, puis 2-opt tant que ça raccourcit.
 * Sur 10 à 20 arrêts, proche de l'optimum, instantané.
 * @param {{lat,lng}} start  point de départ (hub ou position du chauffeur)
 * @param {Array<{id, lat, lng, mustBefore?: string}>} stops  arrêts ; ceux sans position vont à la fin
 * @param {{returnToStart?: boolean, detour?: number}} opts
 * @returns {{order: string[], km: number}}
 */
export function optimizeRoute(start, stops, opts = {}) {
  const { returnToStart = false, detour = DETOUR } = opts;
  const located = stops.filter(isPoint);
  const unlocated = stops.filter((s) => !isPoint(s));
  const dist = (a, b) => (haversine(a, b) / 1000) * detour;
  const n = located.length;
  if (n === 0) return { order: unlocated.map((s) => s.id), km: 0 };
  const origin = isPoint(start) ? start : located[0];

  // 1. plus proche voisin
  const left = new Set(located.map((_, i) => i));
  const order = [];
  let cur = origin;
  while (left.size) {
    let best = -1; let bestD = Infinity;
    for (const i of left) { const d = dist(cur, located[i]); if (d < bestD) { bestD = d; best = i; } }
    order.push(best); left.delete(best); cur = located[best];
  }

  // 2. 2-opt : inverser une portion tant que la tournée raccourcit
  let improved = true; let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const candidate = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
        if (!respectsPrecedence(candidate, located)) continue;
        if (tourLength(origin, located, candidate, dist, returnToStart) + 1e-9 < tourLength(origin, located, order, dist, returnToStart)) {
          order.splice(0, n, ...candidate); improved = true;
        }
      }
    }
  }
  fixPrecedence(order, located);
  return {
    order: order.map((i) => located[i].id).concat(unlocated.map((s) => s.id)),
    km: Math.round(tourLength(origin, located, order, dist, returnToStart) * 10) / 10,
  };
}

// P2 : une collecte doit précéder la livraison correspondante (mustBefore = id de l'arrêt à précéder)
function respectsPrecedence(order, pts) {
  const pos = new Map(order.map((idx, p) => [pts[idx].id, p]));
  return pts.every((s) => !s.mustBefore || !pos.has(s.mustBefore) || pos.get(s.id) < pos.get(s.mustBefore));
}
function fixPrecedence(order, pts) {
  for (let guard = 0; guard < order.length && !respectsPrecedence(order, pts); guard++) {
    for (const s of pts) {
      if (!s.mustBefore) continue;
      const a = order.findIndex((i) => pts[i].id === s.id);
      const b = order.findIndex((i) => pts[i].id === s.mustBefore);
      if (a > b && b >= 0) { const [x] = order.splice(a, 1); order.splice(b, 0, x); }
    }
  }
}

/**
 * Taux de remplissage : le plus élevé des trois mesures (poids, volume, nombre).
 * « 15 kg sur 100 », c'est 15 % du poids — un véhicule peut être plein en volume bien avant.
 */
export function gauge({ weightG = 0, volumeL = 0, count = 0 }, { capacityKg, capacityL, maxPackages }) {
  const weightPct = capacityKg ? Math.round((100 * weightG) / (capacityKg * 1000)) : 0;
  const volumePct = capacityL ? Math.round((100 * volumeL) / capacityL) : null;
  const countPct = maxPackages ? Math.round((100 * count) / maxPackages) : null;
  const fillPct = Math.max(weightPct, volumePct ?? 0, countPct ?? 0);
  const limiting = fillPct === weightPct ? 'poids' : fillPct === (volumePct ?? -1) ? 'volume' : 'colis';
  return { weightPct, volumePct, countPct, fillPct, limiting, alert: fillPct >= 90, blocked: weightPct >= 100 };
}

// Annexe C : incompatibilités de chargement
const MATRIX = {
  alimentaire: { chimique: 'separate', liquide: 'liquid_below', vivant: 'forbidden' },
  chimique: { alimentaire: 'separate', vivant: 'forbidden' },
  liquide: { alimentaire: 'liquid_below', fragile: 'liquid_below', vivant: 'forbidden' },
  fragile: { liquide: 'liquid_below', vivant: 'forbidden' },
  vivant: { alimentaire: 'forbidden', chimique: 'forbidden', liquide: 'forbidden', fragile: 'forbidden' },
};

/** Règle entre deux ensembles de mentions : 'ok' | 'separate' | 'liquid_below' | 'forbidden'. */
export function compatibility(handlingA = [], handlingB = []) {
  const rank = { ok: 0, liquid_below: 1, separate: 2, forbidden: 3 };
  let worst = 'ok';
  for (const a of handlingA) for (const b of handlingB) {
    const r = MATRIX[a]?.[b] ?? 'ok';
    if (rank[r] > rank[worst]) worst = r;
  }
  return worst;
}

/**
 * Plan de chargement (chapitre 10) :
 * 1. dernier livré, premier chargé (fond) ; 2. lourd en bas, fragile en haut ;
 * 3. incompatibles séparés. Si deux règles se contredisent, la sécurité l'emporte et on prévient.
 * @param {Array<{code, stopSeq, weightG, handling}>} packages
 * @param {{kind: string, heavyKg?: number}} vehicle
 */
export function loadPlan(packages, vehicle, { heavyKg = 15 } = {}) {
  const seqs = [...new Set(packages.map((p) => p.stopSeq))].sort((a, b) => a - b);
  const nStops = seqs.length;
  const twoWheels = ['moto', 'vélo'].includes(vehicle.kind);
  const zoneOf = (seq) => {
    if (twoWheels) return 'caisson';
    const rank = seqs.indexOf(seq) + 1;
    if (rank > Math.ceil((nStops * 2) / 3)) return 'fond';
    if (rank > Math.ceil(nStops / 3)) return 'milieu';
    return 'porte';
  };
  const sorted = [...packages].sort((a, b) =>
    b.stopSeq - a.stopSeq
    || Number((a.handling ?? []).includes('fragile')) - Number((b.handling ?? []).includes('fragile'))
    || (b.weightG ?? 0) - (a.weightG ?? 0));
  const warnings = [];
  const plan = sorted.map((p, i) => {
    const zone = zoneOf(p.stopSeq);
    const heavy = (p.weightG ?? 0) >= heavyKg * 1000 || (p.handling ?? []).includes('lourd');
    let layer = (p.handling ?? []).includes('fragile') ? 'haut' : heavy || (p.handling ?? []).includes('liquide') ? 'bas' : 'milieu';
    if (heavy && zone === 'porte' && !twoWheels) {
      warnings.push({ code: p.code, kind: 'heavy_near_door', message: `Colis lourd pour l'arrêt ${p.stopSeq} : à déplacer en cours de tournée` });
    }
    if ((p.handling ?? []).includes('fragile') && heavy) layer = 'bas';
    return { code: p.code, loadSeq: i + 1, zone, layer, stopSeq: p.stopSeq };
  });
  for (let i = 0; i < packages.length; i++) for (let j = i + 1; j < packages.length; j++) {
    const r = compatibility(packages[i].handling, packages[j].handling);
    if (r === 'forbidden') warnings.push({ code: packages[j].code, kind: 'forbidden', message: `${packages[i].code} et ${packages[j].code} ne voyagent pas ensemble` });
    else if (r === 'separate') warnings.push({ code: packages[j].code, kind: 'separate', message: `Séparer ${packages[i].code} et ${packages[j].code} (alimentaire / entretien)` });
  }
  return { plan, warnings };
}

/**
 * Heure d'arrivée estimée de chaque arrêt restant :
 * maintenant + trajets + temps moyen sur place × arrêts intermédiaires.
 */
export function etas(from, stops, { now = Date.now(), speedKmh = 18, stopMinutes = 8, detour = DETOUR } = {}) {
  let clock = now;
  let cur = from;
  return stops.map((s) => {
    const km = isPoint(cur) && isPoint(s) ? roadKm(cur, s, detour) : 3 * detour;
    clock += (km / speedKmh) * 3600000;
    const eta = new Date(clock);
    clock += stopMinutes * 60000;
    if (isPoint(s)) cur = s;
    return { id: s.id, eta, km: Math.round(km * 10) / 10 };
  });
}

/**
 * Affecter une commande à un voyage (chapitre 10) : éliminatoires, puis note.
 * @param {{lat,lng,weightG,volumeL,count,handling,codFcfa,zone}} order
 * @param {Array<{id, zones, vehicle:{capacityKg,capacityL,maxPackages,equipment,kind}, load:{weightG,volumeL,count}, stops:Array, codFcfa, cashLimitFcfa, departure}>} trips
 */
export function rankTrips(order, trips, { promisedAt } = {}) {
  const out = [];
  for (const t of trips) {
    const v = t.vehicle; const l = t.load;
    const reasons = [];
    if (t.zones?.length && !t.zones.includes(order.zone)) reasons.push('zone');
    if (l.weightG + order.weightG > v.capacityKg * 1000) reasons.push('poids');
    if (v.capacityL && l.volumeL + (order.volumeL ?? 0) > v.capacityL) reasons.push('volume');
    if (v.maxPackages && l.count + order.count > v.maxPackages) reasons.push('nombre');
    if ((order.handling ?? []).includes('froid') && !(v.equipment ?? []).includes('glacière')) reasons.push('glacière');
    if ((order.handling ?? []).includes('lourd') && ['moto', 'vélo'].includes(v.kind)) reasons.push('véhicule');
    if (t.cashLimitFcfa && t.codFcfa + (order.codFcfa ?? 0) > t.cashLimitFcfa) reasons.push('espèces');
    if (reasons.length) { out.push({ id: t.id, eligible: false, reasons, score: 0 }); continue; }
    const nearest = Math.min(...(t.stops ?? []).filter(isPoint).map((s) => haversine(s, order)), 8000);
    const proximity = 50 * Math.exp(-nearest / 4000);
    const fill = 30 * Math.min(1, (l.weightG + order.weightG) / (v.capacityKg * 1000));
    const balance = 20 * (1 - Math.min(1, (t.stops?.length ?? 0) / 20));
    const late = promisedAt && t.departure && new Date(t.departure) > new Date(promisedAt) ? -40 : 0;
    out.push({ id: t.id, eligible: true, reasons: [], score: Math.round(proximity + fill + balance + late), nearestM: Math.round(nearest) });
  }
  return out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
}

/** Écart de caisse : versé − encaissements en espèces déclarés (le mobile ne passe pas par la caisse). */
export function cashGap(collections, remitted) {
  const expected = collections.filter((c) => c.method === 'cash').reduce((s, c) => s + c.amount, 0);
  return { expected, remitted, gap: remitted - expected };
}

/** Gain du chauffeur : fixe + colis livrés × prime + primes − avances. */
export function driverPay({ delivered, failed, onTime = 0 }, rule, advances = 0) {
  const base = (rule.fixedPerTrip ?? 0) + delivered * (rule.perPackage ?? 500);
  const bonus = (failed === 0 && delivered > 0 ? rule.bonusZeroFailure ?? 0 : 0) + onTime * (rule.bonusOnTime ?? 0);
  return { base, bonus, advances, total: base + bonus - advances };
}

/** Code colis : NXP-XXXXXX, alphabet sans 0/O/1/I/L. Saisie de secours tolérante. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function normalizeCode(input) {
  const raw = String(input ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return 'NXP-' + raw.slice(-6);
}
export function isPackageCode(input) {
  const raw = String(input ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const tail = raw.slice(-6);
  return tail.length === 6 && [...tail].every((c) => CODE_ALPHABET.includes(c)) && (raw.length === 6 || raw.startsWith('NXP'));
}

/** Euros (base) → FCFA affichés, comme toute la pile NEXUS. */
export const EUR_TO_FCFA = 655.957;
export const fcfa = (eur) => Math.round(Number(eur || 0) * EUR_TO_FCFA);
export const formatF = (n) => `${Math.round(n ?? 0).toLocaleString('fr-FR').replace(/ | /g, ' ')} F`;
