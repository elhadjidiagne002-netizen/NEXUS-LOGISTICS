// Module 02 — Factures et avoirs, export comptable.
import React, { useState } from 'react';
import { rpc } from '../lib/backend.js';
import { printInvoice } from '../lib/print.js';
import { useMe, has } from '../App.jsx';
import { VendorStatement } from '../components/statement.jsx';
import { Icon, useRpc, useAction, useNav, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, formatF, dmy } from '../components/ui.jsx';

const iso = (d) => d.toISOString().slice(0, 10);
const MODE = { cod: 'livraison', prepaid: "d'avance", account: 'à terme', mobile: 'mobile', card: 'carte' };
const STATUS = { paid: ['payée', 'ok'], refunded: ['avoir', 'bad'], due: ['à régler', 'todo'], overdue: ['en retard', 'bad'] };
const VIA = [['transfer', 'Virement'], ['cheque', 'Chèque'], ['cash', 'Espèces'], ['mobile', 'Mobile money'], ['other', 'Autre']];
const csv = (rows) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  // point-virgule + virgule décimale : ouverture directe dans Excel en français
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(typeof r[c] === 'number' ? String(r[c]).replace('.', ',') : r[c])).join(';'))].join('\r\n');
};
const download = (name, content) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' })); a.download = name; a.click(); };

export default function Billing({ invoiceId }) {
  const me = useMe();
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(iso(now));
  const [q, setQ] = useState('');
  const { data, error, loading } = useRpc('lg_invoices_list', { p_from: from, p_to: to, p_q: q || null });
  const [run, busy] = useAction();
  const { go } = useNav();
  if (invoiceId) return <Invoice id={invoiceId} />;
  const exportAll = () => run(async () => {
    const x = await rpc('lg_accounting_export', { p_from: from, p_to: to });
    download(`journal-ventes_${from}_${to}.csv`, csv(x.sales_journal));
    download(`tva_${from}_${to}.csv`, csv(x.vat_by_rate));
    download(`encaissements_${from}_${to}.csv`, csv(x.collections_by_method));
    return { ok: true };
  }, { ok: 'Trois fichiers exportés' });
  const sum = (data ?? []).reduce((a, i) => ({ ttc: a.ttc + Number(i.ttc), tva: a.tva + Number(i.tva) }), { ttc: 0, tva: 0 });
  return <>
    <PageHead title="Factures et avoirs" back="/" />
    <Card><div className="grid cols-3">
      <Field label="Du"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label="Au"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      <Field label="Recherche (numéro, client)"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} /></Field></div>
      <div className="row between" style={{ marginTop: 10 }}><span className="small muted">{data?.length ?? 0} document(s) · TTC {formatF(sum.ttc)} · TVA {formatF(sum.tva)}</span>
        {has(me, 'accountant') && <Btn kind="primary" disabled={busy} onClick={exportAll}>Export comptable (CSV)</Btn>}</div></Card>
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : !data?.length ? <Card style={{ marginTop: 12 }}><Empty>Aucune facture sur la période.</Empty></Card> :
      <Card style={{ marginTop: 12 }}><div className="scroll-x"><table className="tbl"><thead><tr><th>Numéro</th><th>Date</th><th>Client</th><th>Commande</th><th>Mode</th><th className="num">TTC</th><th></th></tr></thead>
        <tbody>{data.map((i) => <tr key={i.id} style={{ cursor: 'pointer' }} onClick={() => go(`/factures/${i.id}`)}>
          <td className="mono">{i.number} {i.kind === 'credit_note' && <Badge kind="bad">avoir</Badge>}</td><td>{dmy(i.issued_at)}</td><td>{i.customer}</td>
          <td className="mono">{i.order_short}</td><td>{MODE[i.payment_method] ?? i.payment_method}</td>
          <td className="num">{formatF(i.ttc)}</td><td><Badge kind={STATUS[i.status]?.[1] ?? ''}>{STATUS[i.status]?.[0] ?? i.status}</Badge>
            {i.due_at && i.status !== 'paid' && <div className="small muted">échéance {dmy(i.due_at)}</div>}</td></tr>)}</tbody></table></div></Card>}
    {(has(me, 'accountant') || has(me, 'support')) && <Receivables canRecord={has(me, 'accountant')} />}
    {has(me, 'accountant') && <Payouts from={from} to={to} />}
    <Card kind="flat" style={{ marginTop: 12 }}><p className="small muted" style={{ margin: 0 }}>À trancher avec le comptable avant la première facture réelle (chapitre 11) :
      émetteur de la facture client (vendeur via NEXUS ou NEXUS), régime de TVA des vendeurs, calendrier de la facture électronique (DGID).</p></Card>
  </>;
}

function Invoice({ id }) {
  const me = useMe();
  const { data: inv, error, loading, reload } = useRpc('lg_invoice_get', { p_invoice: id });
  const [credit, setCredit] = useState(false);
  if (loading && !inv) return <Loading />;
  if (error) return <><PageHead title="Facture" back="/factures" /><ErrorBox error={error} /></>;
  const m = inv.metadata ?? {};
  return <>
    <PageHead title={`${inv.credit_of ? 'Avoir' : 'Facture'} ${inv.invoice_number}`} back="/factures">
      <Btn onClick={() => printInvoice(inv)}><Icon name="print" size={18} />PDF</Btn>
      {!inv.credit_of && has(me, 'accountant') && <Btn kind="bad" onClick={() => setCredit(true)}>Émettre un avoir</Btn>}
    </PageHead>
    <div className="grid cols-2">
      <Card><h3>Vendeur</h3><div>{m.seller?.name}</div><div className="small muted">NINEA {m.seller?.ninea ?? '—'} · RC {m.seller?.rc ?? '—'}</div></Card>
      <Card><h3>Client</h3><div>{m.customer?.name}</div><div className="small muted">{m.customer?.phone} · {m.customer?.address}</div></Card>
    </div>
    <Card style={{ marginTop: 12 }}><table className="tbl"><thead><tr><th>Désignation</th><th className="num">Qté</th><th className="num">P.U. HT</th><th className="num">TVA</th><th className="num">Total HT</th></tr></thead>
      <tbody>{inv.lines.map((l) => <tr key={l.position}><td>{l.label}</td><td className="num">{l.quantity}</td><td className="num">{Number(l.unit_price_ht).toFixed(2)}</td>
        <td className="num">{l.tva_rate} %</td><td className="num">{Number(l.total_ht).toFixed(2)}</td></tr>)}</tbody></table>
      <div className="right" style={{ marginTop: 10 }}><div>HT {formatF(inv.amount_ht)} · TVA {formatF(inv.tva)}</div><div className="big">TTC {formatF(inv.amount_ttc)}</div>
        <div className="small muted"><i>{m.amount_words}</i></div></div></Card>
    {inv.settlement && <Card style={{ marginTop: 12 }} kind={inv.settlement.paid ? '' : 'todo'}><h3>Règlement (à terme, {m.payment_terms_days} jours)</h3>
      {inv.settlement.paid ? <div>Réglée le {dmy(inv.settlement.paid_at)}{inv.settlement.ref ? ` · réf. ${inv.settlement.ref}` : ''}</div>
        : <div className="row between"><span>À régler{inv.settlement.due_at ? ` avant le ${dmy(inv.settlement.due_at)}` : ''}{m.customer_ref ? ` · bon client n° ${m.customer_ref}` : ''}</span>
          {has(me, 'accountant') && <RecordPayment orderId={inv.order_id} onDone={reload} />}</div>}</Card>}
    {inv.credits.length > 0 && <Card style={{ marginTop: 12 }}><h3>Avoirs liés</h3>{inv.credits.map((c) => <div key={c.number} className="line"><span className="mono grow">{c.number}</span>{formatF(c.ttc)}</div>)}</Card>}
    {credit && <CreditModal inv={inv} onClose={() => setCredit(false)} onDone={() => { setCredit(false); reload(); }} />}
  </>;
}

function CreditModal({ inv, onClose, onDone }) {
  const [q, setQ] = useState({}); const [reason, setReason] = useState(''); const [amount, setAmount] = useState('');
  const [run, busy] = useAction();
  const products = inv.lines.filter((l) => l.kind === 'product' && l.order_item_id);
  const lines = products.filter((l) => Number(q[l.position]) > 0).map((l) => ({ order_item_id: l.order_item_id, quantity: Number(q[l.position]) }));
  return <Modal title={`Avoir sur ${inv.invoice_number}`} onClose={onClose}><div className="stack">
    <p className="small muted">Une facture émise ne se modifie pas : l'avoir est numéroté dans sa propre séquence et lié à la facture.</p>
    {products.map((l) => <div key={l.position} className="line"><span className="grow">{l.label} <span className="muted small">(facturé {l.quantity})</span></span>
      <input className="input" style={{ width: 80 }} type="number" min={0} max={l.quantity} value={q[l.position] ?? ''} onChange={(e) => setQ({ ...q, [l.position]: e.target.value })} /></div>)}
    <Field label="Ou geste commercial global (F)"><input className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} /></Field>
    <Field label="Motif (obligatoire)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    <Btn kind="bad" size="xl" disabled={busy || !reason.trim() || (!amount && !lines.length)} onClick={() => run(async () => {
      const r = await rpc('lg_credit_note_manual', lines.length
        ? { p_invoice: inv.id, p_lines: lines, p_reason: reason }
        : { p_invoice: inv.id, p_lines: [], p_reason: reason, p_amount_fcfa: Number(amount) });
      onDone(); return r;
    }, { ok: 'Avoir émis' })}>Émettre l'avoir</Btn></div></Modal>;
}

// Reversements vendeurs (indicatifs) : net après commission et retenues, espèces rapprochées seulement
function Payouts({ from, to }) {
  const { data, error } = useRpc('lg_vendor_statements', { p_from: from, p_to: to });
  const [open, setOpen] = useState(null);
  return <Card style={{ marginTop: 12 }}><h3>Reversements vendeurs</h3><ErrorBox error={error} />
    {!data ? <Loading /> : !data.length ? <Empty>Aucun vendeur livré sur la période.</Empty> :
      <div className="scroll-x"><table className="tbl"><thead><tr><th>Vendeur</th><th className="num">Commandes</th><th className="num">Produits</th>
        <th className="num">Commission</th><th className="num">Retenues</th><th className="num">Net reversable</th><th className="num">En attente</th></tr></thead>
        <tbody>{data.map((v) => <tr key={v.vendor_id} style={{ cursor: 'pointer' }} onClick={() => setOpen(v)}><td>{v.vendor}</td><td className="num">{v.orders}</td>
          <td className="num">{formatF(v.goods_fcfa)}</td><td className="num">{formatF(v.commission_fcfa)}</td><td className="num">{formatF(v.deductions_fcfa)}</td>
          <td className="num"><b>{formatF(v.net_payable_fcfa)}</b></td><td className="num">{formatF(v.pending_fcfa)}</td></tr>)}</tbody></table></div>}
    {open && <Modal title={`Relevé · ${open.vendor}`} onClose={() => setOpen(null)}><VendorStatement from={from} to={to} vendor={open.vendor_id} /></Modal>}
  </Card>;
}

/** Règlement reçu d'une commande à terme (virement, chèque…) : date, mode, référence. */
function RecordPayment({ orderId, onDone }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ via: 'transfer', ref: '', day: iso(new Date()) });
  const [run, busy] = useAction();
  if (!open) return <Btn kind="ok" size="sm" onClick={() => setOpen(true)}>Enregistrer le règlement</Btn>;
  return <Modal title="Règlement reçu" onClose={() => setOpen(false)}><div className="stack">
    <Field label="Mode"><select className="input" value={f.via} onChange={(e) => setF({ ...f, via: e.target.value })}>{VIA.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
    <Field label="Référence (n° de virement, de chèque…)"><input className="input" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></Field>
    <Field label="Reçu le"><input className="input" type="date" value={f.day} max={iso(new Date())} onChange={(e) => setF({ ...f, day: e.target.value })} /></Field>
    <Btn kind="primary" disabled={busy} onClick={() => run(async () => {
      const r = await rpc('lg_order_record_payment', { p_order: orderId, p_via: f.via, p_ref: f.ref || null, p_paid_on: f.day });
      setOpen(false); onDone?.(); return r;
    }, { ok: 'Règlement enregistré' })}>Enregistrer</Btn></div></Modal>;
}

/** Créances à terme : balance âgée, clients qui doivent le plus, factures à régler ou en retard. */
function Receivables({ canRecord }) {
  const [state, setState] = useState('open');
  const { data, error, loading, reload } = useRpc('lg_receivables', { p_state: state });
  const { go } = useNav();
  const nb = (data?.list ?? []).length;
  return <Card style={{ marginTop: 12 }}>
    <div className="row between"><h3 style={{ margin: 0 }}>Créances à terme</h3>
      <select className="input" style={{ width: 'auto' }} value={state} onChange={(e) => setState(e.target.value)}>
        <option value="open">À recevoir</option><option value="overdue">En retard</option><option value="paid">Réglées</option></select></div>
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : !data ? null : <>
      {state !== 'paid' && <div className="grid cols-3" style={{ marginTop: 10 }}>
        <div><div className="small muted">À recevoir</div><div className="big">{formatF(data.total_open_fcfa)}</div></div>
        <div><div className="small muted">Dont en retard</div><div className="big" style={{ color: data.overdue_fcfa ? 'var(--bad)' : undefined }}>{formatF(data.overdue_fcfa)}</div></div>
        <div className="small">Pas échu {formatF(data.aging.not_due)}<br />Retard ≤ 30 j {formatF(data.aging.d0_30)}<br />31–60 j {formatF(data.aging.d31_60)} · + 60 j {formatF(data.aging.d60_plus)}</div></div>}
      {state !== 'paid' && data.customers.length > 1 && <p className="small muted">{data.customers.slice(0, 5).map((c) => `${c.customer} : ${formatF(c.owed_fcfa)}${c.overdue_fcfa ? ` (dont ${formatF(c.overdue_fcfa)} en retard)` : ''}`).join(' · ')}</p>}
      {!nb ? <Empty>{state === 'paid' ? 'Aucun règlement enregistré.' : 'Aucune créance.'}</Empty> :
        <div className="scroll-x"><table className="tbl"><thead><tr><th>Commande</th><th>Client</th><th>Bon client</th><th>Facture</th><th>Échéance</th><th className="num">Montant</th><th></th></tr></thead>
          <tbody>{data.list.map((r) => <tr key={r.order_id}>
            <td className="mono">{r.number}</td><td>{r.customer}</td><td className="mono">{r.customer_ref ?? ''}</td><td className="mono">{r.invoice ?? <span className="muted">à livrer</span>}</td>
            <td>{r.paid ? `réglée le ${dmy(r.paid_at)}` : r.due_at ? <>{dmy(r.due_at)} {r.days_late != null ? <Badge kind="bad">{r.days_late} j de retard</Badge> : <span className="small muted">dans {r.days_left} j</span>}</> : <span className="muted">{r.terms_days} j après livraison</span>}
              {r.reminded && !r.paid && <div className="small muted">relancé</div>}</td>
            <td className="num">{formatF(r.owed_fcfa)}</td>
            <td>{!r.paid && canRecord && <RecordPayment orderId={r.order_id} onDone={reload} />}{r.paid && r.payment_ref ? <span className="small">réf. {r.payment_ref}</span> : null}</td></tr>)}</tbody></table></div>}
    </>}
  </Card>;
}
