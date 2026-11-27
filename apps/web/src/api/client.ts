/** Client HTTP : cookie de session httpOnly + jeton CSRF + association courante. */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

let csrfToken = '';
let associationId = localStorage.getItem('scenorya:association') ?? '';

export const session = {
  setCsrf(t: string) {
    csrfToken = t;
  },
  get associationId() {
    return associationId;
  },
  setAssociation(id: string) {
    associationId = id;
    try {
      localStorage.setItem('scenorya:association', id);
    } catch {
      /* stockage indisponible : la valeur reste en mémoire */
    }
  },
};

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  if (associationId) headers['X-Scenorya-Association'] = associationId;
  let res: Response;
  try {
    res = await fetch(`/api${url}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Le serveur est injoignable. Vérifiez votre connexion.');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const d = (data ?? {}) as { code?: string; message?: string | string[]; details?: unknown };
    const msg = Array.isArray(d.message) ? d.message.join(' ') : d.message;
    throw new ApiError(res.status, d.code ?? `HTTP_${res.status}`, msg ?? 'Une erreur est survenue.', d.details);
  }
  if (data && typeof data === 'object' && 'csrfToken' in (data as object)) csrfToken = (data as { csrfToken: string }).csrfToken;
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return { message: t };
  }
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
  /** Téléchargement authentifié d'un fichier (CSV, sauvegarde…). */
  async download(url: string, fallbackName: string) {
    const res = await fetch(`/api${url}`, { credentials: 'same-origin', headers: associationId ? { 'X-Scenorya-Association': associationId } : {} });
    if (!res.ok) {
      const d = safeJson(await res.text());
      throw new ApiError(res.status, d.code ?? 'DOWNLOAD', d.message ?? 'Téléchargement impossible.');
    }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'VALIDATION_ERROR' && Array.isArray(e.details)) {
      return `${e.message} ${(e.details as { path: string; message: string }[]).map((d) => (d.path ? `${d.path} : ` : '') + d.message).join(' ; ')}`;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : 'Une erreur est survenue.';
}
