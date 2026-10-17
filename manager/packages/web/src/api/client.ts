export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// D-MSSO-6 (ADR-0009): the Domain API contract is `Authorization: Bearer <access_token>`;
// 401 = (re)login, 403 = signed in but not permitted. Auth state lives in React
// (auth/AuthContext), so the fetch layer reaches it through two registered callbacks
// instead of every hook threading a token. Cost: one module-level slot; escape hatch: pass
// the callbacks through ConfigContext-style context if more than one app ever shares a page.
export interface ApiAuthHooks {
  getAccessToken(): string | null;
  onUnauthorized(): void;
}

let authHooks: ApiAuthHooks | null = null;

export function setApiAuthHooks(hooks: ApiAuthHooks | null): void {
  authHooks = hooks;
}

// Retrying 401/403 only repeats a rejected credential; everything else keeps the default 3.
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
  return failureCount < 3;
}

export async function apiGet<T>(baseUrl: string, path: string): Promise<T> {
  const token = authHooks?.getAccessToken() ?? null;
  const response = token
    ? await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    : await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    if (response.status === 401) authHooks?.onUnauthorized();
    throw new ApiError(response.status, `${path} responded with ${response.status}`);
  }
  return (await response.json()) as T;
}
