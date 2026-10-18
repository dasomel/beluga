export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Stable error code from the `{ error: { code, message } }` envelope, when the body had one. */
    public readonly code?: string,
    /** The server's own message for that code (shown as detail; never parsed). */
    public readonly detail?: string,
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

async function toApiError(response: Response, path: string): Promise<ApiError> {
  let code: string | undefined;
  let detail: string | undefined;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') detail = body.error.message;
  } catch {
    // Non-JSON error body: status alone is what we know.
  }
  return new ApiError(response.status, `${path} responded with ${response.status}`, code, detail);
}

export async function apiGet<T>(baseUrl: string, path: string): Promise<T> {
  const token = authHooks?.getAccessToken() ?? null;
  const response = token
    ? await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    : await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    if (response.status === 401) authHooks?.onUnauthorized();
    throw await toApiError(response, path);
  }
  return (await response.json()) as T;
}

export async function apiSend<T>(
  baseUrl: string,
  method: 'POST',
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const token = authHooks?.getAccessToken() ?? null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 401) authHooks?.onUnauthorized();
    throw await toApiError(response, path);
  }
  return (await response.json()) as T;
}
