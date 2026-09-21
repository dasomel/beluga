export interface AppConfig {
  apiBaseUrl: string;
}

// ADR-0001 Consequences: air-gap 환경에서 재빌드 없이 API base URL을 바꿀 수 있도록
// 빌드타임 env var 대신 부팅 시 fetch하는 런타임 config.json을 쓰기로 이미 결정되어 있다.
export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch('/config.json');
  if (!response.ok) {
    throw new Error(`Failed to load /config.json: ${response.status}`);
  }
  return (await response.json()) as AppConfig;
}
