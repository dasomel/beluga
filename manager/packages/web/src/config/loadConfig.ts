// D-MSSO-6 (ADR-0009): optional OIDC section. Absent => login disabled (local development),
// API calls carry no credentials. Only `issuer` is required when the section is present.
export interface OidcRuntimeConfig {
  issuer: string;
  clientId?: string;
  redirectPath?: string;
  scope?: string;
}

export interface AppConfig {
  apiBaseUrl: string;
  oidc?: OidcRuntimeConfig;
}

// ADR-0001 Consequences: air-gap 환경에서 재빌드 없이 API base URL을 바꿀 수 있도록
// 빌드타임 env var 대신 부팅 시 fetch하는 런타임 config.json을 쓰기로 이미 결정되어 있다.
export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch('/config.json');
  if (!response.ok) {
    throw new Error(`Failed to load /config.json: ${response.status}`);
  }
  const config = (await response.json()) as AppConfig;
  validateOidcConfig(config);
  return config;
}

// A present `oidc` key is an intent to enable login, so a typo must fail loudly (main.tsx shows
// the configuration error screen) rather than silently fall back to "login disabled".
export function validateOidcConfig(config: AppConfig): void {
  if (!('oidc' in config) || config.oidc === undefined) return;
  const oidc: unknown = config.oidc;
  if (typeof oidc !== 'object' || oidc === null || Array.isArray(oidc)) {
    throw new Error('Invalid /config.json: oidc must be an object');
  }
  const { issuer, clientId, redirectPath, scope } = oidc as Record<string, unknown>;
  let issuerUrl: URL | null = null;
  try {
    if (typeof issuer === 'string') issuerUrl = new URL(issuer);
  } catch {
    issuerUrl = null;
  }
  if (issuerUrl?.protocol !== 'https:') {
    throw new Error('Invalid /config.json: oidc.issuer must be an https URL');
  }
  if (clientId !== undefined && (typeof clientId !== 'string' || clientId.trim() === '')) {
    throw new Error('Invalid /config.json: oidc.clientId must be a non-empty string');
  }
  if (redirectPath !== undefined && (typeof redirectPath !== 'string' || !redirectPath.startsWith('/'))) {
    throw new Error('Invalid /config.json: oidc.redirectPath must start with "/"');
  }
  if (scope !== undefined && (typeof scope !== 'string' || scope.trim() === '')) {
    throw new Error('Invalid /config.json: oidc.scope must be a non-empty string');
  }
}
