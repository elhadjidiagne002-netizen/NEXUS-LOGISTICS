// Productivité de la préparation (module 01, P2) : partagé entre Pilotage et Entrepôt.
import React, { useState } from 'react';
import { useRpc, Card, Empty, Loading, ErrorBox, Chips, Stat } from './ui.jsx';

const iso = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
const pct = (v) => (v == null ? '—' : `${v} %`);
const SIZE = { small: 'Petit (< 5 L)', medium: 'Moyen (5–30 L)', large: 'Grand (> 30 L)', unmeasured: 'Sans dimensions' };

export function PickProductivity() {
  const [range, setRange] = useState('7');
  const { data, error, loading } = useRpc('lg_pick_productivity',
    { p_from: iso(new Date(Date.now() - (Number(range) - 1) * 864e5)), p_to: iso(new Date()) });
  const k = data?.totals;
  return <div className="stack">
    <Chips options={[['1', 'Aujourd\'hui'], ['7', '7 jours'], ['30', '30 jours']]} value={range} onChange={setRange} />
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : data && <>
      <div className="stats">
        <Stat icon="box" label="commandes préparées" value={k.orders} />
        <Stat icon="layers" label="lignes · unités" value={`${k.lines} · ${k.units}`} />
        <Stat icon="clock" label="lignes par heure" value={k.lines_per_hour ?? '—'} />
        <Stat icon="alert" c="#dc2626" label="lignes en rupture" value={pct(k.short_pct)} kind={k.short_pct > 5 ? 'bad' : ''} />
        <Stat icon="print" label="colis fermés" value={k.packages} />
      </div>
      <Card><h3>Par préparateur</h3>{!data.pickers.length ? <Empty icon="box">Aucune préparation terminée sur la période.</Empty> :
        <div className="scroll-x"><table className="tbl"><thead><tr><th>Préparateur</th><th className="num">Commandes</th><th className="num">Lignes</th>
          <th className="num">Temps</th><th className="num">Lignes / h</th><th className="num">Saisie manuelle</th><th className="num">Mauvais scans</th>
          <th className="num">Écarts au contrôle</th><th className="num">Erreurs / 100 lignes</th></tr></thead>
          <tbody>{data.pickers.map((p) => <tr key={p.picker_id}><td>{p.name}</td><td className="num">{p.orders}</td><td className="num">{p.lines}</td>
            <td className="num">{p.minutes >= 60 ? `${Math.floor(p.minutes / 60)} h ${String(p.minutes % 60).padStart(2, '0')}` : `${p.minutes} min`}</td>
            <td className="num"><b>{p.lines_per_hour ?? '—'}</b></td><td className="num">{pct(p.manual_pct)}</td><td className="num">{p.wrong_scans}</td>
            <td className="num">{p.check_errors}</td><td className="num" style={{ color: p.error_pct > 2 ? 'var(--bad)' : undefined }}>{p.error_pct ?? '—'}</td></tr>)}</tbody></table></div>}
        <p className="small muted">Temps : de la prise à la fermeture de chaque commande ; une vague compte une seule fois. Erreurs : produit inattendu scanné + écart trouvé au double contrôle.</p></Card>
      <div className="grid cols-2">
        <Card><h3>Ruptures par vendeur</h3>{!data.vendors.length ? <Empty icon="check">Rien sur la période.</Empty> :
          <div className="list">{data.vendors.map((v) => <div key={v.vendor_id ?? 'hub'} className="line">
            <span className="grow">{v.name}<div className="small muted">{v.orders} commande(s) · {v.lines} ligne(s) · préparé en {v.prep_hours ?? '—'} h en moyenne</div></span>
            <b style={{ color: v.short_pct > 5 ? 'var(--bad)' : 'var(--ok)' }}>{pct(v.short_pct)}</b></div>)}</div>}</Card>
        <Card><h3>Emballages consommés</h3>{!data.packaging.length ? <Empty icon="box">Aucun colis.</Empty> :
          <div className="list">{data.packaging.map((p) => <div key={p.size} className="line">
            <span className="grow">{SIZE[p.size]}<div className="small muted">{p.avg_weight_g ? `${(p.avg_weight_g / 1000).toFixed(1)} kg en moyenne` : ''}</div></span><b>{p.count}</b></div>)}</div>}
          <p className="small muted">D'après les dimensions saisies au colisage : utile pour commander les cartons.</p></Card>
      </div>
    </>}
  </div>;
}
