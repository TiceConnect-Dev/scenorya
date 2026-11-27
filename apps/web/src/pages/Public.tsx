import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BRAND, MODULES, MODULE_PROFILES, MODULES_BY_ID, ModuleId, planActivation } from '@scenorya/shared';
import { api, errorMessage } from '../api/client';
import { useApp } from '../state';
import { Alert, BrandLogo, ErrorBox, Field, Loading } from '../components/ui';

function AuthLayout({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="auth-page">
      <div className={`auth-card${wide ? ' wide' : ''}`}>
        <BrandLogo className="auth-logo" />
        <div className="card">{children}</div>
        <p className="auth-foot">
          {BRAND.slogan}
          <br />
          {BRAND.signature} — édition {BRAND.edition}
        </p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { me } = useApp();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsSetup: boolean }>('/setup/status') });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.title = 'Connexion — Scenorya';
  }, []);

  if (status.data?.needsSetup) return <Navigate to="/installation" replace />;
  if (me) return <Navigate to={me.user.mustChangePassword ? '/mot-de-passe' : '/hub'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/hub');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1>Connexion</h1>
      <p className="muted">{BRAND.subtitle}</p>
      <form onSubmit={submit} className="stack" noValidate>
        {error && (
          <div className="alert danger" role="alert">
            {error}
          </div>
        )}
        <Field label="Adresse e-mail">{(id) => <input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Mot de passe">{(id) => <input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </AuthLayout>
  );
}

export function ChangePasswordPage() {
  const { me, toast } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!me) return <Navigate to="/connexion" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError('Les deux mots de passe ne correspondent pas.');
    try {
      await api.post('/auth/password', { current, next });
      toast('Mot de passe modifié.');
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/hub');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <AuthLayout>
      <h1>Choisissez votre mot de passe</h1>
      <p className="muted">Votre mot de passe actuel est provisoire. Choisissez-en un nouveau pour continuer.</p>
      <form onSubmit={submit} className="stack">
        {error && <div className="alert danger" role="alert">{error}</div>}
        <Field label="Mot de passe provisoire">{(id) => <input id={id} type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
        <Field label="Nouveau mot de passe" hint="12 caractères minimum, mélangeant lettres et chiffres ou symboles.">
          {(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
        <Field label="Confirmation">{(id) => <input id={id} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
        <button className="btn" type="submit">Enregistrer</button>
      </form>
    </AuthLayout>
  );
}

/* --------------------------------------------- Assistant d'installation */

const STEPS = ['Sécurité', 'Administrateur', 'Association', 'Modules', 'Messagerie', 'Récapitulatif'];

export function SetupPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsSetup: boolean }>('/setup/status') });
  const [step, setStep] = useState(0);
  const [token, setToken] = useState('');
  const [admin, setAdmin] = useState({ email: '', displayName: '', password: '', confirm: '' });
  const [assoc, setAssoc] = useState({ name: '', email: '', city: '' });
  const [profile, setProfile] = useState('theatre');
  const [selected, setSelected] = useState<Set<ModuleId>>(new Set(MODULE_PROFILES.find((p) => p.id === 'theatre')!.modules));
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [smtp, setSmtp] = useState({ host: '', port: 587, secure: false, user: '', password: '', from: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Installation — Scenorya';
  }, []);

  // Dépendances strictes ajoutées automatiquement (affichées à l'utilisateur).
  const autoDeps = useMemo(() => {
    const config = Object.fromEntries([...selected].map((m) => [m, 'active' as const]));
    const deps = new Set<ModuleId>();
    for (const m of selected) planActivation({ config }, m).toActivate.forEach((d) => !selected.has(d) && deps.add(d));
    return [...deps];
  }, [selected]);

  if (status.isLoading) return <AuthLayout><Loading /></AuthLayout>;
  if (status.data && !status.data.needsSetup) return <Navigate to="/connexion" replace />;

  const optional = MODULES.filter((m) => !m.core);
  const chooseProfile = (id: string) => {
    setProfile(id);
    const p = MODULE_PROFILES.find((x) => x.id === id)!;
    if (id !== 'personnalise') setSelected(new Set(p.modules));
  };
  const toggle = (id: ModuleId) => {
    setProfile('personnalise');
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const validate = (): string | null => {
    if (step === 0 && token.trim().length < 8) return "Saisissez le jeton d'installation affiché dans les journaux du serveur.";
    if (step === 1) {
      if (!/^\S+@\S+\.\S+$/.test(admin.email)) return 'Adresse e-mail invalide.';
      if (admin.displayName.trim().length < 2) return 'Indiquez votre nom.';
      if (admin.password.length < 12) return 'Le mot de passe doit contenir au moins 12 caractères.';
      if (admin.password !== admin.confirm) return 'Les mots de passe ne correspondent pas.';
    }
    if (step === 2 && assoc.name.trim().length < 2) return "Indiquez le nom de l'association.";
    if (step === 4 && smtpEnabled && (!smtp.host || !smtp.from)) return 'Renseignez au minimum le serveur et l’expéditeur, ou passez cette étape.';
    return null;
  };

  const next = async (e: FormEvent) => {
    e.preventDefault();
    const v = validate();
    if (v) return setError(v);
    setError(null);
    if (step < STEPS.length - 1) return setStep(step + 1);
    setBusy(true);
    try {
      const res = await api.post<{ associationId: string }>('/setup', {
        setupToken: token.trim(),
        admin: { email: admin.email, displayName: admin.displayName, password: admin.password },
        association: { name: assoc.name, email: assoc.email || null, city: assoc.city || null },
        modules: [...selected],
        smtp: smtpEnabled ? { ...smtp, user: smtp.user || null, password: smtp.password || null } : null,
      });
      localStorage.setItem('scenorya:association', res.associationId);
      await qc.invalidateQueries();
      navigate('/hub');
      window.location.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout wide>
      <h1>Bienvenue dans Scenorya</h1>
      <p className="muted">Assistant de première configuration. Aucun compte par défaut n’est créé : vous définissez vous-même l’administrateur.</p>
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : ''}>
            {s}
          </li>
        ))}
      </ol>
      <form onSubmit={next} className="stack" noValidate>
        {error && <div className="alert danger" role="alert">{error}</div>}

        {step === 0 && (
          <>
            <Alert>
              Pour éviter qu’un tiers ne s’approprie une instance exposée sur Internet, un jeton d’installation est exigé. Il est affiché dans les journaux du conteneur au
              premier démarrage (<span className="mono">docker logs scenorya</span>) ou défini par la variable <span className="mono">SETUP_TOKEN</span>.
            </Alert>
            <Field label="Jeton d'installation">{(id) => <input id={id} type="text" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />}</Field>
          </>
        )}

        {step === 1 && (
          <div className="form-grid">
            <Field label="Nom complet">{(id) => <input id={id} type="text" autoComplete="name" value={admin.displayName} onChange={(e) => setAdmin({ ...admin, displayName: e.target.value })} />}</Field>
            <Field label="Adresse e-mail">{(id) => <input id={id} type="email" autoComplete="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} />}</Field>
            <Field label="Mot de passe" hint="12 caractères minimum, lettres et chiffres ou symboles.">
              {(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} />}
            </Field>
            <Field label="Confirmation">{(id) => <input id={id} type="password" autoComplete="new-password" value={admin.confirm} onChange={(e) => setAdmin({ ...admin, confirm: e.target.value })} />}</Field>
            <p className="full small muted">Ce compte sera superadministrateur de l’instance et administrateur de la première association.</p>
          </div>
        )}

        {step === 2 && (
          <div className="form-grid">
            <Field label="Nom de l'association" className="full">{(id) => <input id={id} type="text" value={assoc.name} onChange={(e) => setAssoc({ ...assoc, name: e.target.value })} />}</Field>
            <Field label="E-mail de contact (facultatif)">{(id) => <input id={id} type="email" value={assoc.email} onChange={(e) => setAssoc({ ...assoc, email: e.target.value })} />}</Field>
            <Field label="Ville (facultatif)">{(id) => <input id={id} type="text" value={assoc.city} onChange={(e) => setAssoc({ ...assoc, city: e.target.value })} />}</Field>
            <p className="full small muted">Les informations légales (RNA, SIRET, coordonnées bancaires…) se complètent ensuite dans Scenorya Admin.</p>
          </div>
        )}

        {step === 3 && (
          <>
            <fieldset>
              <legend>Profil de départ</legend>
              <p className="small muted">Un profil n’est qu’une présélection : vous pouvez cocher ou décocher chaque module, et tout modifier plus tard.</p>
              <div className="profile-grid">
                {MODULE_PROFILES.map((p) => (
                  <button type="button" key={p.id} className="profile-option" aria-pressed={profile === p.id} onClick={() => chooseProfile(p.id)}>
                    <strong>{p.label}</strong>
                    <div className="small muted">{p.description}</div>
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Modules ({selected.size} sélectionnés + socle)</legend>
              <p className="small muted">Toujours actifs : {MODULES.filter((m) => m.core).map((m) => m.name).join(', ')}.</p>
              <div className="module-pick">
                {optional.map((m) => (
                  <label key={m.id}>
                    <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                    <img src={m.assets.icon} alt="" />
                    <span>
                      <strong>{m.shortName}</strong>
                      <span className="small muted" style={{ display: 'block' }}>{m.tagline}</span>
                    </span>
                  </label>
                ))}
              </div>
              {autoDeps.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <Alert tone="warning">Dépendances activées automatiquement : {autoDeps.map((d) => MODULES_BY_ID[d].name).join(', ')}.</Alert>
                </div>
              )}
            </fieldset>
          </>
        )}

        {step === 4 && (
          <>
            <label className="check">
              <input type="checkbox" checked={smtpEnabled} onChange={(e) => setSmtpEnabled(e.target.checked)} />
              <span>Configurer la messagerie maintenant (sinon, plus tard dans Scenorya System)</span>
            </label>
            {smtpEnabled && (
              <div className="form-grid">
                <Field label="Serveur SMTP">{(id) => <input id={id} type="text" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />}</Field>
                <Field label="Port">{(id) => <input id={id} type="number" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })} />}</Field>
                <Field label="Utilisateur">{(id) => <input id={id} type="text" autoComplete="off" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} />}</Field>
                <Field label="Mot de passe" hint="Stocké chiffré (AES-256-GCM).">{(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={smtp.password} onChange={(e) => setSmtp({ ...smtp, password: e.target.value })} />}</Field>
                <Field label="Expéditeur" hint="Ex. : Scenorya <no-reply@mon-asso.fr>">{(id, d) => <input id={id} aria-describedby={d} type="text" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} />}</Field>
                <label className="check" style={{ alignSelf: 'end' }}>
                  <input type="checkbox" checked={smtp.secure} onChange={(e) => setSmtp({ ...smtp, secure: e.target.checked })} />
                  <span>Connexion TLS directe (port 465)</span>
                </label>
              </div>
            )}
          </>
        )}

        {step === 5 && (
          <dl className="props">
            <dt>Administrateur</dt>
            <dd>{admin.displayName} — {admin.email}</dd>
            <dt>Association</dt>
            <dd>{assoc.name}</dd>
            <dt>Modules</dt>
            <dd>{[...selected, ...autoDeps].map((m) => MODULES_BY_ID[m].shortName).join(', ') || 'Socle uniquement'}</dd>
            <dt>Messagerie</dt>
            <dd>{smtpEnabled ? `${smtp.host}:${smtp.port}` : 'À configurer plus tard'}</dd>
          </dl>
        )}

        <div className="form-actions">
          {step > 0 && (
            <button type="button" className="btn secondary" onClick={() => setStep(step - 1)}>
              Précédent
            </button>
          )}
          <button type="submit" className="btn" disabled={busy}>
            {step === STEPS.length - 1 ? (busy ? 'Installation…' : 'Terminer l’installation') : 'Continuer'}
          </button>
        </div>
      </form>
      {status.error ? <ErrorBox error={status.error} /> : null}
    </AuthLayout>
  );
}
