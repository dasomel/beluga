import React, { createContext, useContext } from 'react';
import type { AppConfig } from './loadConfig';

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
