import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { shouldRetryQuery } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { ConfigProvider } from './config/ConfigContext';
import { loadConfig } from './config/loadConfig';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find root element');
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery } } });

loadConfig()
  .then((config) => {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <ConfigProvider config={config}>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <App />
            </AuthProvider>
          </QueryClientProvider>
        </ConfigProvider>
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const errorElement = document.createElement('div');
    errorElement.style.cssText = 'padding: 2rem; font-family: sans-serif; color: #991b1b;';
    errorElement.textContent = `Failed to load application configuration: ${message}`;
    rootElement.replaceChildren(errorElement);
  });
