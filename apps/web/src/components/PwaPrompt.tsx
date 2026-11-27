import { useRegisterSW } from 'virtual:pwa-register/react';

/** Proposition de mise à jour de l'application installée (PWA), sans rechargement forcé. */
export function PwaPrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <div className="toasts" role="status">
      <div className="toast">
        <p>Une nouvelle version de Scenorya est disponible.</p>
        <div className="row">
          <button className="btn sm" type="button" onClick={() => updateServiceWorker(true)}>
            Mettre à jour
          </button>
          <button className="btn ghost sm" type="button" onClick={() => setNeedRefresh(false)}>
            Plus tard
          </button>
        </div>
      </div>
    </div>
  );
}
