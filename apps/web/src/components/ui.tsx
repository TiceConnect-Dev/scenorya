import { ReactNode, useEffect, useId, useRef } from 'react';
import { Link } from 'react-router-dom';
import { MODULES_BY_ID, ModuleId, EffectiveState } from '@scenorya/shared';
import { useApp } from '../state';
import { errorMessage } from '../api/client';

/** Pictogramme SVG simplifié du module, coloré par la couleur courante (adapté au mode sombre). */
export function ModuleIcon({ id, size, className = '' }: { id: ModuleId; size?: 'lg'; className?: string }) {
  return <span aria-hidden="true" className={`micon ${size ?? ''} ${className}`} style={{ ['--src' as string]: `url(${MODULES_BY_ID[id].assets.outline})` }} />;
}

/** Logo horizontal coloré du module (variante sombre en mode sombre). */
export function ModuleLogo({ id, height = 72 }: { id: ModuleId; height?: number }) {
  const { theme } = useApp();
  const m = MODULES_BY_ID[id];
  return <img src={theme === 'dark' ? m.assets.logoDark : m.assets.logo} alt={m.name} style={{ height }} />;
}

export function BrandLogo({ className, height }: { className?: string; height?: number }) {
  const { theme } = useApp();
  return (
    <img
      className={className}
      src={theme === 'dark' ? '/branding/derived/logos/scenorya-dark-small.png' : '/branding/derived/logos/scenorya-horizontal-small.png'}
      alt="Scenorya — Gestion associative, culturelle et événementielle"
      style={height ? { height } : undefined}
    />
  );
}

const STATE_LABEL: Record<EffectiveState, [string, string, string]> = {
  required: ['Requis', 'info', '●'],
  active: ['Actif', 'success', '✓'],
  readonly: ['Lecture seule', 'warning', '◐'],
  inactive: ['Inactif', 'neutral', '○'],
  missing_dependency: ['Dépendance manquante', 'danger', '!'],
  unavailable: ['Indisponible (instance)', 'danger', '×'],
};

/** Badge d'état : texte + symbole, jamais la couleur seule. */
export function StateBadge({ state }: { state: EffectiveState }) {
  const [label, tone, sym] = STATE_LABEL[state];
  return (
    <span className={`badge ${tone}`}>
      <span aria-hidden="true">{sym}</span> {label}
    </span>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function ErrorBox({ error, title = 'Erreur' }: { error: unknown; title?: string }) {
  return (
    <div className="alert danger" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{errorMessage(error)}</p>
      </div>
    </div>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'success' | 'warning' | 'danger'; children: ReactNode }) {
  return (
    <div className={`alert ${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <div>{children}</div>
    </div>
  );
}

export function Breadcrumb({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="breadcrumb" aria-label="Fil d'Ariane">
      <ol>
        <li>
          <Link to="/hub">Accueil</Link>
        </li>
        {items.map((it, i) => (
          <li key={i} aria-current={i === items.length - 1 ? 'page' : undefined}>
            {it.to && i < items.length - 1 ? <Link to={it.to}>{it.label}</Link> : it.label}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHead({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — Scenorya`;
  }, [title]);
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" aria-labelledby={id} onClose={onClose} onCancel={onClose}>
      {open && (
        <>
          <div className="modal-head">
            <h2 id={id}>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Fermer">
              ✕
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function Field({ label, hint, error, children, className = '' }: { label: string; hint?: string; error?: string; children: (id: string, describedBy?: string) => ReactNode; className?: string }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id}>{label}</label>
      {hint && (
        <span id={hintId} className="hint">
          {hint}
        </span>
      )}
      {children(id, [hintId, errId].filter(Boolean).join(' ') || undefined)}
      {error && (
        <span id={errId} className="error">
          {error}
        </span>
      )}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted small">
        {total} résultat{total > 1 ? 's' : ''} — page {page} sur {pages}
      </span>
      <div className="row">
        <button type="button" className="btn secondary sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ‹ Précédente
        </button>
        <button type="button" className="btn secondary sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Suivante ›
        </button>
      </div>
    </nav>
  );
}

export const formatDate = (v: string | Date | null | undefined, withTime = false) =>
  v ? new Intl.DateTimeFormat('fr-FR', withTime ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' }).format(new Date(v)) : '—';

export const formatBytes = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '—';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${u[i]}`;
};
