import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { grantsCover, ModuleId } from '@scenorya/shared';
import { api, ApiError, session } from './api/client';
import type { AppContext, Me } from './api/types';

interface AppState {
  me: Me | null;
  meLoading: boolean;
  ctx: AppContext | null;
  ctxLoading: boolean;
  ctxError: unknown;
  associationId: string;
  setAssociation: (id: string) => void;
  can: (permission: string) => boolean;
  isVisible: (m: ModuleId) => boolean;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  toast: (message: string, kind?: 'success' | 'error') => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp hors du fournisseur');
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [associationId, setAssociationId] = useState(session.associationId);
  const [theme, setTheme] = useState<'light' | 'dark'>(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: 'success' | 'error' }[]>([]);

  const meQ = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await api.get<Me>('/auth/me');
        session.setCsrf(me.csrfToken);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
  const me = meQ.data ?? null;

  // Association courante : celle mémorisée si toujours accessible, sinon la première.
  useEffect(() => {
    if (!me) return;
    const ok = me.associations.some((a) => a.id === associationId);
    if (!ok && me.associations[0]) {
      session.setAssociation(me.associations[0].id);
      setAssociationId(me.associations[0].id);
    }
  }, [me, associationId]);

  const ctxEnabled = Boolean(me && !me.user.mustChangePassword && associationId && me.associations.some((a) => a.id === associationId));
  const ctxQ = useQuery({
    queryKey: ['context', associationId],
    queryFn: () => api.get<AppContext>('/context'),
    enabled: ctxEnabled,
    staleTime: 30_000,
  });

  // Temps réel : rechargement des modules, menus et lanceur après un changement d'état.
  useEffect(() => {
    if (!me || !associationId) return;
    const socket = io({ path: '/api/realtime', transports: ['websocket', 'polling'] });
    socket.on('connect', () => socket.emit('join', { associationId }));
    socket.on('modules:changed', () => {
      qc.invalidateQueries({ queryKey: ['context'] });
      qc.invalidateQueries({ queryKey: ['admin-modules'] });
      qc.invalidateQueries({ queryKey: ['hub'] });
    });
    return () => {
      socket.close();
    };
  }, [me, associationId, qc]);

  const setAssociation = useCallback(
    (id: string) => {
      session.setAssociation(id);
      setAssociationId(id);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
    [qc],
  );

  const toast = useCallback((message: string, kind: 'success' | 'error' = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4500);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('scenorya:theme', next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const ctx = ctxQ.data ?? null;
  const value = useMemo<AppState>(
    () => ({
      me,
      meLoading: meQ.isLoading,
      ctx,
      ctxLoading: ctxEnabled && ctxQ.isLoading,
      ctxError: ctxQ.error,
      associationId,
      setAssociation,
      can: (p) => Boolean(ctx && grantsCover(ctx.grants, p)),
      isVisible: (m) => Boolean(ctx?.visibleModules.includes(m)),
      theme,
      toggleTheme,
      toast,
      refresh: async () => {
        await qc.invalidateQueries();
      },
    }),
    [me, meQ.isLoading, ctx, ctxEnabled, ctxQ.isLoading, ctxQ.error, associationId, setAssociation, theme, toggleTheme, toast, qc],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
