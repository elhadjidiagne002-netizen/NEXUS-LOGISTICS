// Cycle C2 — page de suivi publique /suivi/<jeton> : sans compte, par lien secret propre à chaque commande.
// Portage de 20261007000600_suivi_client.sql (lg_track*) et de lg_track_third_party (cycle 5).
// Ces fonctions sont VOULUES publiques (rôle 'public') : le jeton (18 octets aléatoires) est la seule clé ;
// elles ne renvoient que le nécessaire et toutes leurs requêtes portent l'entreprise de la commande trouvée.
import { text, num, uuid, parseJson, distanceM } from './core.js';
import { confirmCod, cancelOrder, amountDue, orderShort } from './commandes.js';
import { zoneAt } from './tarifs.js';

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
      const rated = await ctx.db.prepare('SELECT 1 AS x FROM ratings WHERE order_id = ? AND company_id = ?').bind(o.id, o.company_id).first();
      const open = o.status === 'pending' || o.status === 'processing';
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
          { key: 'prepared', label: 'Colis préparé', at: o.processing_at },   // date d'emballage : cycle C3
          { key: 'shipped', label: 'En route', at: o.in_transit_at },
          { key: 'delivered', label: 'Livré', at: o.delivered_at },
        ],
        failure: null,   // passage sans remise : cycle C5
        delivery: null,  // livreur, heure d'arrivée et position : cycles C4-C5
        can_confirm: o.payment_method === 'cod' && !o.cod_confirmed_at && o.status !== 'cancelled' && o.status !== 'delivered',
        can_edit_address: open,
        can_rate: o.status === 'delivered' && !rated,
        invoice: null,   // facture : cycle C6
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
};
