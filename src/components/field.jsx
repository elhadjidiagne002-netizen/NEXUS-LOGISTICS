// Outils de terrain : lecteur de codes, signature, photo, carte.
import React, { useEffect, useRef, useState } from 'react';
import { Btn } from './ui.jsx';
import { Icon } from './icons.jsx';

/* ------------------------------------------------------------------ SCAN
   1. Douchette Bluetooth (mode clavier) : tape le code puis Entrée dans le champ, toujours actif.
   2. Caméra : détection native (Chrome Android), sinon bibliothèque de secours chargée à la demande.
   3. Saisie de secours : les 6 derniers caractères, tapés à la main (tracé « manuel »). */
export function Scanner({ onCode, placeholder = 'Scanner ou taper un code', autoFocusInput = true, startCamera = false, busy }) {
  const [cam, setCam] = useState(startCamera);
  const [val, setVal] = useState('');
  const inputRef = useRef();
  const typed = useRef({ n: 0, t: 0 });
  const submit = (code, manual) => { const c = String(code ?? '').trim(); if (c) onCode(c, manual); };

  return <div className="stack">
    {cam && <Camera onCode={(c) => submit(c, false)} onClose={() => setCam(false)} paused={busy} />}
    <form className="row" onSubmit={(e) => {
      e.preventDefault();
      // une douchette tape très vite ; un humain non : la saisie lente est marquée manuelle
      const elapsed = Date.now() - typed.current.t;
      const manual = val.length > 0 && elapsed / Math.max(val.length, 1) > 35;
      submit(val, manual); setVal(''); typed.current = { n: 0, t: 0 };
    }}>
      <input ref={inputRef} className="input mono" style={{ flex: 1, minWidth: 0 }} value={val} placeholder={placeholder} autoFocus={autoFocusInput}
        autoCapitalize="characters" autoComplete="off" enterKeyHint="go" aria-label="Code"
        onChange={(e) => { if (!typed.current.t) typed.current = { n: 0, t: Date.now() }; setVal(e.target.value); }} />
      <Btn kind="primary" type="submit" disabled={!val || busy}>OK</Btn>
      {!cam && <Btn onClick={() => setCam(true)} aria-label="Caméra"><Icon name="camera" /></Btn>}
    </form>
  </div>;
}

function Camera({ onCode, onClose, paused }) {
  const video = useRef();
  const [err, setErr] = useState(null);
  const [torch, setTorch] = useState(false);
  const last = useRef({ code: '', at: 0 });
  const stream = useRef();
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let stop = false; let detector;
    (async () => {
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
        video.current.srcObject = stream.current; await video.current.play();
        const formats = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf'];
        if ('BarcodeDetector' in window) detector = new window.BarcodeDetector({ formats });
        else { const { BarcodeDetector } = await import('barcode-detector/ponyfill'); detector = new BarcodeDetector({ formats }); }
        const tick = async () => {
          if (stop) return;
          if (!pausedRef.current && video.current?.readyState >= 2) {
            try {
              const [hit] = await detector.detect(video.current);
              // même code lu en continu : on ignore pendant 2,5 s
              if (hit && (hit.rawValue !== last.current.code || Date.now() - last.current.at > 2500)) {
                last.current = { code: hit.rawValue, at: Date.now() }; onCode(hit.rawValue);
              }
            } catch { /* image illisible */ }
          }
          setTimeout(tick, 180);
        };
        tick();
      } catch (e) { setErr(e.name === 'NotAllowedError' ? 'Caméra refusée : autorisez-la, ou utilisez la douchette / la saisie.' : 'Caméra indisponible sur cet appareil.'); }
    })();
    return () => { stop = true; stream.current?.getTracks().forEach((t) => t.stop()); };
  }, []);

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    try { await track.applyConstraints({ advanced: [{ torch: !torch }] }); setTorch(!torch); } catch { /* pas de lampe */ }
  };
  if (err) return <div className="flash todo">{err} <Btn size="sm" onClick={onClose}>Fermer</Btn></div>;
  return <div className="scanner"><video ref={video} playsInline muted /><div className="frame" />
    <div className="tools"><Btn size="sm" onClick={toggleTorch} aria-label="Lampe"><Icon name="sun" size={16} /></Btn><Btn size="sm" onClick={onClose} aria-label="Fermer la caméra"><Icon name="x" size={16} /></Btn></div></div>;
}

/* ------------------------------------------------------------------ SIGNATURE */
export function SignaturePad({ onChange }) {
  const c = useRef(); const drawing = useRef(false); const [has, setHas] = useState(false);
  useEffect(() => {
    const cv = c.current; const r = cv.getBoundingClientRect();
    cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio;
    const ctx = cv.getContext('2d'); ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
  }, []);
  const pos = (e) => { const r = c.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const down = (e) => { drawing.current = true; const ctx = c.current.getContext('2d'); ctx.beginPath(); ctx.moveTo(...pos(e)); c.current.setPointerCapture(e.pointerId); };
  const move = (e) => { if (!drawing.current) return; const ctx = c.current.getContext('2d'); ctx.lineTo(...pos(e)); ctx.stroke(); };
  const up = () => { if (!drawing.current) return; drawing.current = false; setHas(true); c.current.toBlob((b) => onChange(b), 'image/png'); };
  const clear = () => { const cv = c.current; cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); setHas(false); onChange(null); };
  return <div className="stack"><canvas ref={c} className="sig" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} aria-label="Zone de signature" />
    <div className="row between"><span className="small muted">Signer avec le doigt</span>{has && <Btn size="sm" onClick={clear}>Effacer</Btn>}</div></div>;
}

/* ------------------------------------------------------------------ PHOTO
   Réduite sur le téléphone à ~120 Ko avant envoi (chapitre 06). */
export async function compressImage(file, maxBytes = 120_000) {
  const img = await createImageBitmap(file);
  let w = img.width; let h = img.height; const max = 1280;
  if (Math.max(w, h) > max) { const k = max / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  let q = 0.8; let blob;
  for (let i = 0; i < 6; i++) {
    blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', q));
    if (blob.size <= maxBytes) break;
    q -= 0.12;
    if (q < 0.4) { cv.width = Math.round(cv.width * 0.75); cv.height = Math.round(cv.height * 0.75); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); q = 0.7; }
  }
  return blob;
}
export function PhotoInput({ label = 'Photo du colis remis', onChange, value }) {
  const [preview, setPreview] = useState(null);
  return <label className="btn block" style={{ height: preview ? 'auto' : undefined, padding: preview ? 8 : undefined, flexDirection: 'column' }}>
    {preview ? <img src={preview} alt="" style={{ maxHeight: 160, borderRadius: 10 }} /> : <><Icon name="camera" /> {label}</>}
    {value && <span className="small muted">{Math.round(value.size / 1024)} Ko · toucher pour reprendre</span>}
    <input type="file" accept="image/*" capture="environment" hidden onChange={async (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      const b = await compressImage(f); setPreview(URL.createObjectURL(b)); onChange(b);
    }} />
  </label>;
}

/* ------------------------------------------------------------------ CARTE (Leaflet, chargée à la demande) */
export function MapView({ markers = [], lines = [], height, tall, onReady, fitKey }) {
  const el = useRef(); const map = useRef(); const layer = useRef(); const L = useRef();
  useEffect(() => {
    let dead = false;
    (async () => {
      const mod = await import('leaflet'); await import('leaflet/dist/leaflet.css');
      if (dead) return;
      L.current = mod.default ?? mod;
      map.current = L.current.map(el.current, { zoomControl: true }).setView([14.716, -17.4], 11);
      L.current.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current);
      layer.current = L.current.layerGroup().addTo(map.current);
      onReady?.(map.current, L.current);
      draw(true);
    })();
    return () => { dead = true; map.current?.remove(); };
  }, []);
  const draw = (fit) => {
    if (!layer.current) return;
    const Lf = L.current; layer.current.clearLayers();
    const pts = [];
    for (const ln of lines) if (ln.points.length > 1) Lf.polyline(ln.points, { color: ln.color ?? '#0b6e4f', weight: 4, opacity: .7, dashArray: ln.dashed ? '6 8' : null }).addTo(layer.current);
    for (const m of markers) {
      if (m.lat == null || m.lng == null) continue;
      pts.push([m.lat, m.lng]);
      const html = m.kind === 'truck' ? `<div class="truck">${m.icon ?? '🚚'}</div>`
        : `<div class="pin" style="background:${m.color ?? '#0b6e4f'}"><span>${m.label ?? ''}</span></div>`;
      const mk = Lf.marker([m.lat, m.lng], { icon: Lf.divIcon({ html, className: '', iconSize: [30, 30], iconAnchor: [14, 28] }) }).addTo(layer.current);
      if (m.popup) mk.bindPopup(m.popup);
      if (m.onClick) mk.on('click', m.onClick);
    }
    if (fit && pts.length) map.current.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  };
  useEffect(() => { draw(false); }, [JSON.stringify(markers.map((m) => [m.lat, m.lng, m.label, m.color])), JSON.stringify(lines.map((l) => l.points.length))]);
  useEffect(() => { draw(true); }, [fitKey]);
  return <div ref={el} className={`map ${tall ? 'tall' : ''}`} style={height ? { height } : undefined} />;
}
