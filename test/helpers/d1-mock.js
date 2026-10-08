// D1 imitée sur node:sqlite : même API (prepare/bind/first/all/run, batch atomique) que Cloudflare D1.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

class Stmt {
  constructor(d1, sql, params = []) {
    this.d1 = d1;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Stmt(this.d1, this.sql, params.map(norm));
  }
  _stmt() {
    this.d1.queries++;
    // Aussi strict que Cloudflare D1 : le nombre de paramètres liés doit correspondre à la requête.
    const sql = this.sql.replace(/'(?:[^']|'')*'/g, '');
    const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
    const expected = numbered.length ? Math.max(...numbered) : (sql.match(/\?/g) || []).length;
    if (this.params.length !== expected) throw new Error(`D1_ERROR: Wrong number of parameter bindings for SQL query (${this.params.length} liés, ${expected} attendus) : ${this.sql.slice(0, 80)}`);
    return this.d1.db.prepare(this.sql);
  }
  _exec() {
    const st = this._stmt();
    if (/^\s*(SELECT|WITH)/i.test(this.sql) || /RETURNING/i.test(this.sql)) {
      const rows = st.all(...this.params);
      return { success: true, results: rows.map((r) => ({ ...r })), meta: { changes: 0 } };
    }
    const r = st.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(col) {
    const row = this._stmt().get(...this.params);
    if (!row) return null;
    return col ? row[col] : { ...row };
  }
  async all() { return this._exec(); }
  async run() { return this._exec(); }
}

export class D1Mock {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.queries = 0;
    this.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
      if (this.db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(f)) continue;
      this.db.exec(readFileSync(migrationsDir + f, 'utf8'));
      this.db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    }
  }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s._exec());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql) { this.db.exec(sql); return { count: 1 }; }
}
