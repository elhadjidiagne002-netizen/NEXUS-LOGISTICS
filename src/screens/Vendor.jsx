// Module 09 — Espace vendeur : suivre ses colis sans appeler, compléter ses fiches (code, poids, taille),
// voir ses lots qui périment à l'entrepôt.
import React, { useState } from 'react';
import { rpc } from '../lib/backend.js';
import { useRpc, useAction, useNav, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Stat, Tabs, Chips, StatusBadge, HANDLING, ago } from '../components/ui.jsx';

export default function Vendor() {
  const { data: o, error, loading } = useRpc('lg_vendor_overview', {}, { refresh: 30000 });
  const [tab, setTab] = useState('packages');
  const { go } = useNav();
  const lots = useRpc('lg_lots_expiring', {});
  if (loading && !o) return <Loading />;
  if (error) return <><PageHead title="Espace vendeur" back="/" /><ErrorBox error={error} /></>;
  return <>
    <PageHead title="Espace vendeur" back="/"><Btn kind="primary" onClick={() => go('/preparation')}>Préparer mes commandes ({o.to_prepare})</Btn></PageHead>
    <div className="stats">
      <Stat label="à préparer" value={o.to_prepare} kind={o.to_prepare ? 'todo' : ''} />
      <Stat label="en route" value={o.in_transit} />
      <Stat label="retours" value={o.returns} kind={o.returns ? 'bad' : ''} />
      <Stat label="délai moyen de préparation (30 j)" value={o.avg_prep_hours_30d != null ? `${o.avg_prep_hours_30d} h` : '—'} />
      <Stat label="taux de rupture (30 j)" value={o.stockout_pct_30d != null ? `${o.stockout_pct_30d} %` : '—'} kind={o.stockout_pct_30d > 5 ? 'bad' : ''} />
      <Stat label="fiches à compléter" value={o.products_missing_data} kind={o.products_missing_data ? 'todo' : 'ok'} />
    </div>
    <div style={{ marginTop: 12 }}><Tabs value={tab} onChange={setTab} tabs={[['packages', 'Mes colis'], ['commitment', 'Mon engagement'], ['products', 'Fiches produit'], ['lots', `Péremption${lots.data?.length ? ` (${lots.data.length})` : ''}`]]} /></div>
    {tab === 'packages' && <Card>{o.packages.length === 0 ? <Empty>Aucun colis ces 30 derniers jours.</Empty> :
      <div className="list">{o.packages.map((p) => <div key={p.code} className="line"><span className="mono">{p.code}</span>
        <span className="grow small muted">Cde {p.order_short} · {p.zone ?? ''} · {ago(p.updated_at)}</span>{p.attempts > 0 && <Badge kind="todo">{p.attempts} échec(s)</Badge>}<StatusBadge s={p.status} /></div>)}</div>}</Card>}
    {tab === 'products' && <Products />}
    {tab === 'commitment' && <Commitment />}
    {tab === 'lots' && <Card><ErrorBox error={lots.error} />{!lots.data?.length ? <Empty>Aucun de vos lots ne périme dans les 30 prochains jours.</Empty> :
      <div className="list">{lots.data.map((l) => <div key={l.id} className="line"><span className={`dot ${l.state === 'expired' ? 'bad' : 'todo'}`} />
        <span className="grow"><b>{l.product}</b><div className="small muted">{l.lot ? `lot ${l.lot}` : 'sans n° de lot'} · {l.qty} unité(s) à l'entrepôt</div></span>
        <Badge kind={l.state === 'expired' ? 'bad' : 'todo'}>{l.days_left < 0 ? 'périmé' : `${l.expires_on.split('-').reverse().join('/')} · J-${l.days_left}`}</Badge></div>)}</div>}
      <p className="small muted">Pensez à une promotion sur le site avant la date, ou demandez leur retour au chef de quai.</p></Card>}
  </>;
}

function Products() {
  const { data, error, loading, reload } = useRpc('lg_products_to_complete', {});
  const [run] = useAction();
  const [edit, setEdit] = useState({});
  const save = (p) => run(async () => {
    const e = edit[p.id] ?? {};
    const r = await rpc('lg_product_logistics', { p_product: p.id, p_barcode: e.barcode ?? null, p_sku: e.sku ?? null,
      p_weight_g: e.weight ? Math.round(Number(String(e.weight).replace(',', '.')) * 1000) : null,
      p_length_cm: e.l ? Number(e.l) : null, p_width_cm: e.w ? Number(e.w) : null, p_height_cm: e.h ? Number(e.h) : null, p_handling: e.handling ?? null });
    setEdit({ ...edit, [p.id]: undefined }); reload(); return r;
  }, { ok: 'Fiche mise à jour' });
  // import par fichier : CSV « id;code_barres;reference;poids_kg;longueur;largeur;hauteur »
  const importCsv = (file) => run(async () => {
    const rows = (await file.text()).split(/\r?\n/).slice(1).map((l) => l.split(/[;,]/)).filter((c) => c[0]);
    let n = 0;
    for (const [id, barcode, sku, weight, l, w, h] of rows) {
      await rpc('lg_product_logistics', { p_product: id.trim(), p_barcode: barcode || null, p_sku: sku || null,
        p_weight_g: weight ? Math.round(Number(weight.replace(',', '.')) * 1000) : null, p_length_cm: l ? Number(l) : null, p_width_cm: w ? Number(w) : null, p_height_cm: h ? Number(h) : null });
      n++;
    }
    reload(); return { ok: true, n };
  }, { ok: 'Import terminé' });
  const template = () => {
    const lines = ['id;code_barres;reference;poids_kg;longueur_cm;largeur_cm;hauteur_cm', ...(data ?? []).map((p) => [p.id, p.barcode ?? '', p.sku ?? '', p.weight_g ? p.weight_g / 1000 : '', p.length_cm ?? '', p.width_cm ?? '', p.height_cm ?? ''].join(';'))];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' })); a.download = 'fiches-produit.csv'; a.click();
  };
  if (loading && !data) return <Loading />;
  return <div className="stack"><ErrorBox error={error} />
    <Card kind="flat"><div className="row between"><span className="small">Code-barres et poids rendent possibles le « bip » à la préparation et le prix de livraison au panier.</span>
      <div className="row"><Btn size="sm" onClick={template}>Télécharger le fichier</Btn>
        <label className="btn sm">Importer un fichier<input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files[0] && importCsv(e.target.files[0])} /></label></div></div></Card>
    {(data ?? []).map((p) => {
      const e = edit[p.id]; const missing = !p.weight_g || (!p.barcode && !p.sku);
      return <Card key={p.id} kind={missing ? 'todo' : 'ok'}>
        <div className="row between"><b>{p.name}</b><span className="small muted mono">{p.internal_code}</span></div>
        {!e ? <div className="row between"><span className="small">{p.barcode ?? 'pas de code-barres'} · {p.sku ?? 'pas de référence'} · {p.weight_g ? `${p.weight_g / 1000} kg` : 'poids ?'}
          {p.length_cm ? ` · ${p.length_cm}×${p.width_cm}×${p.height_cm} cm` : ''} {(p.handling ?? []).map((h) => <Badge key={h}>{h}</Badge>)}</span>
          <Btn size="sm" onClick={() => setEdit({ ...edit, [p.id]: { handling: p.handling ?? [] } })}>Compléter</Btn></div>
          : <div className="stack">
            <div className="grid cols-3">
              <input className="input" placeholder="Code-barres" defaultValue={p.barcode ?? ''} onChange={(x) => setEdit({ ...edit, [p.id]: { ...e, barcode: x.target.value } })} />
              <input className="input" placeholder="Référence" defaultValue={p.sku ?? ''} onChange={(x) => setEdit({ ...edit, [p.id]: { ...e, sku: x.target.value } })} />
              <input className="input" placeholder="Poids (kg)" inputMode="decimal" defaultValue={p.weight_g ? p.weight_g / 1000 : ''} onChange={(x) => setEdit({ ...edit, [p.id]: { ...e, weight: x.target.value } })} />
              {['l', 'w', 'h'].map((k, i) => <input key={k} className="input" inputMode="numeric" placeholder={['Longueur cm', 'Largeur cm', 'Hauteur cm'][i]}
                onChange={(x) => setEdit({ ...edit, [p.id]: { ...e, [k]: x.target.value } })} />)}</div>
            <Chips multi options={HANDLING} value={e.handling ?? []} onChange={(v) => setEdit({ ...edit, [p.id]: { ...e, handling: v } })} />
            <div className="row"><Btn kind="primary" onClick={() => save(p)}>Enregistrer</Btn><Btn kind="ghost" onClick={() => setEdit({ ...edit, [p.id]: undefined })}>Annuler</Btn></div></div>}
      </Card>;
    })}</div>;
}

// Engagement de délai (P2) : le vendeur promet un délai de préparation, mesuré et relancé
const left = (m) => (m < 0 ? `en retard de ${fmtMin(-m)}` : `reste ${fmtMin(m)}`);
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);
function Commitment() {
  const { data: c, error, loading, reload } = useRpc('lg_my_commitment', {}, { refresh: 60000 });
  const [hours, setHours] = useState('');
  const [run, busy] = useAction();
  if (loading && !c) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const save = (h) => run(async () => { const r = await rpc('lg_vendor_commitment_set', { p_hours: h }); setHours(''); reload(); return r; },
    { ok: h ? 'Engagement enregistré' : 'Engagement retiré' });
  return <div className="stack">
    <Card><h3>Mon délai de préparation</h3>
      {c.prep_hours ? <p style={{ margin: '0 0 10px' }}>Je m'engage à préparer chaque commande en <b>{c.prep_hours} h</b> au plus. Vous êtes prévenu par WhatsApp 2 h avant l'échéance, puis en cas de retard.</p>
        : <p className="muted" style={{ margin: '0 0 10px' }}>Aucun engagement : vos commandes ont 24 h par défaut et vous ne recevez pas de rappel.</p>}
      <div className="row"><Chips options={[['4', '4 h'], ['8', '8 h'], ['12', '12 h'], ['24', '24 h'], ['48', '48 h']]} value={hours || String(c.prep_hours ?? '')} onChange={setHours} />
        <Btn kind="primary" disabled={busy || !hours || Number(hours) === c.prep_hours} onClick={() => save(Number(hours))}>Enregistrer</Btn>
        {c.prep_hours && <Btn kind="ghost" disabled={busy} onClick={() => save(null)}>Retirer</Btn>}</div>
      <p className="small muted">Le délai s'applique aux nouvelles commandes. Il est affiché aux équipes NEXUS avec votre ponctualité.</p></Card>
    <div className="stats">
      <Stat label="à l'heure (30 j)" value={c.on_time_pct != null ? `${c.on_time_pct} %` : '—'} kind={c.on_time_pct == null ? '' : c.on_time_pct >= 90 ? 'ok' : 'todo'} />
      <Stat label="commandes préparées" value={c.done} />
      <Stat label="délai moyen" value={c.avg_hours != null ? `${c.avg_hours} h` : '—'} />
      <Stat label="en retard maintenant" value={c.open_late} kind={c.open_late ? 'bad' : 'ok'} />
    </div>
    <Card><h3>À préparer</h3>{!c.tasks.length ? <Empty>Aucune commande en attente.</Empty> :
      <div className="list">{c.tasks.map((x) => <div key={x.task_id} className="line"><span className="mono">{x.order_short}</span>
        <span className="grow small muted">{x.status === 'picking' ? 'en cours' : 'à faire'}</span>
        {x.minutes_left != null && <Badge kind={x.minutes_left < 0 ? 'bad' : x.minutes_left < 120 ? 'todo' : 'info'}>{left(x.minutes_left)}</Badge>}</div>)}</div>}</Card>
  </div>;
}
