import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import jsQR from 'jsqr';
import { api, errorMessage } from '../../api/client';
import { useApp } from '../../state';
import { Alert, Breadcrumb, ErrorBox, formatDate, Loading, PageHead } from '../../components/ui';

/* --------------------------------------------------------------- Types */

type Result = 'ok' | 'already' | 'unknown' | 'wrong_event' | 'cancelled' | 'event_cancelled';
interface CheckResponse { result: Result; ok: boolean; message: string; ticket: { id: string; rateName: string; holder: string; number: string; pending: boolean; totalCents?: number; scannedAt: string | null } | null }
interface ScanEvent { id: string; title: string; startAt: string; venue: string | null; status: string; sold: number; scanned: number; capacity: number | null }
interface ScanState extends ScanEvent { recent: { id: number; ticketId: string | null; result: Result | 'undo'; at: string; offline: boolean; rateName: string | null; holder: string | null; number: string | null }[] }
interface Manifest { event: { id: string; title: string }; generatedAt: string; tickets: { h: string; id: string; rateName: string; holder: string; number: string; valid: boolean; pending: boolean; scannedAt: string | null }[] }
interface Offline { manifest: Manifest; used: Record<string, string>; queue: { code: string; at: string }[] }

const LABEL: Record<Result | 'undo', string> = { ok: 'Entrée', already: 'Déjà utilisé', unknown: 'Inconnu', wrong_event: 'Autre séance', cancelled: 'Annulé', event_cancelled: 'Séance annulée', undo: 'Entrée annulée' };
const DEVICE = (() => { try { const k = 'scenorya:scan:device'; let v = localStorage.getItem(k); if (!v) { v = `Poste ${Math.random().toString(36).slice(2, 6).toUpperCase()}`; localStorage.setItem(k, v); } return v; } catch { return 'Poste'; } })();
const codeOf = (raw: string) => raw.trim().match(/([A-Za-z0-9_-]{16,64})\/?$/)?.[1] ?? '';
const hm = (d: string | Date) => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const storeKey = (id: string) => `scenorya:scan:${id}`;
const load = (id: string): Offline | null => { try { const v = localStorage.getItem(storeKey(id)); return v ? JSON.parse(v) as Offline : null; } catch { return null; } };
const save = (id: string, v: Offline | null) => { try { if (v) localStorage.setItem(storeKey(id), JSON.stringify(v)); else localStorage.removeItem(storeKey(id)); } catch { /* stockage indisponible */ } };
async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Une panne réseau (et non un refus du serveur) bascule en mode hors connexion. */
const isNetworkError = (e: unknown) => !navigator.onLine || e instanceof TypeError || (e as { status?: number })?.status === 0;

function feedback(ok: boolean) {
  try { navigator.vibrate?.(ok ? 80 : [120, 80, 120]); } catch { /* sans vibreur */ }
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.12 : 0.35));
    o.onended = () => ctx.close();
  } catch { /* sans son */ }
}

/* ---------------------------------------------------------- Choix de la séance */

export function ScanHome() {
  const q = useQuery({ queryKey: ['scan', 'events'], queryFn: () => api.get<ScanEvent[]>('/scan/events'), refetchInterval: 15_000 });
  return (
    <>
      <Breadcrumb items={[{ label: 'Scenorya Scan' }]} />
      <PageHead title="Contrôle des entrées" description="Choisissez la séance à contrôler, puis lisez les QR codes des billets." />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : q.data!.length === 0 ? <div className="card empty">Aucune séance à contrôler (de la veille aux deux prochains mois).</div> : (
        <div className="grid-3">
          {q.data!.map((e) => (
            <Link key={e.id} to={`/scan/${e.id}`} className="card tile-link">
              <div className="stack" style={{ gap: 6 }}>
                <h2 style={{ margin: 0 }}>{e.title}</h2>
                <span className="small">{formatDate(e.startAt, true)}{e.venue ? ` · ${e.venue}` : ''}</span>
                <strong style={{ fontSize: 22 }}>{e.scanned} / {e.sold} entrées</strong>
                {e.status === 'cancelled' && <span className="small" style={{ color: 'var(--danger)' }}>Séance annulée</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------- Contrôle */

export function ScanPage() {
  const { id = '' } = useParams();
  const { can, toast } = useApp();
  const q = useQuery({ queryKey: ['scan', 'event', id], queryFn: () => api.get<ScanState>(`/scan/events/${id}`), refetchInterval: 5000, retry: false });
  const [offline, setOffline] = useState<Offline | null>(() => load(id));
  const [last, setLast] = useState<(CheckResponse & { local?: boolean }) | null>(null);
  const [camera, setCamera] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const recentCodes = useRef(new Map<string, number>());
  const busy = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const persist = useCallback((v: Offline | null) => { setOffline(v); save(id, v); }, [id]);

  const show = (r: CheckResponse & { local?: boolean }) => {
    setLast(r);
    feedback(r.ok);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setLast(null), r.ok ? 2500 : 4000);
  };

  /** Contrôle local à partir des empreintes téléchargées. */
  const checkLocal = async (code: string): Promise<CheckResponse & { local: true }> => {
    const state = load(id) ?? offline;
    if (!state) return { result: 'unknown', ok: false, message: 'Hors connexion et liste non préparée', ticket: null, local: true };
    const h = await sha256(code);
    const t = state.manifest.tickets.find((x) => x.h === h);
    const ticket = t ? { id: t.id, rateName: t.rateName, holder: t.holder, number: t.number, pending: t.pending, scannedAt: t.scannedAt ?? state.used[h] ?? null } : null;
    let result: Result;
    if (!t) result = 'unknown';
    else if (!t.valid) result = 'cancelled';
    else if (t.scannedAt || state.used[h]) result = 'already';
    else result = 'ok';
    const at = new Date().toISOString();
    const next: Offline = { ...state, used: result === 'ok' ? { ...state.used, [h]: at } : state.used, queue: result === 'ok' ? [...state.queue, { code, at }] : state.queue };
    persist(next);
    const message = result === 'already' && ticket?.scannedAt ? `Déjà utilisé à ${hm(ticket.scannedAt)}` : { ok: 'Entrée validée (hors connexion)', unknown: 'Billet inconnu', cancelled: 'Billet annulé', already: 'Billet déjà utilisé', wrong_event: '', event_cancelled: '' }[result];
    return { result, ok: result === 'ok', message, ticket, local: true };
  };

  const submit = async (raw: string) => {
    const code = codeOf(raw);
    if (!code) { show({ result: 'unknown', ok: false, message: 'QR code non reconnu', ticket: null }); return; }
    const seen = recentCodes.current.get(code);
    if (seen && Date.now() - seen < 3000) return; // même QR encore devant la caméra
    recentCodes.current.set(code, Date.now());
    if (busy.current) return;
    busy.current = true;
    try {
      if (!navigator.onLine && offline) show(await checkLocal(code));
      else {
        try {
          show(await api.post<CheckResponse>(`/scan/events/${id}/check`, { code, device: DEVICE }));
          q.refetch();
        } catch (e) {
          if (isNetworkError(e) && offline) show(await checkLocal(code));
          else show({ result: 'unknown', ok: false, message: errorMessage(e), ticket: null });
        }
      }
    } finally { busy.current = false; }
  };

  /* Caméra : BarcodeDetector natif si disponible, sinon jsQR. */
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (!camera) return;
    let stream: MediaStream | null = null, raf = 0, stopped = false, lastTick = 0;
    const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    const detector = Detector ? new Detector({ formats: ['qr_code'] }) : null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const loop = async (now: number) => {
          if (stopped) return;
          if (now - lastTick > 120 && v.readyState >= 2) {
            lastTick = now;
            try {
              if (detector) {
                const found = await detector.detect(v);
                if (found[0]) submitRef.current(found[0].rawValue);
              } else {
                const c = canvas.current!, w = Math.min(640, v.videoWidth), h = Math.round((v.videoHeight / v.videoWidth) * w);
                c.width = w; c.height = h;
                const ctx = c.getContext('2d', { willReadFrequently: true })!;
                ctx.drawImage(v, 0, 0, w, h);
                const img = ctx.getImageData(0, 0, w, h);
                const r = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
                if (r?.data) submitRef.current(r.data);
              }
            } catch { /* image illisible */ }
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      } catch (e) {
        setCamError((e as Error).name === 'NotAllowedError' ? 'Accès à la caméra refusé : autorisez-le dans le navigateur, ou saisissez les codes.' : 'Caméra indisponible sur cet appareil (une connexion sécurisée HTTPS est nécessaire).');
        setCamera(false);
      }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [camera]);

  /* Hors connexion : préparation, puis transmission dès le retour du réseau. */
  const prepare = async () => {
    try {
      const manifest = await api.get<Manifest>(`/scan/events/${id}/manifest`);
      persist({ manifest, used: offline?.used ?? {}, queue: offline?.queue ?? [] });
      toast(`Liste hors connexion prête : ${manifest.tickets.length} billet(s).`);
    } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const sync = useCallback(async () => {
    const state = load(id);
    if (!state?.queue.length || syncing) return;
    setSyncing(true);
    try {
      const r = await api.post<{ results: (CheckResponse & { code: string })[] }>(`/scan/events/${id}/sync`, { device: DEVICE, entries: state.queue });
      const refused = r.results.filter((x) => !x.ok);
      const fresh = await api.get<Manifest>(`/scan/events/${id}/manifest`).catch(() => state.manifest);
      persist({ manifest: fresh, used: {}, queue: [] });
      q.refetch();
      toast(refused.length ? `${r.results.length - refused.length} entrée(s) transmise(s) ; ${refused.length} refusée(s) par le serveur (billet déjà passé à un autre poste ou annulé).` : `${r.results.length} lecture(s) hors connexion transmise(s).`, refused.length ? 'error' : 'success');
    } catch (e) {
      if (!isNetworkError(e)) toast(errorMessage(e), 'error');
    } finally { setSyncing(false); }
  }, [id, persist, q, syncing, toast]);
  useEffect(() => {
    const up = () => { setOnline(true); sync(); };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const t = window.setInterval(() => { if (navigator.onLine) sync(); }, 20_000);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); window.clearInterval(t); };
  }, [sync]);

  const undo = (ticketId: string) => api.post(`/scan/tickets/${ticketId}/undo`).then(() => { q.refetch(); toast('Entrée annulée : le billet peut de nouveau passer.'); }, (e) => toast(errorMessage(e), 'error'));
  const onManual = (e: FormEvent) => { e.preventDefault(); recentCodes.current.clear(); submit(manual); setManual(''); };

  if (q.isLoading && !offline) return <Loading />;
  const s = q.data;
  const title = s?.title ?? offline?.manifest.event.title ?? 'Séance';
  const pendingQueue = offline?.queue.length ?? 0;
  const localScanned = offline ? Object.keys(offline.used).length : 0;
  const tone = last ? (last.ok ? (last.ticket?.pending ? 'warn' : 'ok') : 'ko') : null;
  return (
    <div className="scan-page">
      <Breadcrumb items={[{ label: 'Scenorya Scan', to: '/scan' }, { label: title }]} />
      <div className="row between" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
        <div>
          <h1 style={{ margin: 0 }}>{title}</h1>
          {s && <span className="small">{formatDate(s.startAt, true)}{s.venue ? ` · ${s.venue}` : ''}</span>}
        </div>
        <div className="scan-counter" aria-live="polite"><strong>{(s?.scanned ?? 0) + (online ? 0 : localScanned)}</strong><span>/ {s?.sold ?? offline?.manifest.tickets.filter((t) => t.valid).length ?? 0} entrées</span></div>
      </div>
      {q.error && !offline && <ErrorBox error={q.error} />}
      {!online && <Alert tone="warning">Hors connexion{offline ? ` : contrôle sur la liste du ${new Date(offline.manifest.generatedAt).toLocaleString('fr-FR')}. ${pendingQueue} lecture(s) en attente de transmission.` : ' et aucune liste préparée : les lectures ne peuvent pas être vérifiées.'}</Alert>}
      {online && pendingQueue > 0 && <Alert tone="info">{pendingQueue} lecture(s) hors connexion à transmettre. <button className="btn ghost sm" type="button" disabled={syncing} onClick={sync}>Transmettre maintenant</button></Alert>}
      {s?.status === 'cancelled' && <Alert tone="warning">Séance annulée : aucun billet ne sera accepté.</Alert>}

      <div className="scan-grid">
        <section className="card stack" style={{ gap: 12 }}>
          <div className={`scan-view${camera ? ' on' : ''}`}>
            <video ref={video} playsInline muted aria-label="Image de la caméra" />
            <canvas ref={canvas} hidden />
            {!camera && !last && <button className="btn" type="button" style={{ minHeight: 56, fontSize: 18 }} onClick={() => { setCamError(null); setCamera(true); }}>Activer la caméra</button>}
            {camera && <span className="scan-frame" aria-hidden />}
            {last && (
              <div className={`scan-result ${tone}`} role="status" aria-live="assertive">
                <strong>{last.ok ? (last.ticket?.pending ? 'À RÉGLER' : 'ENTRÉE') : 'REFUSÉ'}</strong>
                <span>{last.message}</span>
                {last.ticket && <span>{last.ticket.rateName} · {last.ticket.holder} · {last.ticket.number}</span>}
                {last.ok && last.ticket?.pending && <span>Faire régler {last.ticket.totalCents != null ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(last.ticket.totalCents / 100) : 'la commande'} à l’accueil</span>}
              </div>
            )}
          </div>
          {camError && <Alert tone="warning">{camError}</Alert>}
          <div className="row" style={{ gap: 8 }}>
            {camera && <button className="btn secondary" type="button" onClick={() => setCamera(false)}>Arrêter la caméra</button>}
            <form className="row grow" style={{ gap: 8, flexWrap: 'nowrap' }} onSubmit={onManual}>
              <input type="text" aria-label="Code du billet" placeholder="Saisir ou coller le code du billet" value={manual} onChange={(e) => setManual(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
              <button className="btn secondary" type="submit" disabled={!manual.trim()}>Valider</button>
            </form>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost sm" type="button" onClick={prepare} disabled={!online}>{offline ? 'Mettre à jour la liste hors connexion' : 'Préparer le hors connexion'}</button>
            {offline && pendingQueue === 0 && <button className="btn ghost sm" type="button" onClick={() => persist(null)}>Effacer la liste de cet appareil</button>}
            <span className="small muted">{DEVICE}</span>
          </div>
        </section>
        <section className="card">
          <h2>Dernières lectures</h2>
          <ul className="scan-log">
            {s?.recent.map((r) => (
              <li key={r.id} className={r.result === 'ok' ? 'ok' : r.result === 'undo' ? '' : 'ko'}>
                <span className="small">{hm(r.at)}{r.offline ? ' · hors ligne' : ''}</span>
                <span><strong>{LABEL[r.result]}</strong>{r.rateName && ` · ${r.rateName}`}{r.holder && ` · ${r.holder}`}</span>
                {r.result === 'ok' && r.ticketId && can('scan.entries.update') && <button className="btn ghost sm" type="button" onClick={() => window.confirm('Annuler cette entrée ? Le billet pourra de nouveau passer.') && undo(r.ticketId!)}>Annuler</button>}
              </li>
            ))}
            {!s?.recent.length && <li className="muted">Aucune lecture pour l’instant.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
