// Module 08 — Caisse : attendu contre versé, écart, reçu. Le voyage n'est « rapproché »
// que lorsque la caisse est versée sans écart non résolu et les retours scannés au quai.
import React, { useState } from 'react';
import { act } from '../lib/offline.js';
import { printReceipt } from '../lib/print.js';
import { Icon, useRpc, useAction, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, formatF, hhmm, dmy } from '../components/ui.jsx';

export default function Cash() {
  const { data, error, loading, reload } = useRpc('lg_cash_desk', {}, { refresh: 20000 });
  const [trip, setTrip] = useState(null);
  const [drop, setDrop] = useState(null);
  if (loading && !data) return <Loading />;
  return <>
    <PageHead title="Caisse" back="/" />
    <ErrorBox error={error} />
    {data?.on_road?.length > 0 && <><h2>Sur la route</h2>
      <div className="grid cols-2" style={{ marginBottom: 16 }}>{data.on_road.map((t) => <Card key={t.id} kind={t.over_limit ? 'bad' : ''}>
        <div className="row between"><b>V{t.number} · {t.courier}</b>{t.over_limit && <Badge kind="bad">plafond dépassé</Badge>}</div>
        <div className="row between"><span className="small muted">espèces portées (plafond {formatF(t.limit_fcfa)})</span><b className="big">{formatF(t.outstanding_fcfa)}</b></div>
        <Btn block onClick={() => setDrop(t)}>Versement intermédiaire</Btn></Card>)}</div></>}
    <h2>Voyages à clôturer</h2>
    {data?.to_close.length === 0 ? <Card><Empty>Aucun versement en attente.</Empty></Card> :
      <div className="grid cols-2">{data?.to_close.map((t) => <Card key={t.id} kind="todo">
        <div className="row between"><h3 style={{ margin: 0 }}>V{t.number} · {t.courier}</h3><span className="small muted">fini à {hhmm(t.ended_at)}</span></div>
        <div className="small">{t.delivered} livré(s) · {t.failed} échec(s) · mobile {formatF(t.mobile_collected_fcfa)}</div>
        <div className="money">{formatF(t.cash_to_remit_fcfa)}</div><div className="small muted">espèces attendues</div>
        {t.packages_to_return.length > 0 && <div className="small" style={{ color: 'var(--todo)' }}><Icon name="alert" size={14} /> {t.packages_to_return.length} colis à rendre au quai avant rapprochement</div>}
        {t.remitted ? <Badge kind="info">versé · en attente de rapprochement</Badge>
          : <Btn kind="primary" block onClick={() => setTrip(t)}>Compter et valider</Btn>}
      </Card>)}</div>}
    <h2 style={{ marginTop: 20 }}>Derniers versements</h2>
    <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Voyage</th><th>Chauffeur</th><th className="num">Attendu</th><th className="num">Versé</th><th className="num">Écart</th><th>Le</th><th>Statut</th></tr></thead>
      <tbody>{data?.recent.map((r, i) => <tr key={i}><td>V{r.trip_number}</td><td>{r.courier}</td><td className="num">{formatF(r.expected_fcfa)}</td>
        <td className="num">{formatF(r.remitted_fcfa)}</td><td className="num" style={{ color: r.gap_fcfa ? 'var(--bad)' : undefined, fontWeight: r.gap_fcfa ? 700 : 400 }}>{r.gap_fcfa > 0 ? '+' : ''}{formatF(r.gap_fcfa)}</td>
        <td>{dmy(r.validated_at)} {hhmm(r.validated_at)}</td><td>{r.trip_status === 'reconciled' ? <Badge kind="ok">rapproché</Badge> : <Badge kind="todo">en attente</Badge>}</td></tr>)}</tbody></table></div></Card>
    {trip && <Count t={trip} onClose={() => setTrip(null)} onDone={() => { setTrip(null); reload(); }} />}
    {drop && <Drop t={drop} onClose={() => setDrop(null)} onDone={() => { setDrop(null); reload(); }} />}
  </>;
}

const NOTES = [10000, 5000, 2000, 1000, 500];
function Count({ t, onClose, onDone }) {
  const [n, setN] = useState(Object.fromEntries(NOTES.map((v) => [v, ''])));
  const [coins, setCoins] = useState('');
  const [note, setNote] = useState('');
  const [run, busy] = useAction();
  const total = NOTES.reduce((s, v) => s + v * (Number(n[v]) || 0), 0) + (Number(coins) || 0);
  const gap = total - t.cash_to_remit_fcfa;
  return <Modal title={`Versement · V${t.number} · ${t.courier}`} onClose={onClose}><div className="stack">
    <div className="row between"><span>Attendu</span><b className="big">{formatF(t.cash_to_remit_fcfa)}</b></div>
    <div className="grid cols-3">{NOTES.map((v) => <Field key={v} label={`Billets de ${formatF(v)}`}>
      <input className="input" inputMode="numeric" value={n[v]} onChange={(e) => setN({ ...n, [v]: e.target.value.replace(/\D/g, '') })} /></Field>)}
      <Field label="Pièces (total)"><input className="input" inputMode="numeric" value={coins} onChange={(e) => setCoins(e.target.value.replace(/\D/g, ''))} /></Field></div>
    <div className={`flash ${gap === 0 ? 'ok' : 'bad'}`}><div style={{ flex: 1 }}><div className="row between"><span>Compté</span><b className="big">{formatF(total)}</b></div>
      <div className="row between"><span>Écart</span><b>{gap > 0 ? '+' : ''}{formatF(gap)}</b></div></div></div>
    {gap !== 0 && <><p className="small">Un écart ouvre un incident ; le voyage reste « non rapproché » jusqu'à décision.</p>
      <Field label="Explication"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field></>}
    <Btn kind="primary" size="xl" disabled={busy || (gap !== 0 && !note.trim())} onClick={() => run(async () => {
      const r = await act('lg_remit_cash', { p_trip: t.id, p_remitted_fcfa: total, p_note: note || null }, `Versement V${t.number}`);
      if (r.ok && r.receipt) printReceipt(`NEXUS LOGISTICS\n${r.receipt}\nChauffeur : ${t.courier}\nAttendu : ${formatF(r.expected_fcfa)}\nVersé : ${formatF(r.remitted_fcfa)}\nÉcart : ${formatF(r.gap_fcfa)}\n\nSignature caissier :\n\nSignature chauffeur :`, `Reçu V${t.number}`);
      onDone(); return r;
    }, { ok: 'Versement enregistré' })}>Valider le versement</Btn></div></Modal>;
}

// Plafond d'encours : le chauffeur dépose une partie des espèces sans clôturer son voyage
function Drop({ t, onClose, onDone }) {
  const [amount, setAmount] = useState(String(t.outstanding_fcfa));
  const [run, busy] = useAction();
  return <Modal title={`Versement intermédiaire · V${t.number}`} onClose={onClose}><div className="stack">
    <p>{t.courier} porte <b>{formatF(t.outstanding_fcfa)}</b>.</p>
    <Field label="Montant compté (F)"><input className="input big" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} /></Field>
    <Btn kind="primary" size="xl" disabled={busy || !Number(amount)} onClick={() => run(async () => {
      const r = await act('lg_cash_drop', { p_trip: t.id, p_amount_fcfa: Number(amount) }, `Versement intermédiaire V${t.number}`);
      if (r.ok && r.receipt) printReceipt(`NEXUS LOGISTICS\n${r.receipt}\nChauffeur : ${t.courier}\nReste porté : ${formatF(r.outstanding)}\n\nSignature caissier :\n\nSignature chauffeur :`, 'Reçu');
      if (r.ok) onDone(); return r;
    }, { ok: 'Versement enregistré, le chauffeur peut repartir' })}>Valider</Btn></div></Modal>;
}
