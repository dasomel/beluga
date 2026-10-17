import React, { createContext, useContext } from 'react';
import type { AppConfig, OidcRuntimeConfig } from './loadConfig';

const ConfigContext = createContext<AppConfig | null>(null);

interface ConfigProviderProps {
  config: AppConfig;
  children: React.ReactNode;
}

export const ConfigProvider: React.FC<ConfigProviderProps> = ({ config, children }) => (
  <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>
);

export function useApiBaseUrl(): string {
  const config = useContext(ConfigContext);
  if (!config) {
    throw new Error('useApiBaseUrl must be used within a ConfigProvider');
  }
  return config.apiBaseUrl;
}

// D-DOM-2/3: the platform domain is not hard-coded in the UI. The Keycloak issuer is https://sso.<baseDomain>/realms/..
// by construction of the chart (config.json oidc.issuer), so the base domain is the issuer host minus its first label.
// Without OIDC (local development) or with an unexpected issuer, fall back to the Vagrant default.
export const DEFAULT_BASE_DOMAIN = 'local.beluga.internal';

export function baseDomainFromIssuer(issuer: string | undefined): string {
  if (!issuer) return DEFAULT_BASE_DOMAIN;
  try {
    const labels = new URL(issuer).hostname.split('.');
    return labels.length >= 3 ? labels.slice(1).join('.') : DEFAULT_BASE_DOMAIN;
  } catch {
    return DEFAULT_BASE_DOMAIN;
  }
}

export function useBaseDomain(): string {
  return baseDomainFromIssuer(useContext(ConfigContext)?.oidc?.issuer);
}

export function useOidcConfig(): OidcRuntimeConfig | undefined {
  const config = useContext(ConfigContext);
  if (!config) {
    throw new Error('useOidcConfig must be used within a ConfigProvider');
  }
  return config.oidc;
}
