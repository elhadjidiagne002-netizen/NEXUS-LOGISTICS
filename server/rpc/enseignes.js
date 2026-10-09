// Enseignes (clients professionnels) : conditions, magasins, prix convenus — 09/10/2026.
// Les prix convenus s'appliquent tout seuls à la création d'une commande d'un magasin de l'enseigne (linePrice(),
// server/rpc/commandes.js) ; la facture est adressée à la raison sociale de l'enseigne, livrée au magasin.
// À la collecte, un bon est rattaché à son enseigne par l'adresse de l'expéditeur (sender_match) ou par le nom lu,
// et chaque prix du bon est comparé au prix convenu (priceChecks).
import { fail, audit, text, int, num, uuid, phoneKey } from './core.js';
import { chunks } from '../http.js';

const READ = ['accountant', 'support', 'dispatcher'];
const WRITE = ['accountant', 'support'];
const MAX_PRICES = 1000;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

async function accountFor(ctx, id) {
  const a = await ctx.db.prepare('SELECT * FROM accounts WHERE id = ? AND company_id = ?').bind(String(id ?? ''), ctx.company.id).first();
  if (!a) fail('unknown_account', 404);
  return a;
}
const accountOut = (a) => ({
  id: a.id, name: a.name, prices_ht: Boolean(a.prices_ht), vat_exempt: Boolean(a.vat_exempt), discount_pct: a.discount_pct, payment_terms_days: a.payment_terms_days,
  sender_match: a.sender_match, ninea: a.ninea, rc: a.rc, address: a.address, email: a.email, phone: a.phone, note: a.note, active: Boolean(a.active),
});

/** Enseigne d'un document reçu : par l'adresse de l'expéditeur, sinon par le nom lu (client ou magasin). */
export async function findAccount(ctx, { sender = null, names = [] } = {}) {
  const list = (await ctx.db.prepare('SELECT * FROM accounts WHERE company_id = ? AND active = 1').bind(ctx.company.id).all()).results;
  const s = String(sender ?? '').toLowerCase();
  let acc = s ? list.find((a) => a.sender_match && s.includes(String(a.sender_match).toLowerCase().trim())) : null;
  if (!acc) {
    const ns = names.filter(Boolean).map(norm);
    acc = list.find((a) => { const n = norm(a.name); return n.length >= 3 && ns.some((x) => x.includes(n) || n.includes(x) && x.length >= 4); }) ?? null;
  }
  if (!acc) return null;
  const stores = (await ctx.db.prepare('SELECT id, name, phone, address, landmark, zone FROM customers WHERE company_id = ? AND account_id = ? ORDER BY name')
    .bind(ctx.company.id, acc.id).all()).results;
  return { ...accountOut(acc), stores };
}

/**
 * Prix du bon face au prix convenu, ligne par ligne (même convention HT/TTC que l'enseigne) :
 * [{ index, product_id, doc, tariff, diff_pct }] pour les écarts de plus de 0,5 %.
 */
export async function priceChecks(ctx, account, lines) {
  const ids = [...new Set((lines ?? []).map((l) => l.product_id).filter(Boolean))];
  if (!account || !ids.length) return [];
  const map = new Map();
  for (const c of chunks(ids, 90)) {
    const r = await ctx.db.prepare(`SELECT product_id, price_fcfa FROM account_prices WHERE company_id = ? AND account_id = ? AND product_id IN (${c.map(() => '?').join(',')})`)
      .bind(ctx.company.id, account.id, ...c).all();
    for (const x of r.results) map.set(x.product_id, x.price_fcfa);
  }
  const out = [];
  (lines ?? []).forEach((l, index) => {
    const t = map.get(l.product_id); const d = num(l.unit_price);
    if (t == null || d == null) return;
    const diff = t ? ((d - t) / t) * 100 : d ? 100 : 0;
    if (Math.abs(diff) > 0.5) out.push({ index, product_id: l.product_id, doc: d, tariff: t, diff_pct: Math.round(diff * 10) / 10 });
  });
  return out;
}

export default {
  lg_accounts_list: {
    roles: READ,
    async handler(ctx) {
      const r = await ctx.db.prepare(
        `SELECT a.*, (SELECT count(*) FROM customers c WHERE c.account_id = a.id AND c.company_id = a.company_id) AS stores,
                (SELECT count(*) FROM account_prices p WHERE p.account_id = a.id) AS prices,
                (SELECT coalesce(sum(o.total_fcfa - o.shortage_fcfa), 0) FROM orders o WHERE o.company_id = a.company_id AND o.account_id = a.id
                   AND o.payment_terms_days IS NOT NULL AND o.payment_status <> 'paid' AND o.status <> 'cancelled') AS open_fcfa
           FROM accounts a WHERE a.company_id = ? ORDER BY a.active DESC, a.name`,
      ).bind(ctx.company.id).all();
      return r.results.map((a) => ({ ...accountOut(a), stores: a.stores, prices: a.prices, open_fcfa: a.open_fcfa }));
    },
  },

  // Fiche : conditions, magasins, et la grille (tous les produits actifs, prix convenu ou vide).
  lg_account_get: {
    roles: READ,
    async handler(ctx, a) {
      const acc = await accountFor(ctx, a.p_id);
      const base = Number(ctx.company.config.tva_rate ?? 18);
      const [prices, stores] = await ctx.db.batch([
        ctx.db.prepare(`SELECT p.id, p.name, p.sku, p.barcode, p.price_fcfa, p.vat_rate, ap.price_fcfa AS tariff, ap.updated_at
            FROM products p LEFT JOIN account_prices ap ON ap.product_id = p.id AND ap.account_id = ?
           WHERE p.company_id = ? AND (p.active = 1 OR ap.price_fcfa IS NOT NULL) ORDER BY ap.price_fcfa IS NULL, p.name LIMIT 2000`).bind(acc.id, ctx.company.id),
        ctx.db.prepare('SELECT id, name, phone, address, landmark, zone FROM customers WHERE company_id = ? AND account_id = ? ORDER BY name').bind(ctx.company.id, acc.id),
      ]);
      return {
        ...accountOut(acc), base_vat: base, stores: stores.results,
        prices: prices.results.map((p) => {
          const rate = acc.vat_exempt ? 0 : p.vat_rate ?? base;
          const catHt = Math.round((p.price_fcfa / (1 + (p.vat_rate ?? base) / 100)) * 100) / 100;
          return { product_id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, vat_rate: rate, catalogue_fcfa: p.price_fcfa, catalogue_ht: catHt,
            tariff: p.tariff, updated_at: p.updated_at };
        }),
      };
    },
  },

  lg_account_upsert: {
    roles: WRITE,
    async handler(ctx, a) {
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      const name = text(p.name, 120);
      if (!name || name.length < 2) fail('invalid_name');
      const terms = p.payment_terms_days == null || p.payment_terms_days === '' ? null : int(p.payment_terms_days);
      if (terms != null && !(terms >= 0 && terms <= 365)) fail('invalid_terms');
      const disc = num(p.discount_pct) ?? 0;
      if (!(disc >= 0 && disc <= 90)) fail('invalid_discount');
      const vals = [name, p.prices_ht === false ? 0 : 1, p.vat_exempt ? 1 : 0, disc, terms, text(p.sender_match, 120)?.toLowerCase() ?? null, text(p.ninea, 40), text(p.rc, 40),
        text(p.address, 200), text(p.email, 120), text(p.phone, 30), text(p.note, 500), p.active === false ? 0 : 1];
      try {
        if (p.id) {
          const r = await ctx.db.prepare(`UPDATE accounts SET name = ?, prices_ht = ?, vat_exempt = ?, discount_pct = ?, payment_terms_days = ?, sender_match = ?, ninea = ?, rc = ?,
              address = ?, email = ?, phone = ?, note = ?, active = ?, updated_at = ? WHERE id = ? AND company_id = ?`).bind(...vals, ctx.now, String(p.id), ctx.company.id).run();
          if (!r.meta.changes) fail('unknown_account', 404);
          await audit(ctx, 'account_update', 'account', p.id, { name });
          return { ok: true, id: p.id };
        }
        const id = uuid();
        await ctx.db.prepare(`INSERT INTO accounts (name, prices_ht, vat_exempt, discount_pct, payment_terms_days, sender_match, ninea, rc, address, email, phone, note, active,
            id, company_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...vals, id, ctx.company.id, ctx.now, ctx.now).run();
        await audit(ctx, 'account_create', 'account', id, { name });
        return { ok: true, id };
      } catch (e) {
        if (/UNIQUE/i.test(String(e?.message))) fail('duplicate_name', 409);
        throw e;
      }
    },
  },

  // Prix convenus : [{ product_id, price_fcfa }] ; price_fcfa vide = retirer le prix convenu de ce produit.
  lg_account_prices_set: {
    roles: WRITE,
    async handler(ctx, a) {
      const acc = await accountFor(ctx, a.p_account);
      const rows = Array.isArray(a.p_prices) ? a.p_prices : [];
      if (rows.length > MAX_PRICES) fail('too_many_lines');
      const stmts = [];
      for (const r of rows) {
        const pid = text(r?.product_id, 64); if (!pid) continue;
        if (r.price_fcfa == null || r.price_fcfa === '') {
          stmts.push(ctx.db.prepare('DELETE FROM account_prices WHERE account_id = ? AND product_id = ? AND company_id = ?').bind(acc.id, pid, ctx.company.id));
          continue;
        }
        const v = int(r.price_fcfa);
        if (!(v >= 0)) fail('invalid_amount');
        // le produit doit être de l'entreprise : insertion conditionnée
        stmts.push(ctx.db.prepare(`INSERT INTO account_prices (account_id, product_id, company_id, price_fcfa, updated_at)
            SELECT ?, id, company_id, ?, ? FROM products WHERE id = ? AND company_id = ?
            ON CONFLICT (account_id, product_id) DO UPDATE SET price_fcfa = excluded.price_fcfa, updated_at = excluded.updated_at`)
          .bind(acc.id, v, ctx.now, pid, ctx.company.id));
      }
      for (const c of chunks(stmts, 90)) await ctx.db.batch(c);
      await audit(ctx, 'account_prices', 'account', acc.id, { lines: stmts.length });
      return { ok: true, saved: stmts.length };
    },
  },

  // Import d'une grille (Excel/CSV lu par l'écran) : [{ code, price }] ; code = référence, code-barres ou nom exact.
  lg_account_prices_import: {
    roles: WRITE,
    async handler(ctx, a) {
      const acc = await accountFor(ctx, a.p_account);
      const rows = Array.isArray(a.p_rows) ? a.p_rows : [];
      if (rows.length > MAX_PRICES) fail('too_many_lines');
      const prods = (await ctx.db.prepare('SELECT id, name, sku, barcode FROM products WHERE company_id = ?').bind(ctx.company.id).all()).results;
      const by = new Map();
      for (const p of prods) for (const k of [p.sku, p.barcode, p.name]) if (k) by.set(norm(k), p.id);
      const unknown = []; const stmts = [];
      for (const r of rows) {
        const code = text(r?.code, 120); const v = int(String(r?.price ?? '').replace(/[\s  ]/g, '').replace(/,\d*$/, ''));
        if (!code) continue;
        const pid = by.get(norm(code));
        if (!pid || !(v >= 0)) { unknown.push(code); continue; }
        stmts.push(ctx.db.prepare(`INSERT INTO account_prices (account_id, product_id, company_id, price_fcfa, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (account_id, product_id) DO UPDATE SET price_fcfa = excluded.price_fcfa, updated_at = excluded.updated_at`).bind(acc.id, pid, ctx.company.id, v, ctx.now));
      }
      for (const c of chunks(stmts, 90)) await ctx.db.batch(c);
      await audit(ctx, 'account_prices_import', 'account', acc.id, { imported: stmts.length, unknown: unknown.length });
      return { ok: true, imported: stmts.length, unknown: unknown.slice(0, 100), unknown_count: unknown.length };
    },
  },

  // Magasin de l'enseigne : fiche client (créée ou mise à jour par son téléphone) rattachée à l'enseigne.
  lg_account_store_upsert: {
    roles: WRITE,
    async handler(ctx, a) {
      const acc = await accountFor(ctx, a.p_account);
      const s = a.p_store && typeof a.p_store === 'object' ? a.p_store : {};
      const name = text(s.name, 80); const phone = text(s.phone, 30); const key = phoneKey(phone);
      if (!name || name.length < 2 || !key) fail('invalid_customer');
      const zone = text(s.zone, 80);
      if (zone && !(await ctx.db.prepare('SELECT 1 FROM zones WHERE company_id = ? AND name = ?').bind(ctx.company.id, zone).first())) fail('unknown_zone');
      const id = uuid();
      const r = await ctx.db.prepare(`INSERT INTO customers (id, company_id, name, phone, phone_key, address, landmark, zone, account_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (company_id, phone_key) DO UPDATE SET name = excluded.name, phone = excluded.phone, address = coalesce(excluded.address, customers.address),
            landmark = coalesce(excluded.landmark, customers.landmark), zone = coalesce(excluded.zone, customers.zone), account_id = excluded.account_id,
            updated_at = excluded.updated_at RETURNING id`)
        .bind(id, ctx.company.id, name, phone, key, text(s.address, 200), text(s.landmark, 200), zone, acc.id, ctx.now, ctx.now).first();
      await audit(ctx, 'account_store', 'customer', r.id, { account: acc.id });
      return { ok: true, id: r.id };
    },
  },

  lg_account_store_unlink: {
    roles: WRITE,
    async handler(ctx, a) {
      const r = await ctx.db.prepare('UPDATE customers SET account_id = NULL, updated_at = ? WHERE id = ? AND company_id = ? AND account_id IS NOT NULL')
        .bind(ctx.now, String(a.p_customer ?? ''), ctx.company.id).run();
      if (!r.meta.changes) fail('unknown_customer', 404);
      return { ok: true };
    },
  },
};
