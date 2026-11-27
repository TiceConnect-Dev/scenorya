import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MODULES, ModuleId } from '@scenorya/shared';
import { useApp } from '../state';
import { api } from '../api/client';
import type { Member, Paged } from '../api/types';
import { ModuleIcon } from '../components/ui';
import { MODULE_NAV } from '../navigation';

interface Result {
  key: string;
  label: string;
  hint: string;
  to: string;
  module: ModuleId;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Recherche globale (raccourcis « / » ou Ctrl+K) : applications, pages et
 * adhérents. Les résultats respectent les modules visibles et les permissions ;
 * la recherche d'adhérents est filtrée côté serveur.
 */
export function GlobalSearch() {
  const { ctx, can, me } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName);
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const canSearchMembers = Boolean(ctx?.visibleModules.includes('asso') && can('asso.members.read'));
  const membersQ = useQuery({
    queryKey: ['search-members', ctx?.association.id, debounced],
    queryFn: () => api.get<Paged<Member>>(`/asso/members?pageSize=6&q=${encodeURIComponent(debounced)}`),
    enabled: canSearchMembers && debounced.length >= 2,
  });

  const results = useMemo<Result[]>(() => {
    if (!debounced || !ctx) return [];
    const n = norm(debounced);
    const out: Result[] = [];
    for (const m of MODULES) {
      if (!ctx.visibleModules.includes(m.id)) continue;
      if (norm(`${m.name} ${m.description}`).includes(n)) out.push({ key: `m-${m.id}`, label: m.name, hint: 'Application', to: m.route, module: m.id });
      for (const item of MODULE_NAV[m.id] ?? []) {
        if ((item.permission && !can(item.permission)) || (item.superAdmin && !me?.user.isSuperAdmin)) continue;
        if (norm(item.label).includes(n)) out.push({ key: `p-${item.to}`, label: item.label, hint: m.name, to: item.to, module: m.id });
      }
    }
    for (const mb of membersQ.data?.items ?? []) {
      out.push({ key: `a-${mb.id}`, label: `${mb.firstName} ${mb.lastName}`, hint: `Adhérent n° ${mb.number}`, to: `/asso/adherents/${mb.id}`, module: 'asso' });
    }
    return out.slice(0, 12);
  }, [debounced, ctx, can, me, membersQ.data]);

  const go = (r: Result) => {
    setOpen(false);
    setQ('');
    navigate(r.to);
  };

  return (
    <div role="search" style={{ position: 'relative' }}>
      <label htmlFor="global-search" className="sr-only">
        Rechercher dans Scenorya
      </label>
      <input
        ref={input}
        id="global-search"
        type="search"
        placeholder="Rechercher (/ ou Ctrl+K)"
        value={q}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="search-listbox"
        aria-autocomplete="list"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && results[active]) {
            go(results[active]);
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && debounced && (
        <div className="popover search-results">
          {results.length === 0 ? (
            <p className="muted small" style={{ padding: '10px 14px', margin: 0 }}>
              {membersQ.isFetching ? 'Recherche…' : 'Aucun résultat.'}
            </p>
          ) : (
            <ul id="search-listbox" role="listbox">
              {results.map((r, i) => (
                <li key={r.key} role="presentation">
                  <a
                    href={r.to}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      go(r);
                    }}
                  >
                    <ModuleIcon id={r.module} />
                    <span className="grow">{r.label}</span>
                    <span className="small muted">{r.hint}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
