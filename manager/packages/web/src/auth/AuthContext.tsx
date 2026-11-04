import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setApiAuthHooks } from '../api/client';
import { useOidcConfig } from '../config/ConfigContext';
import { createOidcAuthClient, type AuthClient, type AuthUser } from './authClient';

// 'disabled' = no oidc section in /config.json (local development): no gate, no credentials.
export type AuthStatus = 'disabled' | 'loading' | 'unauthenticated' | 'authenticated' | 'error';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  /** True when the session ended after having been used (401, token expiry), not a first visit. */
  expired: boolean;
  /** True after local logout fallback when the identity provider session may remain active. */
  loggedOut: boolean;
  errorMessage: string | null;
}

export interface AuthContextValue extends AuthState {
  login(): void;
  logout(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const DISABLED: AuthState = { status: 'disabled', user: null, expired: false, loggedOut: false, errorMessage: null };
const LOADING: AuthState = { status: 'loading', user: null, expired: false, loggedOut: false, errorMessage: null };
const SIGNED_OUT: AuthState = { status: 'unauthenticated', user: null, expired: false, loggedOut: false, errorMessage: null };
const LOGGED_OUT_KEY = 'beluga:logged-out';

function hasStoredLogout(): boolean {
  try {
    return window.sessionStorage.getItem(LOGGED_OUT_KEY) !== null;
  } catch {
    return false;
  }
}

function storeLogout(): void {
  try {
    window.sessionStorage.setItem(LOGGED_OUT_KEY, 'true');
  } catch {
    // Keep the in-memory signed-out state even when browser storage is blocked.
  }
}

function clearStoredLogout(): void {
  try {
    window.sessionStorage.removeItem(LOGGED_OUT_KEY);
  } catch {
    // Storage is optional; explicit login still clears the in-memory state.
  }
}

function errorState(error: unknown): AuthState {
  return {
    status: 'error',
    user: null,
    expired: false,
    loggedOut: false,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

interface AuthProviderProps {
  /** Test seam; production builds the client from the runtime `oidc` config. */
  client?: AuthClient;
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ client: injected, children }) => {
  const oidc = useOidcConfig();
  const queryClient = useQueryClient();
  const client = useMemo(
    () => injected ?? (oidc ? createOidcAuthClient(oidc) : null),
    [injected, oidc],
  );
  const [state, setState] = useState<AuthState>(client ? LOADING : DISABLED);
  const tokenRef = useRef<string | null>(null);
  const started = useRef(false);

  const signedIn = useCallback((user: AuthUser) => {
    clearStoredLogout();
    tokenRef.current = user.accessToken;
    setState({ status: 'authenticated', user, expired: false, loggedOut: false, errorMessage: null });
  }, []);

  // Drops credentials and cached responses so a signed-out screen never shows stale data.
  const signedOut = useCallback((expired: boolean, loggedOut = false) => {
    tokenRef.current = null;
    queryClient.clear();
    setState({ ...SIGNED_OUT, expired, loggedOut });
  }, [queryClient]);

  // Layout effect: registered before any child's passive effect starts a query.
  useLayoutEffect(() => {
    if (!client) return undefined;
    setApiAuthHooks({
      getAccessToken: () => tokenRef.current,
      // D-MLOGIN-3: 401 shows the sign-in screen with an "expired" notice instead of
      // redirecting automatically; an auto-redirect would loop forever if the API keeps
      // rejecting a valid Keycloak token (e.g. an `aud` mismatch).
      onUnauthorized: () => {
        if (tokenRef.current === null) return;
        tokenRef.current = null;
        void client.clear().finally(() => signedOut(true));
      },
    });
    return () => setApiAuthHooks(null);
  }, [client, signedOut]);

  useEffect(() => {
    if (!client) return undefined;
    return client.subscribe({ onUser: signedIn, onLost: () => void client.clear().finally(() => signedOut(true)) });
  }, [client, signedIn, signedOut]);

  useEffect(() => {
    // The callback code is single-use; guard against StrictMode's second effect run.
    if (!client || started.current) return;
    started.current = true;
    const url = new URL(window.location.href);
    const onCallback = url.pathname === client.redirectPath;
    const run = onCallback ? client.handleCallback(url.href) : client.restore();
    run.then(
      (user) => {
        if (onCallback) window.history.replaceState(null, '', '/');
        if (user) signedIn(user);
        else setState({ ...SIGNED_OUT, loggedOut: hasStoredLogout() });
      },
      (error: unknown) => {
        if (onCallback) window.history.replaceState(null, '', '/');
        setState(errorState(error));
      },
    );
  }, [client, signedIn]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login: () => {
        if (!client) return;
        clearStoredLogout();
        setState(LOADING);
        try {
          client.login().catch((error: unknown) => setState(errorState(error)));
        } catch (error: unknown) {
          setState(errorState(error));
        }
      },
      logout: () => {
        if (!client) return;
        tokenRef.current = null;
        queryClient.clear();
        // RP-initiated logout (end_session) navigates away; if the IdP has no
        // end_session_endpoint, fall back to a local sign-out.
        client.logout().catch(() => {
          storeLogout();
          return client.clear().finally(() => signedOut(false, true));
        });
      },
    }),
    [state, client, queryClient, signedOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return value;
}
