import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { useApp } from '../state';
import { Breadcrumb, ErrorBox, Field, formatDate, Loading, PageHead } from '../components/ui';

interface SessionRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export function AccountPage() {
  const { me, toast } = useApp();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<SessionRow[]>('/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast('Session révoquée.');
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw.next !== pw.confirm) return setError('Les deux mots de passe ne correspondent pas.');
    try {
      await api.post('/auth/password', { current: pw.current, next: pw.next });
      setPw({ current: '', next: '', confirm: '' });
      toast('Mot de passe modifié. Vos autres sessions ont été fermées.');
      qc.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <Breadcrumb items={[{ label: 'Mon compte' }]} />
      <PageHead title="Mon compte et sécurité" description={me ? `${me.user.displayName} — ${me.user.email}` : undefined} />
      <div className="grid-2">
        <form className="card stack" onSubmit={submit}>
          <h2>Changer de mot de passe</h2>
          {error && <div className="alert danger" role="alert">{error}</div>}
          <Field label="Mot de passe actuel">{(id) => <input id={id} type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />}</Field>
          <Field label="Nouveau mot de passe" hint="12 caractères minimum.">{(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />}</Field>
          <Field label="Confirmation">{(id) => <input id={id} type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />}</Field>
          <div className="form-actions">
            <button className="btn" type="submit">Modifier</button>
          </div>
        </form>
        <section className="card">
          <h2>Sessions actives</h2>
          {sessions.isLoading && <Loading />}
          {sessions.error && <ErrorBox error={sessions.error} />}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {sessions.data?.map((s) => (
              <li key={s.id} className="row between" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div className="small">{s.userAgent?.slice(0, 80) ?? 'Navigateur inconnu'}</div>
                  <div className="small muted">
                    {s.ip ?? 'IP inconnue'} · ouverte le {formatDate(s.createdAt, true)} · active le {formatDate(s.lastSeenAt, true)}
                  </div>
                </div>
                {s.current ? (
                  <span className="badge info">Session actuelle</span>
                ) : (
                  <button className="btn secondary sm" type="button" onClick={() => revoke.mutate(s.id)}>
                    Révoquer
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
