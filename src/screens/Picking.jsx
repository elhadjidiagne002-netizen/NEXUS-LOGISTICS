// Module 01 — Préparation de commandes (préparateur du hub, ou vendeur en modèle A).
import React, { useMemo, useState } from 'react';
import { rpc } from '../lib/backend.js';
import { act } from '../lib/offline.js';
import { errText } from '../lib/errors.js';
import { printLabels } from '../lib/print.js';
import { isPackageCode } from '../lib/algo.js';
import { Icon, useRpc, useAction, useNav, useToast, feedback, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field,
  Chips, StatusBadge, HANDLING, hhmm, kg, ago } from '../components/ui.jsx';
import { Scanner } from '../components/field.jsx';
import { useMe, has } from '../App.jsx';

export default function Picking({ taskId, sub }) {
  if (taskId === 'vague' && sub) return <Wave id={sub} />;
  return taskId ? <Task id={taskId} /> : <Queue />;
}

function Queue() {
  const { data, error, loading, reload } = useRpc('lg_pick_queue', {}, { refresh: 15000 });
  const { go } = useNav();
  const [run, busy] = useAction();
  const [sel, setSel] = useState([]);
  const waves = useRpc('lg_my_waves', {}, { refresh: 30000 });
  const me = useMe();
  const canWave = has(me, 'picker', 'dock_chief');
  return <>
    <PageHead title="Préparation" back="/"><Badge kind="todo">{data?.length ?? 0} à préparer</Badge>
      {canWave && sel.length >= 2 && <Btn kind="primary" disabled={busy} onClick={() => run(async () => {
        const r = await rpc('lg_wave_create', { p_tasks: sel }); setSel([]); go(`/preparation/vague/${r.wave_id}`); return r;
      })}><Icon name="layers" size={18} />Préparer en vague ({sel.length})</Btn>}</PageHead>
    {canWave && <p className="page-sub">Cochez plusieurs commandes pour les prélever en un seul passage dans les rayons.</p>}
    {waves.data?.length > 0 && <div className="row" style={{ marginBottom: 12 }}>{waves.data.map((w) =>
      <Btn key={w.id} onClick={() => go(`/preparation/vague/${w.id}`)}><Icon name="layers" size={18} />Vague n° {w.number} · {w.open} bac(s) en cours</Btn>)}</div>}
    <div className="split">
      <div className="stack">
        <ErrorBox error={error} />
        {loading && !data ? <Loading /> : data?.length === 0 ? <Card><Empty icon="check">Rien à préparer pour l'instant.</Empty></Card> :
          data?.map((t) => {
            const late = t.cutoff_at && new Date(t.cutoff_at) < new Date();
            return <Card key={t.id} kind={t.locked ? '' : late ? 'bad' : 'todo'}>
              <div className="row between">
                {canWave && !t.locked && <input type="checkbox" aria-label="Ajouter à la vague" style={{ width: 22, height: 22, accentColor: 'var(--primary)' }}
                  checked={sel.includes(t.id)} onChange={(e) => setSel(e.target.checked ? [...sel, t.id] : sel.filter((x) => x !== t.id))} />}
                <div style={{ flex: 1 }}><h3 style={{ margin: 0 }}>Commande {t.order_short} <span className="muted small">· {t.zone ?? 'zone ?'}</span></h3>
                  <div className="small muted">{t.vendor_name} · {t.lines} ligne(s), {t.units} article(s) · {t.payment_method === 'cod' ? 'à la livraison' : t.payment_terms_days != null ? 'à terme' : 'payée'}</div>
                  <div className={`small ${late ? '' : 'muted'}`} style={late ? { color: 'var(--bad)', fontWeight: 700 } : undefined}>
                    Départ limite {hhmm(t.cutoff_at)} {late ? '· EN RETARD' : ''}</div></div>
                {t.locked ? <Badge>verrouillée · {t.picker_name}</Badge>
                  : <Btn kind="primary" disabled={busy} onClick={() => run(async () => {
                    const r = await rpc('lg_pick_take', { p_task: t.id }); go(`/preparation/${t.id}`); return r;
                  })}>{t.picker_id ? 'Reprendre' : 'Je prends'}</Btn>}
              </div></Card>;
          })}
      </div>
      <div className="stack"><StagePanel onDone={reload} /><DoubleCheckPanel /><ReprintPanel /></div>
    </div>
  </>;
}

/** Mise à quai : scan de l'étiquette → la zone s'affiche en très gros. */
export function StagePanel({ onDone }) {
  const [last, setLast] = useState(null);
  const [run, busy] = useAction();
  return <Card><h2>Mise à quai</h2>
    <p className="small muted">Scannez l'étiquette du colis fermé : l'app indique où le poser.</p>
    <Scanner autoFocusInput={false} busy={busy} placeholder="Code colis (ou 6 derniers caractères)" onCode={(code, manual) => run(async () => {
      const r = await act('lg_stage', { p_code: code, p_manual: manual, p_device_at: new Date().toISOString() }, `Mise à quai ${code}`);
      setLast({ code, ...r }); if (r.ok) { feedback('ok'); onDone?.(); }
      return r;
    })} />
    {last?.error === 'double_check_required' && <div className="flash todo"><Icon name="shield" /><div>Commande de valeur : une <b>autre personne</b> doit contrôler ce colis (« Double contrôle ») avant la mise à quai.</div></div>}
    {last && last.error !== 'double_check_required' && (last.ok ? <div className="flash ok"><span className="ico">✔</span><div>
      <div className="zone-label">{last.zone ?? '—'}</div><div className="small">{last.code} {last.already ? '(déjà à quai)' : ''}
        {last.queued ? ' · enregistré, partira au retour du réseau' : last.order_complete ? ' · commande complète à quai' : ' · d\'autres colis de la commande manquent'}</div></div></div>
      : <div className="flash bad"><span className="ico">✖</span>{errText(last.error)}</div>)}
  </Card>;
}

function ReprintPanel() {
  const [code, setCode] = useState('');
  const [run] = useAction();
  return <Card><h3>Réimprimer une étiquette</h3><div className="row">
    <input className="input mono" style={{ flex: 1 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="NXP-…" />
    <Btn disabled={!code} onClick={() => run(async () => { const l = await rpc('lg_labels', { p_code: code }); if (!l.length) return { ok: false, error: 'unknown_package' }; await printLabels(l); return { ok: true }; })}>Imprimer</Btn>
  </div><p className="small muted">Chaque réimpression est tracée.</p></Card>;
}

function Task({ id }) {
  const { data, error, loading, reload } = useRpc('lg_pick_task_detail', { p_task: id });
  const [last, setLast] = useState(null);
  const [modal, setModal] = useState(null);
  const [run, busy] = useAction();
  const toast = useToast();
  const lines = data?.lines ?? [];
  const pending = lines.filter((l) => l.status === 'pending');
  const done = lines.reduce((s, l) => s + l.qty_picked, 0);
  const total = lines.reduce((s, l) => s + l.qty_ordered, 0);
  if (loading && !data) return <Loading />;
  if (error) return <><PageHead title="Préparation" back="/preparation" /><ErrorBox error={error} /></>;
  const t = data.task;

  const scan = (code, manual) => run(async () => {
    if (isPackageCode(code) && t.status !== 'picking') return stage(code, manual);
    const r = await act('lg_pick_scan', { p_task: id, p_code: code, p_manual: false }, `Scan ${code}`);
    if (r.queued) { setLast({ kind: 'todo', text: `${code} : enregistré hors ligne` }); return r; }
    const line = lines.find((l) => l.id === r.line_id);
    if (r.ok) { feedback('ok'); setLast({ kind: 'ok', text: `Bon produit · ${line?.name ?? code}`, sub: `${r.qty_picked} / ${r.qty_ordered}` }); reload(); }
    else setLast({ kind: 'bad', text: r.error === 'unexpected_product' ? `Pas dans la commande${r.product ? ' : ' + r.product : ''}` : errText(r.error) });
    return r.ok ? r : { ...r, ok: true }; // le message est déjà affiché en grand
  });
  const stage = (code, manual) => run(async () => {
    const r = await act('lg_stage', { p_code: code, p_manual: manual }, `Mise à quai ${code}`);
    if (r.ok) setLast({ kind: 'ok', text: `À quai : ${r.zone ?? ''}`, sub: r.code, zone: r.zone }); else setLast({ kind: 'bad', text: errText(r.error) });
    reload(); return r;
  });

  return <>
    <PageHead title={`Commande ${data.order.short}`} back="/preparation">
      <StatusBadge s={t.status} /><Badge>{data.order.zone ?? 'zone ?'}</Badge>
    </PageHead>
    <div className="split">
      <div className="stack">
        <Card><div className="row between"><div><div className="muted small">Préparation</div><div className="money">{done} / {total}</div></div>
          <div className="right small muted">{data.order.vendor_name}<br />Départ limite {hhmm(t.cutoff_at)}</div></div></Card>
        {last && <div className={`flash ${last.kind}`}><span className="ico">{last.kind === 'ok' ? '✔' : last.kind === 'bad' ? '✖' : '⟳'}</span>
          <div><div>{last.zone ? <span className="zone-label">{last.zone}</span> : last.text}</div>{last.sub && <div className="small">{last.sub}</div>}</div></div>}
        {t.status === 'picking' && <Scanner onCode={scan} busy={busy} placeholder="Scanner un produit" />}
        {['packed', 'staged'].includes(t.status) && <Card><h3>Mise à quai des colis</h3><Scanner onCode={stage} busy={busy} placeholder="Scanner l'étiquette du colis" /></Card>}
        <Card><div className="list">{lines.map((l) => <div key={l.id} className="line">
          <span className={`dot ${l.status === 'picked' ? 'ok' : l.status === 'short' ? 'bad' : 'todo'}`} />
          <div className="grow"><b>{l.name}</b>
            <div className="small muted">{l.location && <span className="badge info plain mono" style={{ marginRight: 6 }}><Icon name="pin" size={12} />{l.location}</span>}
              {l.lot && l.status === 'pending' && <Badge kind={l.lot.state === 'soon' ? 'todo' : 'info'}>prendre {l.lot.lot ? `lot ${l.lot.lot}` : 'le lot'}{l.lot.expires_on ? ` · ${l.lot.expires_on.split('-').reverse().join('/')}` : ''}</Badge>}{' '}
              {l.barcode ? <span className="mono">{l.barcode}</span> : <Badge kind="todo">sans code-barres</Badge>}
              {' '}{(l.handling ?? []).map((h) => <Badge key={h}>{h}</Badge>)}{l.manual_entry && <Badge kind="info">saisie manuelle</Badge>}
              {l.status === 'short' && <Badge kind="bad">rupture · {l.qty_picked} trouvé(s)</Badge>}</div></div>
          <span className="counter">{l.qty_picked}/{l.qty_ordered}</span>
          {t.status === 'picking' && l.status === 'pending' && <div className="row">
            <Btn size="sm" onClick={() => setModal({ kind: 'manual', line: l })}>Sans code</Btn>
            <Btn size="sm" kind="bad" onClick={() => setModal({ kind: 'short', line: l })}>Rupture</Btn></div>}
        </div>)}</div></Card>
      </div>
      <div className="stack">
        {data.packages.length > 0 && <Card><h3>Colis</h3><div className="list">{data.packages.map((p) =>
          <div key={p.code} className="line"><span className="mono grow">{p.code}</span><span className="small">{p.seq}/{p.count} · {kg(p.weight_g)}</span><StatusBadge s={p.status} /></div>)}</div>
          <Btn block onClick={() => run(async () => { await printLabels(await rpc('lg_labels', { p_task: id })); })}><Icon name="print" size={18} />Imprimer les étiquettes</Btn></Card>}
        <Card kind="flat"><h3>Rappels</h3><ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Bip vert : bon produit. Alerte rouge : produit qui n'est pas dans la commande.</li>
          <li>Produit sans code : « Sans code », confirmation tracée.</li>
          <li>Rupture : le client reçoit ses trois choix par WhatsApp.</li>
          <li>Poids obligatoire à la fermeture du colis.</li></ul></Card>
      </div>
    </div>
    {t.status === 'picking' && <div className="actionbar"><div className="actionbar-inner">
      <Btn kind="ghost" onClick={() => run(async () => { await rpc('lg_pick_release', { p_task: id }); history.back(); })}>Libérer</Btn>
      <Btn kind="primary" size="xl" disabled={pending.length > 0 || busy} onClick={() => setModal({ kind: 'pack' })}>
        {pending.length > 0 ? `${pending.length} article(s) à traiter` : 'Fermer le colis'}</Btn></div></div>}
    {modal?.kind === 'short' && <ShortModal line={modal.line} task={id} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    {modal?.kind === 'manual' && <Modal title="Confirmer sans code" onClose={() => setModal(null)}>
      <p>Vous confirmez avoir pris <b>1 × {modal.line.name}</b> ? La saisie est enregistrée comme manuelle.</p>
      <p className="small muted">Code interne pour la prochaine fois : <span className="mono">{modal.line.internal_code}</span></p>
      <Btn kind="primary" block size="xl" onClick={() => run(async () => {
        const r = await act('lg_pick_scan', { p_task: id, p_code: '', p_manual: true, p_line: modal.line.id }, `Confirmation manuelle ${modal.line.name}`);
        setModal(null); reload(); return r;
      }, { ok: 'Article confirmé' })}>Je confirme</Btn></Modal>}
    {modal?.kind === 'pack' && <PackModal task={id} lines={lines.filter((l) => l.qty_picked > 0)} onClose={() => setModal(null)}
      onDone={async (r) => { setModal(null); reload(); toast(`${r.packages.length} colis créé(s) — zone ${r.zone ?? '?'}`, 'ok');
        try { await printLabels(await rpc('lg_labels', { p_task: id })); } catch { /* impression annulée */ } }} />}
  </>;
}

function ShortModal({ line, task, onClose, onDone }) {
  const [found, setFound] = useState(line.qty_picked);
  const [run, busy] = useAction();
  return <Modal title="Déclarer une rupture" onClose={onClose}>
    <p><b>{line.name}</b> — commandé : {line.qty_ordered}</p>
    <Field label="Quantité réellement trouvée en rayon">
      <div className="row"><Btn onClick={() => setFound(Math.max(0, found - 1))}>−</Btn>
        <input className="input big" style={{ width: 100 }} type="number" min={0} max={line.qty_ordered - 1} value={found} onChange={(e) => setFound(Number(e.target.value))} />
        <Btn onClick={() => setFound(Math.min(line.qty_ordered - 1, found + 1))}>+</Btn></div></Field>
    <p className="small muted">Le stock du produit est remis à zéro et le client choisit : remplacement, remboursement de la ligne ou attente.</p>
    <Btn kind="bad" block size="xl" disabled={busy || found >= line.qty_ordered} onClick={() => run(async () => {
      const r = await act('lg_pick_short', { p_task: task, p_line: line.id, p_qty_found: found }, `Rupture ${line.name}`);
      onDone(); return r;
    }, { ok: 'Rupture déclarée, client prévenu' })}>{found === 0 ? 'Rupture totale' : `Rupture partielle (${line.qty_ordered - found} manquant)`}</Btn>
  </Modal>;
}

function PackModal({ task, lines, onClose, onDone }) {
  const [n, setN] = useState(1);
  const [pk, setPk] = useState(() => Array.from({ length: 6 }, () => ({ kg: '', l: '', w: '', h: '', handling: [] })));
  // répartition : par défaut tout dans le colis 1
  const [alloc, setAlloc] = useState(() => Object.fromEntries(lines.map((l) => [l.order_item_id, [l.qty_picked, 0, 0, 0, 0, 0]])));
  const [run, busy] = useAction();
  const est = useMemo(() => lines.reduce((s, l) => s + (l.weight_g ?? 0) * l.qty_picked, 0), [lines]);
  const okAlloc = lines.every((l) => alloc[l.order_item_id].slice(0, n).reduce((a, b) => a + b, 0) === l.qty_picked);
  const set = (i, k, v) => setPk(pk.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const submit = () => run(async () => {
    const packages = pk.slice(0, n).map((p, i) => ({
      weight_g: Math.round(Number(String(p.kg).replace(',', '.')) * 1000),
      length_cm: p.l ? Number(p.l) : null, width_cm: p.w ? Number(p.w) : null, height_cm: p.h ? Number(p.h) : null,
      handling: p.handling,
      ...(n > 1 ? { items: lines.map((l) => ({ order_item_id: l.order_item_id, quantity: alloc[l.order_item_id][i] })).filter((x) => x.quantity > 0) } : {}),
    }));
    const r = await act('lg_pack', { p_task: task, p_packages: packages, p_device_at: new Date().toISOString() }, 'Colisage');
    if (r.ok && !r.queued) onDone(r);
    return r;
  });
  return <Modal title="Fermer et étiqueter" onClose={onClose}>
    <div className="stack">
      <Field label="Nombre de colis"><Chips options={[1, 2, 3, 4].map((k) => [k, `${k}`])} value={n} onChange={setN} /></Field>
      {pk.slice(0, n).map((p, i) => <Card key={i} kind="flat"><h3>Colis {i + 1} / {n}</h3>
        <div className="grid cols-3">
          <Field label="Poids (kg) — pesé"><input className="input" inputMode="decimal" value={p.kg} placeholder={est ? (est / 1000 / n).toFixed(1) : ''} onChange={(e) => set(i, 'kg', e.target.value)} /></Field>
          <Field label="Dimensions L × l × h (cm)"><div className="row" style={{ flexWrap: 'nowrap' }}>
            {['l', 'w', 'h'].map((k) => <input key={k} className="input" inputMode="numeric" style={{ minWidth: 0 }} value={p[k]} onChange={(e) => set(i, k, e.target.value)} />)}</div></Field>
        </div>
        <Field label="Mentions"><Chips multi options={HANDLING} value={p.handling} onChange={(v) => set(i, 'handling', v)} /></Field>
        {n > 1 && <div className="list">{lines.map((l) => <div key={l.order_item_id} className="line"><span className="grow small">{l.name}</span>
          <input className="input" style={{ width: 80 }} type="number" min={0} max={l.qty_picked} value={alloc[l.order_item_id][i]}
            onChange={(e) => setAlloc({ ...alloc, [l.order_item_id]: alloc[l.order_item_id].map((q, j) => (j === i ? Number(e.target.value) : q)) })} /></div>)}</div>}
      </Card>)}
      {!okAlloc && <div className="flash todo">Chaque article prélevé doit être dans un colis, une seule fois.</div>}
      <Btn kind="primary" size="xl" block disabled={busy || !okAlloc || pk.slice(0, n).some((p) => !(Number(String(p.kg).replace(',', '.')) > 0))} onClick={submit}>
        Fermer {n > 1 ? `les ${n} colis` : 'le colis'} et imprimer</Btn>
    </div></Modal>;
}

// Double contrôle (P2) : second scan par une autre personne au-delà du seuil de valeur, ou écart constaté
function DoubleCheckPanel() {
  const [ko, setKo] = useState(false); const [note, setNote] = useState('');
  const [run, busy] = useAction();
  return <Card><h3><Icon name="shield" size={18} />Double contrôle</h3>
    <p className="small muted">Colis d'une commande de valeur : ouvrez, vérifiez le contenu, scannez. Pas par la personne qui l'a préparé.</p>
    <label className="check"><input type="checkbox" checked={ko} onChange={(e) => setKo(e.target.checked)} />Écart constaté</label>
    {ko && <input className="input" style={{ marginBottom: 8 }} placeholder="Ce qui manque ou ne va pas" value={note} onChange={(e) => setNote(e.target.value)} />}
    <Scanner autoFocusInput={false} busy={busy} placeholder="Code du colis contrôlé" onCode={(code) => run(async () => {
      const r = await act('lg_double_check', { p_code: code, p_ok: !ko, p_note: note || null }, `Double contrôle ${code}`);
      setKo(false); setNote(''); return r;
    }, { ok: ko ? 'Écart signalé : incident ouvert' : 'Colis contrôlé : mise à quai possible' })} />
  </Card>;
}

/* ------------------------------------------------------------ PRÉPARATION PAR VAGUE */
function Wave({ id }) {
  const { data, error, loading, reload } = useRpc('lg_wave_detail', { p_wave: id });
  const [last, setLast] = useState(null);
  const [run, busy] = useAction();
  const { go } = useNav();
  if (loading && !data) return <Loading />;
  if (error) return <><PageHead title="Vague" back="/preparation" /><ErrorBox error={error} /></>;
  const done = data.products.reduce((s, p) => s + Number(p.picked), 0);
  const total = data.products.reduce((s, p) => s + Number(p.ordered), 0);
  const scan = (code) => run(async () => {
    const r = await act('lg_wave_scan', { p_wave: id, p_code: code }, `Vague ${code}`);
    if (r.ok && !r.queued) { feedback('ok'); setLast({ ok: true, bin: r.bin, sub: `${r.qty_picked}/${r.qty_ordered} pour cette commande${r.wave_done ? ' · vague terminée' : ''}` }); reload(); }
    else if (!r.ok) setLast({ ok: false, text: errText(r.error) });
    return r.ok ? r : { ...r, ok: true };
  });
  return <>
    <PageHead title={`Vague n° ${data.wave.number}`} back="/preparation"><Badge kind="info">{data.bins.length} bacs</Badge></PageHead>
    <div className="split">
      <div className="stack">
        <Card><div className="row between"><div><div className="muted small">Prélevé</div><div className="money">{done} / {total}</div></div>
          <div className="small muted right">Prenez un bac par commande,<br />numérotés de 1 à {data.bins.length}.</div></div></Card>
        {last && (last.ok ? <div className="flash ok"><Icon name="check" size={28} /><div><div className="zone-label">Bac {last.bin}</div><div className="small">{last.sub}</div></div></div>
          : <div className="flash bad"><Icon name="x" />{last.text}</div>)}
        <Scanner onCode={scan} busy={busy} placeholder="Scanner un produit" />
        <Card><h3>Chemin de prélèvement</h3><div className="list">{data.products.map((p) =>
          <div key={p.product_id} className="line"><span className={`dot ${Number(p.picked) >= Number(p.ordered) ? 'ok' : 'todo'}`} />
            <span className="grow"><b>{p.name}</b><div className="small muted">{p.location ? <span className="mono">{p.location}</span> : 'emplacement inconnu'} · {p.split.map((s) => `bac ${s.bin} : ${s.picked}/${s.qty}`).join(' · ')}</div></span>
            <span className="counter">{p.picked}/{p.ordered}</span></div>)}</div></Card>
      </div>
      <div className="stack"><Card><h3>Bacs</h3><div className="list">{data.bins.map((b) =>
        <div key={b.bin} className="line"><span className="chip-ico" style={{ width: 38, height: 38, '--c': b.done ? 'var(--ok)' : 'var(--todo)' }}><b>{b.bin}</b></span>
          <span className="grow">Commande {b.order_short}<div className="small muted">{b.zone ?? ''} · {b.picked}/{b.ordered}</div></span>
          {b.status === 'picking' && <Btn size="sm" kind={b.done ? 'primary' : ''} onClick={() => go(`/preparation/${b.task_id}`)}>{b.done ? 'Emballer' : 'Ouvrir'}</Btn>}
          {b.status !== 'picking' && <StatusBadge s={b.status} />}</div>)}</div>
        <p className="small muted">Une rupture se déclare dans la commande (bouton « Ouvrir »).</p></Card></div>
    </div>
  </>;
}
