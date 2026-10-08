// Cycle C2 — zones, grille tarifaire, suppléments (nuit, forte pluie), assurance et devis au panier.
// Portage de lg_quote / lg_set_zone / lg_upsert_rate_card / lg_pricing (20261007000700, 20261007000800),
// lg_surcharge_* (20261008001000) et lg_insurance_fee (20261008001400), limité à l'entreprise.
// Heure de Dakar = UTC toute l'année (pas d'heure d'été) : les heures « HH:MM » se lisent sur ctx.now.
import { fail, audit, text, num, int, uuid, parseJson, distanceM } from './core.js';
import { companyConfig } from '../config.js';

export const SERVICES = ['standard', 'express', 'programme'];
const VEHICLES = ['moto', 'velo', 'voiture', 'fourgonnette', 'tricycle', 'pied'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Suppléments proposés à toute entreprise, DÉSACTIVÉS par défaut : aucun prix ne change sans action.
export const DEFAULT_SURCHARGES = [
  { code: 'night', label: 'Supplément nuit', amount_fcfa: 1000, active: false, start_time: '20:00', end_time: '07:00', services: ['express'], zones: null, until: null },
  { code: 'rain', label: 'Supplément forte pluie', amount_fcfa: 500, active: false, start_time: null, end_time: null, services: null, zones: null, until: null },
];

// Quartiers de Dakar et environs (mêmes centres que la base NEXUS) : point de départ proposé à une entreprise neuve.
const DAKAR_ZONES = [
  ['Almadies', 14.744, -17.523, 'Dakar'], ['Amitié', 14.7, -17.455, 'Dakar'], ['Baobab', 14.713, -17.472, 'Dakar'],
  ['Bargny', 14.694, -17.226, 'Bargny'], ['Biscuiterie', 14.705, -17.445, 'Dakar'], ['Cambérène', 14.755, -17.455, 'Dakar'],
  ['Cité Keur Gorgui', 14.718, -17.468, 'Dakar'], ['Colobane', 14.687, -17.44, 'Dakar'], ['Dakar-Plateau', 14.67, -17.438, 'Dakar'],
  ['Derklé', 14.723, -17.453, 'Dakar'], ['Diamniadio', 14.728, -17.184, 'Diamniadio'], ['Dieuppeul', 14.72, -17.45, 'Dakar'],
  ['Fann', 14.687, -17.465, 'Dakar'], ['Fass', 14.687, -17.447, 'Dakar'], ['Gibraltar', 14.672, -17.44, 'Dakar'],
  ['Grand Dakar', 14.71, -17.448, 'Dakar'], ['Grand Yoff', 14.735, -17.445, 'Dakar'], ['Guédiawaye', 14.77, -17.406, 'Guédiawaye'],
  ['Gueule Tapée', 14.68, -17.447, 'Dakar'], ['Hann Bel-Air', 14.708, -17.43, 'Dakar'], ['Hann Maristes', 14.702, -17.44, 'Dakar'],
  ['HLM', 14.715, -17.445, 'Dakar'], ['Liberté 6', 14.719, -17.463, 'Dakar'], ['Mbour', 14.42, -16.966, 'Mbour'],
  ['Médina', 14.683, -17.454, 'Dakar'], ['Mermoz', 14.708, -17.475, 'Dakar'], ['Ngor', 14.746, -17.517, 'Dakar'],
  ['Nord Foire', 14.755, -17.468, 'Dakar'], ['Ouakam', 14.722, -17.49, 'Dakar'], ['Ouest Foire', 14.745, -17.465, 'Dakar'],
  ['Parcelles', 14.767, -17.429, 'Dakar'], ["Patte d'Oie", 14.735, -17.455, 'Dakar'], ['Pikine', 14.755, -17.39, 'Pikine'],
  ['Point E', 14.695, -17.465, 'Dakar'], ['Rebeuss', 14.665, -17.43, 'Dakar'], ['Rufisque', 14.715, -17.273, 'Rufisque'],
  ['Sacré-Cœur', 14.715, -17.47, 'Dakar'], ['Sébikotane', 14.748, -17.137, 'Sébikotane'], ['Sicap Liberté', 14.715, -17.46, 'Dakar'],
  ['Thiès', 14.791, -16.926, 'Thiès'], ['Yarakh', 14.695, -17.43, 'Dakar'], ['Yoff', 14.755, -17.473, 'Dakar'],
];

const zoneOut = (z) => ({
  name: z.name, city: z.city, lat: z.lat, lng: z.lng, polygon: parseJson(z.polygon), served: Boolean(z.served),
  cutoff_time: z.cutoff_time, delivery_days: parseJson(z.delivery_days, [1, 2, 3, 4, 5, 6]), free_above_fcfa: z.free_above_fcfa, hub_id: z.hub_id,
});
const cardOut = (r) => ({ ...r, active: Boolean(r.active) });
const surchargeRow = (s) => ({ ...s, active: Boolean(s.active), services: parseJson(s.services), zones: parseJson(s.zones) });

/**
 * Tout ce qu'il faut pour chiffrer : zones, tarifs actifs, suppléments enregistrés, lieux (un seul aller-retour).
 * Lecture groupée : un import de 50 commandes ne relit pas la grille 50 fois.
 */
export async function loadPricing(db, companyId) {
  const [z, r, s, h] = await db.batch([
    db.prepare('SELECT * FROM zones WHERE company_id = ? ORDER BY city, name').bind(companyId),
    db.prepare('SELECT * FROM rate_cards WHERE company_id = ? AND active = 1').bind(companyId),
    db.prepare('SELECT * FROM surcharges WHERE company_id = ?').bind(companyId),
    db.prepare('SELECT id, lat, lng FROM hubs WHERE company_id = ? AND active = 1 ORDER BY created_at').bind(companyId),
  ]);
  return { zones: z.results.map(zoneOut), cards: r.results, surcharges: mergeSurcharges(s.results), hubs: h.results };
}

export function mergeSurcharges(rows) {
  const byCode = new Map(DEFAULT_SURCHARGES.map((d) => [d.code, { ...d }]));
  for (const row of rows) byCode.set(row.code, surchargeRow(row));
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

const inForce = (s, now) => s.active && (!s.until || s.until > now);

/** Suppléments qui s'appliquent maintenant à cette zone et ce service (équivalent de lg_surcharges_now). */
export function surchargesNow(list, zone, service, now) {
  const t = now.slice(11, 16);
  return list.filter((s) => inForce(s, now) && s.amount_fcfa > 0
    && (!s.services || s.services.includes(service || 'standard'))
    && (!s.zones || s.zones.includes(zone))
    && (!s.start_time || !s.end_time
      || (s.start_time <= s.end_time ? t >= s.start_time && t < s.end_time : t >= s.start_time || t < s.end_time)))
    .map((s) => ({ code: s.code, label: s.label, amount_fcfa: s.amount_fcfa }));
}

/** Point dans un polygone (lancer de rayon), polygone = [[lat, lng], …]. */
function inPolygon(poly, lat, lng) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i]; const [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Zone d'un point : polygone qui le contient, sinon centre le plus proche à moins de 15 km. */
export function zoneAt(zones, lat, lng) {
  if (lat == null || lng == null) return null;
  const hit = zones.find((z) => Array.isArray(z.polygon) && z.polygon.length >= 3 && inPolygon(z.polygon, lat, lng));
  if (hit) return hit;
  let best = null; let bestD = 15000;
  for (const z of zones) {
    const d = distanceM(z.lat, z.lng, lat, lng);
    if (d != null && d < bestD) { best = z; bestD = d; }
  }
  return best;
}

/** Prime d'assurance : null si la valeur dépasse le plafond assurable (équivalent de lg_insurance_fee). */
export function insuranceFee(cfg, value) {
  if (value == null || value <= 0) return 0;
  if (value > Number(cfg.insurance_max_value_fcfa ?? 1000000)) return null;
  return Math.max(Number(cfg.insurance_min_fcfa ?? 300), Math.round((value * Number(cfg.insurance_rate_pct ?? 2)) / 100));
}

const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/**
 * Devis (équivalent de lg_quote, cycle 14) : tranche de poids, zone, véhicule, service, délai promis,
 * livraison offerte au-delà d'un panier, suppléments, assurance ; + prix au km si la grille en a un.
 * Renvoie { ok:false, error } pour un refus (zone non desservie, pas de tarif…), comme l'original.
 */
export function computeQuote(pricing, cfg, a, now) {
  const weight = Math.max(1, int(a.weight_g) ?? 1000);
  const service = a.service || 'standard';
  let zone = a.zone ? pricing.zones.find((z) => z.name === a.zone) : null;
  if (!a.zone) zone = zoneAt(pricing.zones, num(a.lat), num(a.lng));
  if (!zone) return { ok: false, error: 'unknown_zone' };
  if (!zone.served) return { ok: false, error: 'zone_not_served' };
  const declared = int(a.declared_value_fcfa);
  const fee = insuranceFee(cfg, declared);
  if (fee == null) return { ok: false, error: 'value_too_high', max_value_fcfa: Number(cfg.insurance_max_value_fcfa ?? 1000000) };
  const kind = weight <= 20000 ? 'moto' : weight <= 150000 ? 'tricycle' : 'fourgonnette';
  const rc = pricing.cards
    .filter((r) => r.service === service && r.max_weight_g >= weight && (r.zone == null || r.zone === zone.name) && (r.vehicle_kind == null || r.vehicle_kind === kind))
    .sort((x, y) => (y.zone != null) - (x.zone != null) || (y.vehicle_kind != null) - (x.vehicle_kind != null) || x.max_weight_g - y.max_weight_g)[0];
  if (!rc) return { ok: false, error: 'no_rate' };
  // délai promis : jour de livraison ouvert suivant l'heure limite, livraison avant 19 h
  let day = addDays(now.slice(0, 10), (now.slice(11, 16) > (zone.cutoff_time || '12:00') ? 1 : 0) + Math.ceil(Math.max(rc.lead_hours - 24, 0) / 24));
  const days = Array.isArray(zone.delivery_days) && zone.delivery_days.length ? zone.delivery_days : [1, 2, 3, 4, 5, 6];
  for (let i = 0; i < 7 && !days.includes(new Date(day + 'T00:00:00Z').getUTCDay()); i++) day = addDays(day, 1);
  let promised = `${day}T19:00:00.000Z`;
  if (rc.service === 'express') {
    const soon = new Date(Date.parse(now) + rc.lead_hours * 3600000).toISOString();
    if (soon < promised) promised = soon;
  }
  // distance (prix au km) : du lieu de rattachement de la zone (sinon le premier lieu) au point de livraison
  const hub = pricing.hubs.find((h) => h.id === zone.hub_id && h.lat != null) ?? pricing.hubs.find((h) => h.lat != null);
  const dest = num(a.lat) != null && num(a.lng) != null ? { lat: num(a.lat), lng: num(a.lng) } : { lat: zone.lat, lng: zone.lng };
  const m = hub ? distanceM(hub.lat, hub.lng, dest.lat, dest.lng) : null;
  const km = m == null ? null : Math.round((m / 1000) * Number(cfg.detour_coef ?? 1.35) * 10) / 10;
  const base = rc.price_fcfa + (rc.per_km_fcfa && km != null ? Math.round(rc.per_km_fcfa * km) : 0);
  const subtotal = int(a.subtotal_fcfa) ?? 0;
  const free = zone.free_above_fcfa != null && subtotal >= zone.free_above_fcfa;
  const sur = free ? [] : surchargesNow(pricing.surcharges, zone.name, rc.service, now);
  const price = free ? 0 : base + sur.reduce((s, x) => s + x.amount_fcfa, 0);
  return {
    ok: true, zone: zone.name, service: rc.service, vehicle_kind: kind, price_fcfa: price, base_fcfa: base, surcharges: sur,
    free, free_above_fcfa: zone.free_above_fcfa, promised_at: promised, distance_km: km,
    // l'assurance est une ligne à part : la livraison offerte n'offre pas l'assurance
    insured_value_fcfa: declared, insurance_fee_fcfa: fee, total_fcfa: price + fee,
  };
}

async function zoneExists(ctx, name) {
  return Boolean(await ctx.db.prepare('SELECT 1 AS x FROM zones WHERE company_id = ? AND name = ?').bind(ctx.company.id, name).first());
}

export default {
  // Devis au panier. Public : le site d'une boutique l'appelle avant paiement avec p_company (adresse publique
  // de l'entreprise) ; un membre connecté chiffre pour sa propre entreprise. Lecture seule.
  lg_quote: {
    roles: 'public',
    async handler(ctx, a) {
      let company = ctx.company;
      if (!company) {
        const slug = text(a.p_company, 60);
        company = slug && await ctx.db.prepare('SELECT id, settings FROM companies WHERE slug = ? AND suspended_at IS NULL').bind(slug).first();
        if (!company) return { ok: false, error: 'unknown_company' };
      }
      if (a.p_service != null && !SERVICES.includes(a.p_service)) return { ok: false, error: 'invalid_service' };
      return computeQuote(await loadPricing(ctx.db, company.id), companyConfig(company), {
        zone: text(a.p_zone, 80), weight_g: a.p_weight_g, subtotal_fcfa: a.p_subtotal_fcfa, service: a.p_service,
        declared_value_fcfa: a.p_declared_value_fcfa, lat: a.p_lat, lng: a.p_lng,
      }, ctx.now);
    },
  },

  // Écran Administration → Tarifs : zones, grille, réglages (même forme que la version Postgres).
  lg_pricing: {
    roles: ['dispatcher'],
    async handler(ctx) {
      const p = await loadPricing(ctx.db, ctx.company.id);
      const svc = (s) => SERVICES.indexOf(s);
      return {
        zones: p.zones,
        rate_cards: p.cards.map(cardOut).sort((x, y) => svc(x.service) - svc(y.service) || (x.zone ?? '').localeCompare(y.zone ?? '')
          || (x.vehicle_kind ?? '').localeCompare(y.vehicle_kind ?? '') || x.max_weight_g - y.max_weight_g),
        pay_rules: [], // règles de rémunération des chauffeurs : cycle C6
        config: ctx.company.config,
      };
    },
  },

  // Crée ou règle une zone (desservie, heure limite, jours, gratuité, lieu, centre, polygone).
  lg_set_zone: {
    roles: 'admin',
    async handler(ctx, a) {
      const name = text(a.p_zone, 80);
      if (!name) fail('invalid_name');
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      const cutoff = p.cutoff_time == null ? '12:00' : String(p.cutoff_time).slice(0, 5);
      if (!HHMM.test(cutoff)) fail('invalid_time');
      const days = Array.isArray(p.delivery_days) ? [...new Set(p.delivery_days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [1, 2, 3, 4, 5, 6];
      if (!days.length) fail('invalid_days');
      const free = p.free_above_fcfa == null || p.free_above_fcfa === '' ? null : int(p.free_above_fcfa);
      if (free != null && free < 0) fail('invalid_amount');
      const lat = num(p.lat); const lng = num(p.lng);
      if ((lat != null && Math.abs(lat) > 90) || (lng != null && Math.abs(lng) > 180)) fail('invalid_position');
      let poly = null;
      if (Array.isArray(p.polygon)) {
        poly = p.polygon.slice(0, 200).map((pt) => [num(pt?.[0]), num(pt?.[1])]);
        if (poly.length < 3 || poly.some(([x, y]) => x == null || y == null || Math.abs(x) > 90 || Math.abs(y) > 180)) fail('invalid_polygon');
      }
      const hub = p.hub_id || null;
      if (hub && !(await ctx.db.prepare('SELECT 1 AS x FROM hubs WHERE id = ? AND company_id = ?').bind(hub, ctx.company.id).first())) fail('unknown_hub', 404);
      // coalesce : un réglage partiel (écran Tarifs) ne perd ni le centre ni le polygone déjà enregistrés
      await ctx.db.prepare(
        `INSERT INTO zones (company_id, name, city, lat, lng, polygon, served, cutoff_time, delivery_days, free_above_fcfa, hub_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, name) DO UPDATE SET city = coalesce(excluded.city, zones.city), lat = coalesce(excluded.lat, zones.lat),
           lng = coalesce(excluded.lng, zones.lng), polygon = coalesce(excluded.polygon, zones.polygon), served = excluded.served,
           cutoff_time = excluded.cutoff_time, delivery_days = excluded.delivery_days, free_above_fcfa = excluded.free_above_fcfa,
           hub_id = excluded.hub_id`,
      ).bind(ctx.company.id, name, text(p.city, 60), lat, lng, poly ? JSON.stringify(poly) : null, p.served === false ? 0 : 1, cutoff,
        JSON.stringify(days), free, hub).run();
      await audit(ctx, 'zone', 'zone', name, p);
      return { ok: true };
    },
  },

  // Supprime une zone sans commande en cours (sinon : la marquer non desservie).
  lg_zone_delete: {
    roles: 'admin',
    async handler(ctx, a) {
      const name = text(a.p_zone, 80);
      const busy = await ctx.db.prepare("SELECT 1 AS x FROM orders WHERE company_id = ? AND delivery_zone = ? AND status IN ('pending', 'processing', 'in_transit') LIMIT 1")
        .bind(ctx.company.id, name).first();
      if (busy) return { ok: false, error: 'zone_in_use' };
      const [r] = await ctx.db.batch([
        ctx.db.prepare('DELETE FROM zones WHERE company_id = ? AND name = ?').bind(ctx.company.id, name),
        ctx.db.prepare('UPDATE rate_cards SET active = 0 WHERE company_id = ? AND zone = ?').bind(ctx.company.id, name),
      ]);
      if (!r.meta.changes) fail('unknown_zone', 404);
      await audit(ctx, 'zone_delete', 'zone', name);
      return { ok: true };
    },
  },

  // Démarrage rapide : ajoute les quartiers de Dakar et environs (ceux qui existent déjà ne sont pas touchés).
  lg_zones_seed: {
    roles: 'admin',
    async handler(ctx) {
      const res = await ctx.db.batch(DAKAR_ZONES.map(([n, lat, lng, city]) =>
        ctx.db.prepare('INSERT OR IGNORE INTO zones (company_id, name, city, lat, lng) VALUES (?, ?, ?, ?, ?)').bind(ctx.company.id, n, city, lat, lng)));
      const added = res.reduce((s, r) => s + (r.meta?.changes ?? 0), 0);
      await audit(ctx, 'zones_seed', 'zone', null, { added });
      return { ok: true, added };
    },
  },

  lg_upsert_rate_card: {
    roles: 'admin',
    async handler(ctx, a) {
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      if (p.id && p.active === false) {
        const r = await ctx.db.prepare('UPDATE rate_cards SET active = 0 WHERE id = ? AND company_id = ?').bind(p.id, ctx.company.id).run();
        if (!r.meta.changes) fail('unknown_rate', 404);
        await audit(ctx, 'rate_card_off', 'rate_card', p.id);
        return { ok: true };
      }
      const service = p.service || 'standard';
      if (!SERVICES.includes(service)) fail('invalid_service');
      const zone = text(p.zone, 80);
      if (zone && !(await zoneExists(ctx, zone))) fail('unknown_zone', 404);
      const kind = text(p.vehicle_kind, 20);
      if (kind && !VEHICLES.includes(kind)) fail('invalid_vehicle');
      const maxW = int(p.max_weight_g); const price = int(p.price_fcfa); const perKm = int(p.per_km_fcfa) ?? 0; const lead = int(p.lead_hours) ?? 24;
      if (!(maxW > 0) || !(price >= 0) || perKm < 0 || lead < 0 || lead > 24 * 30) fail('invalid_amount');
      const id = p.id || uuid();
      if (p.id) {
        const r = await ctx.db.prepare(
          'UPDATE rate_cards SET zone = ?, vehicle_kind = ?, max_weight_g = ?, price_fcfa = ?, per_km_fcfa = ?, lead_hours = ?, service = ?, active = 1 WHERE id = ? AND company_id = ?',
        ).bind(zone, kind, maxW, price, perKm, lead, service, id, ctx.company.id).run();
        if (!r.meta.changes) fail('unknown_rate', 404);
      } else {
        await ctx.db.prepare('INSERT INTO rate_cards (id, company_id, zone, vehicle_kind, max_weight_g, price_fcfa, per_km_fcfa, lead_hours, service) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, ctx.company.id, zone, kind, maxW, price, perKm, lead, service).run();
      }
      await audit(ctx, 'rate_card', 'rate_card', id, p);
      return { ok: true, id };
    },
  },

  lg_surcharges_list: {
    roles: ['dispatcher'],
    async handler(ctx) {
      const rows = (await ctx.db.prepare('SELECT * FROM surcharges WHERE company_id = ?').bind(ctx.company.id).all()).results;
      return mergeSurcharges(rows).map((s) => ({ ...s, in_force: inForce(s, ctx.now) }));
    },
  },

  lg_surcharge_save: {
    roles: 'admin',
    async handler(ctx, a) {
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      const code = String(p.code ?? '').trim().toLowerCase();
      if (!/^[a-z_]{2,30}$/.test(code)) fail('invalid_code');
      const amount = int(p.amount_fcfa) ?? 0;
      if (amount < 0) fail('invalid_amount');
      const st = p.start_time ? String(p.start_time).slice(0, 5) : null; const et = p.end_time ? String(p.end_time).slice(0, 5) : null;
      if ((st && !HHMM.test(st)) || (et && !HHMM.test(et))) fail('invalid_time');
      const list = (v, ok) => (Array.isArray(v) && v.length ? JSON.stringify(v.map(String).filter(ok).slice(0, 100)) : null);
      const label = text(p.label, 80) ?? DEFAULT_SURCHARGES.find((d) => d.code === code)?.label ?? code;
      await ctx.db.prepare(
        `INSERT INTO surcharges (company_id, code, label, amount_fcfa, active, start_time, end_time, services, zones, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, code) DO UPDATE SET label = excluded.label, amount_fcfa = excluded.amount_fcfa, active = excluded.active,
           start_time = excluded.start_time, end_time = excluded.end_time, services = excluded.services, zones = excluded.zones,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).bind(ctx.company.id, code, label, amount, p.active ? 1 : 0, st, et, list(p.services, (s) => SERVICES.includes(s)), list(p.zones, Boolean),
        ctx.user.id, ctx.now).run();
      await audit(ctx, 'surcharge', 'surcharge', code, p);
      return { ok: true, code };
    },
  },

  // Forte pluie : le répartiteur déclare (ou lève) un supplément pour quelques heures et des zones.
  lg_surcharge_declare: {
    roles: ['dispatcher'],
    async handler(ctx, a) {
      const row = await ctx.db.prepare('SELECT * FROM surcharges WHERE company_id = ? AND code = ?').bind(ctx.company.id, a.p_code).first();
      const s = row ? surchargeRow(row) : DEFAULT_SURCHARGES.find((d) => d.code === a.p_code);
      if (!s) fail('unknown_surcharge', 404);
      const hours = int(a.p_hours) ?? 0;
      if (hours > 24) fail('invalid_hours');
      const until = hours > 0 ? new Date(Date.parse(ctx.now) + hours * 3600000).toISOString() : null;
      const zones = hours > 0 && Array.isArray(a.p_zones) && a.p_zones.length ? JSON.stringify(a.p_zones.map(String).slice(0, 100)) : hours > 0 ? null : s.zones ? JSON.stringify(s.zones) : null;
      await ctx.db.prepare(
        `INSERT INTO surcharges (company_id, code, label, amount_fcfa, active, start_time, end_time, services, zones, until, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, code) DO UPDATE SET active = excluded.active, zones = excluded.zones, until = excluded.until,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).bind(ctx.company.id, s.code, s.label, s.amount_fcfa, hours > 0 ? 1 : 0, s.start_time, s.end_time,
        s.services ? JSON.stringify(s.services) : null, zones, until, ctx.user.id, ctx.now).run();
      await audit(ctx, 'surcharge_declare', 'surcharge', s.code, { hours, zones: a.p_zones ?? null });
      return { ok: true, code: s.code, until };
    },
  },
};
