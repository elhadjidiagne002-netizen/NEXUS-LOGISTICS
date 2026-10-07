// Module 06 — Messages au client (annexe B) : modifiables sans toucher au code, aperçu en direct,
// file d'envoi. Le texte final part avec chaque message (vars.texte) vers l'expéditeur WhatsApp.
import React, { useEffect, useMemo, useState } from 'react';
import { rpc } from '../lib/backend.js';
import { useRpc, useAction, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Tabs, ago } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';

export default function Messages() {
  const [tab, setTab] = useState('templates');
  return <>
    <PageHead title="Messages clients" back="/" sub="Les 8 messages du parcours (annexe B) et ceux du gérant. Courts, l'information utile d'abord, une seule action." />
    <Tabs value={tab} onChange={setTab} tabs={[['templates', 'Modèles'], ['queue', 'File d\'envoi']]} />
    {tab === 'templates' ? <Templates /> : <Queue />}
  </>;
}

function Templates() {
  const { data, error, loading, reload } = useRpc('lg_templates_list', {});
  const [sel, setSel] = useState(null);
  useEffect(() => { if (data?.length && !sel) setSel(data[0].event_key); }, [data]);
  if (loading && !data) return <Loading />;
  const t = data?.find((x) => x.event_key === sel);
  return <div className="split">
    <div className="stack">
      <ErrorBox error={error} />
      {t && <Editor key={t.event_key} t={t} onSaved={reload} />}
    </div>
    <Card><div className="list">{(data ?? []).map((x) =>
      <button key={x.event_key} className="line" style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', width: '100%', color: 'inherit',
        fontWeight: sel === x.event_key ? 700 : 500 }} onClick={() => setSel(x.event_key)}>
        <span className="chip-ico" style={{ width: 34, height: 34, '--c': x.active ? 'var(--primary)' : 'var(--muted)' }}><Icon name="message" size={17} /></span>
        <span className="grow">{x.label}<div className="small muted">{x.sent_7d} envoi(s) sur 7 jours</div></span>
        {!x.active && <Badge>désactivé</Badge>}</button>)}</div></Card>
  </div>;
}

function Editor({ t, onSaved }) {
  const [body, setBody] = useState(t.body_fr);
  const [wo, setWo] = useState(t.body_wo ?? '');
  const [active, setActive] = useState(t.active);
  const [preview, setPreview] = useState('');
  const [run, busy] = useAction();
  const vars = useMemo(() => Object.keys(t.sample ?? {}).filter((k) => k !== 'texte'), [t]);
  useEffect(() => {
    const h = setTimeout(() => rpc('lg_preview_message', { p_event: t.event_key, p_body: body, p_vars: t.sample }).then(setPreview).catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [body]);
  const insert = (k) => setBody((b) => `${b}{${k}}`);
  const dirty = body !== t.body_fr || active !== t.active || wo !== (t.body_wo ?? '');
  return <Card>
    <div className="card-title"><h2>{t.label}</h2><label className="check" style={{ minHeight: 0 }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Actif</label></div>
    <textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Texte du message" />
    <div className="row small" style={{ margin: '8px 0 14px' }}><span className="muted">Insérer :</span>{vars.map((k) =>
      <button key={k} className="chip" style={{ padding: '4px 10px', fontSize: '.8rem' }} onClick={() => insert(k)}>{`{${k}}`}</button>)}</div>
    <div className="small muted" style={{ marginBottom: 6 }}>Aperçu (dernier envoi réel)</div>
    <WhatsAppBubble text={preview} />
    <details style={{ marginTop: 14 }}><summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>Version wolof</summary>
      <p className="small muted">À faire rédiger et relire par un locuteur — jamais traduit automatiquement (chapitre 06).</p>
      <textarea className="input" rows={3} value={wo} onChange={(e) => setWo(e.target.value)} placeholder="(vide : le message part en français)" /></details>
    <div className="row" style={{ marginTop: 14 }}>
      <Btn kind="primary" disabled={!dirty || busy} onClick={() => run(async () => {
        const r = await rpc('lg_template_save', { p_event: t.event_key, p_body_fr: body, p_active: active, p_body_wo: wo || null }); onSaved(); return r;
      }, { ok: 'Modèle enregistré' })}><Icon name="check" size={18} />Enregistrer</Btn>
      {dirty && <Btn kind="ghost" onClick={() => { setBody(t.body_fr); setActive(t.active); setWo(t.body_wo ?? ''); }}>Annuler</Btn>}
      <span className="small muted" style={{ marginLeft: 'auto' }}>{body.length} caractères</span>
    </div>
  </Card>;
}

export function WhatsAppBubble({ text, at }) {
  return <div style={{ background: 'linear-gradient(180deg,#e5ddd5,#efe7de)', borderRadius: 14, padding: 14 }}>
    <div style={{ background: '#fff', color: '#111', borderRadius: '12px 12px 12px 2px', padding: '10px 12px', maxWidth: 420,
      boxShadow: '0 1px 1px rgb(0 0 0 / 12%)', whiteSpace: 'pre-wrap', fontSize: '.93rem', lineHeight: 1.45 }}>
      {text || '…'}<div style={{ textAlign: 'right', fontSize: '.7rem', color: '#667781', marginTop: 4 }}>{at ?? 'NEXUS Market'}</div></div></div>;
}

const ST = { pending: ['En attente', 'todo'], sent: ['Envoyé', 'ok'], failed: ['Échec', 'bad'], done: ['Envoyé', 'ok'] };
function Queue() {
  const { data, error, loading } = useRpc('lg_outbox_recent', { p_limit: 60 }, { refresh: 20000 });
  if (loading && !data) return <Loading />;
  return <div className="stack"><ErrorBox error={error} />
    <p className="small muted" style={{ margin: 0 }}>Déposés dans <span className="kbd">notification_outbox</span> ; l'envoi WhatsApp (puis SMS de secours) est fait par le pipeline NEXUS, avec reprises.</p>
    {!data?.length ? <Card><Empty icon="inbox">Aucun message pour l'instant.</Empty></Card> :
      <div className="grid cols-2">{data.map((m) => { const [l, k] = ST[m.whatsapp] ?? ST[m.status] ?? [m.status, '']; return <Card key={m.id}>
        <div className="row between" style={{ marginBottom: 8 }}><b>{m.label ?? m.event_key}</b><Badge kind={k}>{l}</Badge></div>
        <div className="small muted" style={{ marginBottom: 8 }}>{m.to} · {ago(m.created_at)}{m.attempts ? ` · ${m.attempts} essai(s)` : ''}</div>
        <WhatsAppBubble text={m.text} />{m.error && <div className="small" style={{ color: 'var(--bad)', marginTop: 6 }}>{m.error}</div>}</Card>; })}</div>}
  </div>;
}
