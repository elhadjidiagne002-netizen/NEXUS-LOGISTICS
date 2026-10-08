// Cycle C2 — page de suivi publique /suivi/<jeton> : sans compte, par lien secret propre à chaque commande.
// Portage de 20261007000600_suivi_client.sql (lg_track*) et de lg_track_third_party (cycle 5).
// Ces fonctions sont VOULUES publiques (rôle 'public') : le jeton (18 octets aléatoires) est la seule clé ;
// elles ne renvoient que le nécessaire et toutes leurs requêtes portent l'entreprise de la commande trouvée.
import { text, num, uuid, parseJson, distanceM } from './core.js';
import { confirmCod, cancelOrder, amountDue, orderShort } from './commandes.js';
import { zoneAt } from './tarifs.js';
import { FAILURE_REASONS } from './terrain.js';
import { invoiceDoc } from './factures.js';

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const REQUEST_KINDS = ['reschedule', 'callback', 'help', 'third_party'];

/** Commande désignée par le jeton (équivalent de lg_order_by_token), avec le nom de l'entreprise. */
async function byToken(ctx, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return ctx.db.prepare(
    `SELECT o.*, c.name AS company_name FROM orders o JOIN companies c ON c.id = o.company_id
      WHERE o.tracking_token = ? AND c.suspended_at IS NULL`,
  ).bind(token).first();
}
const notFound = { ok: false, error: 'not_found' };

export default {
  lg_track: {
    roles: 'public',
    async handler(ctx, a) {
      const o = await byToken(ctx, a.p_token);
      if (!o) return notFound;
      const k = await ctx.db.prepare(
        `SELECT EXISTS (SELECT 1 FROM ratings WHERE order_id = ?1 AND company_id = ?2) AS rated,
                (SELECT min(created_at) FROM packages WHERE order_id = ?1 AND company_id = ?2) AS packed_at,
                EXISTS (SELECT 1 FROM packages WHERE order_id = ?1 AND company_id = ?2 AND status IN ('loaded', 'out_for_delivery', 'delivered')) AS loaded`,
      ).bind(o.id, o.company_id).first();
      const rated = k.rated; const open = (o.status === 'pending' || o.status === 'processing') && !k.loaded;
      // arrêt de livraison le plus récent, échec éventuel, code de livraison (cycle C5) : une seule requête groupée
      const [st, fl, dc, inv] = await ctx.db.batch([
        ctx.db.prepare(
          `SELECT s.id, s.seq, s.status, s.eta, s.lat, s.lng, t.id AS trip_id, t.status AS trip_status, c.name AS courier, c.rating_avg,
                  c.last_lat, c.last_lng, c.last_seen_at,
                  (SELECT count(*) FROM trip_stops x WHERE x.trip_id = t.id AND x.seq < s.seq AND x.status IN ('pending', 'en_route', 'arrived')) AS before
             FROM trip_stops s JOIN trips t ON t.id = s.trip_id LEFT JOIN couriers c ON c.id = t.courier_id
            WHERE s.order_id = ? AND s.company_id = ? AND s.kind = 'delivery' AND s.status <> 'skipped' AND t.status <> 'cancelled'
            ORDER BY t.created_at DESC LIMIT 1`).bind(o.id, o.company_id),
        ctx.db.prepare("SELECT completed_at, failure_reason FROM trip_stops WHERE order_id = ? AND company_id = ? AND status = 'failed' ORDER BY completed_at DESC LIMIT 1")
          .bind(o.id, o.company_id),
        ctx.db.prepare('SELECT code, verified_at, expires_at, attempts_left FROM delivery_codes WHERE order_id = ? AND company_id = ?').bind(o.id, o.company_id),
        ctx.db.prepare('SELECT invoice_number FROM invoices WHERE order_id = ? AND company_id = ? AND credit_of IS NULL').bind(o.id, o.company_id),
      ]);
      const s = st.results[0]; const f = fl.results[0]; const code = dc.results[0];
      const live = s?.trip_status === 'in_progress';
      const fresh = s?.last_seen_at && s.last_seen_at > new Date(Date.parse(ctx.now) - 15 * 60000).toISOString();
      return {
        ok: true,
        company: { name: o.company_name },
        order: {
          short: orderShort(o.id), number: o.number, status: o.status, vendor: o.vendor_name ?? o.company_name, zone: o.delivery_zone,
          landmark: o.landmark, created_at: o.created_at, payment_method: o.payment_method, paid: o.payment_status === 'paid',
          promised_at: o.promised_at, has_position: o.delivery_lat != null, first_name: String(o.buyer_name ?? '').split(' ')[0],
        },
        amount_due_fcfa: amountDue(o),
        steps: [
          { key: 'confirmed', label: 'Commande confirmée', at: o.cod_confirmed_at ?? o.paid_at ?? (o.payment_method !== 'cod' ? o.created_at : null) },
          { key: 'prepared', label: 'Colis préparé', at: k.packed_at },
          { key: 'shipped', label: 'En route', at: o.in_transit_at },
          { key: 'delivered', label: 'Livré', at: o.delivered_at },
        ],
        failure: f && o.status !== 'delivered' ? { at: f.completed_at, reason: FAILURE_REASONS[f.failure_reason]?.label ?? 'Autre' } : null,
        delivery: s ? {
          eta: s.eta, status: s.status, stops_before: live && ['pending', 'en_route'].includes(s.status) ? s.before : 0,
          courier: s.courier ? String(s.courier).split(' ')[0] : null, courier_rating: s.rating_avg,
          // position du livreur : seulement quand il roule vers CE client (chapitre 11)
          position: live && ['en_route', 'arrived'].includes(s.status) && fresh && s.last_lat != null ? { lat: s.last_lat, lng: s.last_lng, at: s.last_seen_at } : null,
          dest: s.lat != null ? { lat: s.lat, lng: s.lng } : null,
        } : null,
        // code à donner au livreur : visible sur la page privée tant que le colis est en route
        delivery_code: code && !code.verified_at && o.status === 'in_transit' && code.expires_at > ctx.now && code.attempts_left > 0 ? code.code : null,
        can_confirm: o.payment_method === 'cod' && !o.cod_confirmed_at && o.status !== 'cancelled' && o.status !== 'delivered',
        can_edit_address: open,
        can_rate: o.status === 'delivered' && !rated,
        invoice: inv.results[0] ? { number: inv.results[0].invoice_number } : null,
      };
    },
  },

  // OUI : confirme le paiement à la livraison ; NON : annule (seulement tant que la commande n'est pas confirmée).
  lg_track_confirm: {
    roles: 'public',
    async handler(ctx, a) {
      const o = await byToken(ctx, a.p_token);
      if (!o) return notFound;
      if (a.p_yes) return confirmCod(ctx, o.company_id, o.id, 'suivi');
      if (o.cod_confirmed_at) return { ok: false, error: 'already_confirmed' };
      return cancelOrder(ctx, o.company_id, o.id, 'Annulée par le client (page de suivi)');
    },
  },

  // Le client pose son épingle et un repère tant que rien n'est parti.
  lg_track_set_location: {
    roles: 'public',
    async handler(ctx, a) {
      const o = await byToken(ctx, a.p_token);
      if (!o) return notFound;
      const lat = num(a.p_lat); const lng = num(a.p_lng);
      if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, error: 'invalid_position' };
      if (o.status !== 'pending' && o.status !== 'processing') return { ok: false, error: 'already_loaded' };
      if (await ctx.db.prepare("SELECT 1 AS x FROM packages WHERE order_id = ? AND company_id = ? AND status IN ('loaded', 'out_for_delivery', 'delivered')")
        .bind(o.id, o.company_id).first()) return { ok: false, error: 'already_loaded' };
      const zones = (await ctx.db.prepare('SELECT name, lat, lng, polygon FROM zones WHERE company_id = ?').bind(o.company_id).all())
        .results.map((z) => ({ ...z, polygon: parseJson(z.polygon) }));
      // épingle posée trop loin de toute zone servie par l'entreprise : sans doute une erreur de manipulation
      const near = zones.map((z) => distanceM(z.lat, z.lng, lat, lng)).filter((d) => d != null);
      if (near.length && Math.min(...near) > 50000) return { ok: false, error: 'outside_area' };
      const zone = o.delivery_zone ?? zoneAt(zones, lat, lng)?.name ?? null;
      const landmark = text(a.p_landmark, 200);
      const [r] = await ctx.db.batch([
        ctx.db.prepare(
          `UPDATE orders SET delivery_lat = ?, delivery_lng = ?, landmark = coalesce(?, landmark), delivery_zone = coalesce(delivery_zone, ?), updated_at = ?
            WHERE id = ? AND company_id = ? AND status IN ('pending', 'processing')`,
        ).bind(lat, lng, landmark, zone, ctx.now, o.id, o.company_id),
        // la fiche client garde la position pour les prochaines commandes
        ctx.db.prepare('UPDATE customers SET lat = ?, lng = ?, landmark = coalesce(?, landmark), updated_at = ? WHERE id = ? AND company_id = ?')
          .bind(lat, lng, landmark, ctx.now, o.customer_id, o.company_id),
      ]);
      if (!r.meta.changes) return { ok: false, error: 'already_loaded' };
      return { ok: true };
    },
  },

  lg_track_rate: {
    roles: 'public',
    async handler(ctx, a) {
      const o = await byToken(ctx, a.p_token);
      if (!o || o.status !== 'delivered') return { ok: false, error: 'not_delivered' };
      const rating = Number(a.p_rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'invalid_rating' };
      const comment = text(a.p_comment, 500);
      // une seule note par commande ; une note basse ouvre une demande au service client (rappel)
      if (await ctx.db.prepare('SELECT 1 AS x FROM ratings WHERE order_id = ? AND company_id = ?').bind(o.id, o.company_id).first()) return { ok: true };
      const stmts = [ctx.db.prepare('INSERT OR IGNORE INTO ratings (order_id, company_id, rating, comment) VALUES (?, ?, ?, ?)').bind(o.id, o.company_id, rating, comment)];
      if (rating <= 2) {
        stmts.push(ctx.db.prepare("INSERT INTO customer_requests (id, company_id, order_id, kind, payload) VALUES (?, ?, ?, 'help', ?)")
          .bind(uuid(), o.company_id, o.id, JSON.stringify({ reason: 'note_basse', rating, comment })));
      }
      // note moyenne du livreur : cycle C5 (le livreur de la commande n'est connu qu'avec les voyages)
      await ctx.db.batch(stmts);
      return { ok: true };
    },
  },

  // Demande au service client : autre jour, rappel, aide, livraison à un tiers.
  lg_track_request: {
    roles: 'public',
    async handler(ctx, a) {
      const o = await byToken(ctx, a.p_token);
      if (!o) return notFound;
      if (!REQUEST_KINDS.includes(a.p_kind)) return { ok: false, error: 'invalid_kind' };
      const since = new Date(Date.parse(ctx.now) - 3600000).toISOString();
      const n = await ctx.db.prepare('SELECT COUNT(*) AS n FROM customer_requests WHERE order_id = ? AND company_id = ? AND created_at > ?')
        .bind(o.id, o.company_id, since).first('n');
      if (n >= 5) return { ok: false, error: 'too_many_requests' };
      const payload = {};
      if (a.p_payload && typeof a.p_payload === 'object' && !Array.isArray(a.p_payload)) {
        for (const [k, v] of Object.entries(a.p_payload).slice(0, 10)) if (k !== 'order_id' && v != null) payload[String(k).slice(0, 30)] = String(v).slice(0, 500);
      }
      const id = uuid();
      await ctx.db.prepare('INSERT INTO customer_requests (id, company_id, order_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, o.company_id, o.id, a.p_kind, JSON.stringify(payload), ctx.now).run();
      return { ok: true, id };
    },
  },

  // Le client désigne une personne qui recevra le colis (et le code de livraison, envoyé au départ : cycle C5).
  lg_track_third_party: {
    roles: 'public',
    async handler(ctx, a) {
      const o = await byToken(ctx, a.p_token);
      if (!o) return notFound;
      const name = text(a.p_name, 80); const phone = text(a.p_phone, 20);
      if (!name || name.length < 2 || String(phone ?? '').replace(/\D/g, '').length < 9) return { ok: false, error: 'invalid_recipient' };
      if (o.status === 'delivered' || o.status === 'cancelled') return { ok: false, error: 'order_closed' };
      await ctx.db.prepare('UPDATE orders SET recipient_name = ?, recipient_phone = ?, updated_at = ? WHERE id = ? AND company_id = ?')
        .bind(name, phone, ctx.now, o.id, o.company_id).run();
      return { ok: true };
    },
  },

  // Facture de la commande, pour l'imprimer depuis la page de suivi.
  lg_track_invoice: {
    roles: 'public',
    async handler(ctx, a) {
      const o = await byToken(ctx, a.p_token);
      if (!o) return notFound;
      const i = await ctx.db.prepare('SELECT * FROM invoices WHERE order_id = ? AND company_id = ? AND credit_of IS NULL').bind(o.id, o.company_id).first();
      if (!i) return { ok: false, error: 'no_invoice' };
      return { ...(await invoiceDoc(ctx, i)), ok: true };
    },
  },

  // Propositions d'indemnité en attente de la réponse du client (incident résolu avec indemnité).
  lg_track_incidents: {
    roles: 'public',
    async handler(ctx, a) {
      const o = await byToken(ctx, a.p_token);
      if (!o) return [];
      return (await ctx.db.prepare(
        `SELECT id, number, resolution, compensation_fcfa FROM incidents WHERE order_id = ? AND company_id = ? AND status = 'resolved' AND compensation_fcfa > 0
            AND customer_agreed_at IS NULL AND customer_refused_at IS NULL ORDER BY created_at`,
      ).bind(o.id, o.company_id).all()).results;
    },
  },

  lg_track_incident_answer: {
    roles: 'public',
    async handler(ctx, a) {
      const o = await byToken(ctx, a.p_token);
      if (!o) return notFound;
      const yes = a.p_accept === true;
      const r = await ctx.db.prepare(
        `UPDATE incidents SET ${yes ? "customer_agreed_at = ?, status = 'closed'" : "customer_refused_at = ?, status = 'investigating'"}, agreement_via = 'tracking'
          WHERE id = ? AND order_id = ? AND company_id = ? AND status = 'resolved' AND customer_agreed_at IS NULL AND customer_refused_at IS NULL`,
      ).bind(ctx.now, String(a.p_incident ?? ''), o.id, o.company_id).run();
      if (!r.meta.changes) return { ok: false, error: 'nothing_to_answer' };
      await ctx.db.prepare("INSERT INTO audit_log (company_id, action, entity, entity_id, detail) VALUES (?, 'incident_customer_answer', 'incident', ?, ?)")
        .bind(o.company_id, String(a.p_incident), JSON.stringify({ accept: yes })).run();
      return { ok: true, closed: yes };
    },
  },
};
