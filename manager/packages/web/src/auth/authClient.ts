import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User, type UserManagerSettings } from 'oidc-client-ts';
import type { OidcRuntimeConfig } from '../config/loadConfig';

export interface AuthUser {
  name: string;
  groups: string[];
  accessToken: string;
}

export interface AuthClient {
  /** Path the IdP redirects back to; App treats a load on this path as a login callback. */
  readonly redirectPath: string;
  restore(): Promise<AuthUser | null>;
  handleCallback(url: string): Promise<AuthUser>;
  login(): Promise<void>;
  logout(): Promise<void>;
  /** Drops the local session without contacting the IdP (used on 401). */
  clear(): Promise<void>;
  /** `onUser` fires on token renewal; `onLost` when the session can no longer be kept. */
  subscribe(handlers: { onUser(user: AuthUser): void; onLost(): void }): () => void;
}

export const DEFAULT_CLIENT_ID = 'beluga-manager';
export const DEFAULT_REDIRECT_PATH = '/auth/callback';
export const DEFAULT_SCOPE = 'openid profile email groups';

// D-MLOGIN-1 token storage: the user (access/refresh/id tokens) is held in memory only.
// sessionStorage/localStorage are readable by any script on the origin (XSS) and a refresh
// token there is a long-lived credential. Cost: a page reload drops the session and the user
// clicks "sign in" again (the Keycloak SSO cookie makes that a no-prompt round trip).
// Escape hatch: pass `new WebStorageStateStore({ store: win.sessionStorage })` as userStore.
// The in-flight PKCE state (code_verifier, state, nonce) must survive the redirect, so it is
// the one thing kept in sessionStorage (tab-scoped, deleted when the callback consumes it).
// localStorage is never used: oidc-client-ts defaults the state store to it, hence explicit.
export function buildUserManagerSettings(oidc: OidcRuntimeConfig, win: Window): UserManagerSettings {
  const origin = win.location.origin;
  return {
    authority: oidc.issuer,
    client_id: oidc.clientId ?? DEFAULT_CLIENT_ID,
    redirect_uri: `${origin}${oidc.redirectPath ?? DEFAULT_REDIRECT_PATH}`,
    post_logout_redirect_uri: `${origin}/`,
    // Authorization Code flow; oidc-client-ts always sends PKCE (code_challenge_method=S256)
    // plus random state and nonce unless disablePKCE is set, which we never set.
    response_type: 'code',
    scope: oidc.scope ?? DEFAULT_SCOPE,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: win.sessionStorage }),
    // D-MLOGIN-2: renewal is driven below (refresh token only). The library's automatic
    // renew falls back to a hidden iframe on `silent_redirect_uri` (default = redirect_uri),
    // which this SPA does not serve, so it stays off.
    automaticSilentRenew: false,
  };
}

function toAuthUser(user: User): AuthUser {
  const profile = user.profile;
  const label = [profile.preferred_username, profile.name, profile.email, profile.sub].find(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  const groups = Array.isArray(profile.groups)
    ? profile.groups.filter((group): group is string => typeof group === 'string')
    : [];
  return { name: label ?? '', groups, accessToken: user.access_token };
}

export function createOidcAuthClient(oidc: OidcRuntimeConfig, win: Window = window): AuthClient {
  const manager = new UserManager(buildUserManagerSettings(oidc, win));
  // Abandoned sign-in attempts leave PKCE state in sessionStorage; drop entries past the
  // library's stale age (15 min default) so they do not accumulate. In-flight logins are younger.
  manager.clearStaleState().catch(() => undefined);

  return {
    redirectPath: oidc.redirectPath ?? DEFAULT_REDIRECT_PATH,
    async restore() {
      const user = await manager.getUser();
      return user && !user.expired ? toAuthUser(user) : null;
    },
    async handleCallback(url) {
      return toAuthUser(await manager.signinRedirectCallback(url));
    },
    login: () => manager.signinRedirect(),
    logout: () => manager.signoutRedirect(),
    clear: () => manager.removeUser(),
    subscribe({ onUser, onLost }) {
      const { events } = manager;
      // D-MLOGIN-2: renew with the refresh token shortly before expiry. Whether Keycloak
      // issues a refresh token to the public client is *not verified*; without one the
      // session simply ends at access-token expiry and the user signs in again.
      const removers = [
        events.addAccessTokenExpiring(() => {
          void manager
            .getUser()
            .then((user) => (user?.refresh_token ? manager.signinSilent() : undefined))
            .catch(() => undefined);
        }),
        events.addUserLoaded((user) => onUser(toAuthUser(user))),
        events.addAccessTokenExpired(onLost),
        events.addSilentRenewError(onLost),
      ];
      return () => removers.forEach((remove) => remove());
    },
  };
}
