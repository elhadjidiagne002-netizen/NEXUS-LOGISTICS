// Relevé de reversement d'un vendeur (indicatif) : espace vendeur et comptable.
import React from 'react';
import { useRpc, Card, Badge, Btn, Empty, Icon, Loading, ErrorBox, Stat, formatF, dmy } from './ui.jsx';

const cell = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function exportStatement(s) {
  const lines = [['Commande', 'Livrée le', 'Client', 'Paiement', 'Produits (F)', 'Commission (F)', 'Net (F)', 'Réglée'],
    ...s.orders.map((o) => [o.short, dmy(o.delivered_at), o.customer ?? '', o.payment_method, o.goods_fcfa, o.commission_fcfa, o.net_fcfa, o.settled ? 'oui' : 'en attente']),
    [], ['Retenues'], ...s.deductions.map((d) => [d.package, dmy(d.at), d.cause, '', '', '', -d.amount_fcfa, '']),
    [], ['Net reversable', '', '', '', s.totals.goods_fcfa, s.totals.commission_fcfa, s.totals.net_payable_fcfa, '']];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `releve-${(s.vendor ?? 'vendeur').replace(/\W+/g, '-').toLowerCase()}_${s.from}_${s.to}.csv`; a.click();
}

export function VendorStatement({ from, to, vendor }) {
  const { data: s, error, loading } = useRpc('lg_vendor_statement', { p_from: from, p_to: to, p_vendor: vendor ?? null });
  if (loading && !s) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const k = s.totals;
  return <div className="stack">
    <div className="stats">
      <Stat icon="cash" c="#059669" label="net reversable" value={formatF(k.net_payable_fcfa)} kind={k.net_payable_fcfa < 0 ? 'bad' : 'ok'} />
      <Stat icon="clock" c="#ea580c" label={`en attente de rapprochement (${k.pending_orders})`} value={formatF(k.pending_fcfa)} />
      <Stat icon="box" label={`produits livrés (${k.orders} cde)`} value={formatF(k.goods_fcfa)} />
      <Stat icon="receipt" label={`commission ${Number(s.commission_rate)} %`} value={formatF(k.commission_fcfa)} />
      <Stat icon="refresh" c="#dc2626" label="retenues (retours)" value={formatF(k.deductions_fcfa)} kind={k.deductions_fcfa ? 'bad' : ''} />
    </div>
    <Card><div className="row between"><h3 style={{ margin: 0 }}>Commandes livrées</h3>
      <Btn size="sm" disabled={!s.orders.length && !s.deductions.length} onClick={() => exportStatement(s)}><Icon name="download" size={16} />Exporter (Excel)</Btn></div>
      {!s.orders.length ? <Empty>Aucune commande livrée sur la période.</Empty> :
        <div className="scroll-x" style={{ marginTop: 8 }}><table className="tbl"><thead><tr><th>Commande</th><th>Livrée</th><th>Paiement</th>
          <th className="num">Produits</th><th className="num">Commission</th><th className="num">Net</th><th></th></tr></thead>
          <tbody>{s.orders.map((o) => <tr key={o.order_id}><td className="mono">{o.short}</td><td>{dmy(o.delivered_at)}</td>
            <td>{{ cod: 'espèces', mobile: 'mobile', card: 'carte' }[o.payment_method] ?? o.payment_method}</td>
            <td className="num">{formatF(o.goods_fcfa)}</td><td className="num">−{formatF(o.commission_fcfa)}</td><td className="num"><b>{formatF(o.net_fcfa)}</b></td>
            <td>{o.settled ? <Badge kind="ok">réglée</Badge> : <Badge kind="todo">à rapprocher</Badge>}</td></tr>)}</tbody></table></div>}</Card>
    {s.deductions.length > 0 && <Card><h3>Retenues</h3><div className="list">{s.deductions.map((d, i) => <div key={i} className="line">
      <span className="mono small">{d.package}</span><span className="grow small">{d.cause}<div className="muted">{dmy(d.at)}</div></span><b style={{ color: 'var(--bad)' }}>−{formatF(d.amount_fcfa)}</b></div>)}</div></Card>}
    <p className="small muted">Relevé indicatif : produits réellement livrés (ruptures exclues, sans les frais de livraison), moins la commission et les frais de retour à votre charge.
      Les espèces deviennent reversables quand le voyage est rapproché. Le versement suit la procédure de reversement NEXUS Market.</p>
  </div>;
}
