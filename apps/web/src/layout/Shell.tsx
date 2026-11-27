import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { MODULES, MODULES_BY_ID, ModuleId, isModuleId, BRAND } from '@scenorya/shared';
import { useApp } from '../state';
import { api } from '../api/client';
import { BrandLogo, ModuleIcon } from '../components/ui';
import { MODULE_NAV } from '../navigation';
import { GlobalSearch } from './GlobalSearch';

function useClickOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

export function currentModule(pathname: string): ModuleId {
  const seg = pathname.split('/')[1];
  return isModuleId(seg) ? seg : 'hub';
}

function Launcher() {
  const { ctx } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(open, () => setOpen(false));
  const visible = MODULES.filter((m) => ctx?.visibleModules.includes(m.id));
  return (
    <div ref={ref}>
      <button type="button" className="icon-btn" aria-expanded={open} aria-controls="launcher" aria-label="Lanceur d'applications" title="Applications Scenorya" onClick={() => setOpen((o) => !o)}>
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          {[4, 12, 20].flatMap((y) => [4, 12, 20].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="2.2" />))}
        </svg>
      </button>
      {open && (
        <div id="launcher" className="popover launcher" role="dialog" aria-label="Applications">
          <h2 className="small muted" style={{ marginBottom: 10 }}>
            Applications de {ctx?.association.name}
          </h2>
          {visible.length === 0 ? (
            <p className="muted">Aucune application ne vous est accessible.</p>
          ) : (
            <ul className="launcher-grid">
              {visible.map((m) => (
                <li key={m.id}>
                  <Link to={m.route} onClick={() => setOpen(false)}>
                    <img src={m.assets.icon} alt="" />
                    <span>{m.shortName}</span>
                    {m.implementation.status === 'planned' && <span className="soon">En développement</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  const { me } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(open, () => setOpen(false));
  if (!me) return null;
  const initials = me.user.displayName.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div ref={ref}>
      <button type="button" className="icon-btn" aria-expanded={open} aria-label={`Compte de ${me.user.displayName}`} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true" style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--navy)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 700 }}>
          {initials}
        </span>
      </button>
      {open && (
        <div className="popover menu" style={{ right: 12 }}>
          <div style={{ padding: '6px 16px 10px' }}>
            <strong>{me.user.displayName}</strong>
            <div className="small muted">{me.user.email}</div>
          </div>
          <hr />
          <Link to="/compte" onClick={() => setOpen(false)}>
            Mon compte et sécurité
          </Link>
          <hr />
          <button
            type="button"
            onClick={async () => {
              await api.post('/auth/logout');
              qc.clear();
              navigate('/connexion');
            }}
          >
            Se déconnecter
          </button>
        </div>
      )}
    </div>
  );
}

function Sidebar({ module }: { module: ModuleId }) {
  const { ctx, can, me } = useApp();
  const def = MODULES_BY_ID[module];
  const items = (MODULE_NAV[module] ?? [{ label: 'Accueil du module', to: def.route }]).filter(
    (i) => (!i.permission || can(i.permission)) && (!i.superAdmin || me?.user.isSuperAdmin),
  );
  let lastGroup: string | undefined;
  const apps = MODULES.filter((m) => ctx?.visibleModules.includes(m.id) && m.id !== module);
  return (
    <aside className="sidebar" aria-label="Navigation">
      <nav>
        <div className="side-title">
          <ModuleIcon id={module} />
          <span>{def.name}</span>
        </div>
        {items.map((i) => {
          const header = i.group && i.group !== lastGroup ? <div className="side-group">{i.group}</div> : null;
          lastGroup = i.group ?? lastGroup;
          return (
            <div key={i.to}>
              {header}
              <NavLink end to={i.to} className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}>
                {i.label}
              </NavLink>
            </div>
          );
        })}
        {apps.length > 0 && <div className="side-group">Applications</div>}
        {apps.map((m) => (
          <NavLink key={m.id} to={m.route} className="side-link">
            <ModuleIcon id={m.id} />
            {m.shortName}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

export function Shell() {
  const { me, associationId, setAssociation, theme, toggleTheme } = useApp();
  const location = useLocation();
  const module = currentModule(location.pathname);
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const color = MODULES_BY_ID[module].color;

  useEffect(() => {
    if (window.matchMedia('(max-width: 900px)').matches) setCollapsed(true);
  }, [location.pathname]);

  return (
    <div className="app" style={{ ['--module' as string]: color }}>
      <a className="skip-link" href="#contenu">
        Aller au contenu
      </a>
      <header className="header">
        <button type="button" className="icon-btn" aria-label={collapsed ? 'Afficher le menu' : 'Masquer le menu'} aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <Link to="/hub" className="brand" aria-label="Scenorya — accueil">
          <BrandLogo />
        </Link>
        {me && me.associations.length > 1 && (
          <div className="assoc-switch hide-mobile">
            <label className="sr-only" htmlFor="assoc-select">
              Association
            </label>
            <select id="assoc-select" value={associationId} onChange={(e) => setAssociation(e.target.value)}>
              {me.associations.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="search hide-mobile">
          <GlobalSearch />
        </div>
        <div className="header-actions">
          <button type="button" className="icon-btn" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Activer le mode clair' : 'Activer le mode sombre'} title="Changer de thème">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <Launcher />
          <AccountMenu />
        </div>
      </header>
      <div className={`body${collapsed ? ' collapsed' : ''}`}>
        <Sidebar module={module} />
        <main id="contenu" className="main" tabIndex={-1}>
          <Outlet />
          <footer className="muted small" style={{ marginTop: 48, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            {BRAND.name} {BRAND.edition} — {BRAND.slogan} {BRAND.signature}. Application indépendante, sans lien avec les services de l’État.
          </footer>
        </main>
      </div>
    </div>
  );
}
