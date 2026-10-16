import React from 'react';
import {
  AlertCircle,
  ExternalLink,
  Globe,
  KeyRound,
  Lock,
  LogOut,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import type { Translations, Locale } from '../i18n/translations';
import { formatDateTime } from '../i18n/format';
import { useSsoConfig } from '../api/hooks';
import type { SsoEndpoint, SsoEndpointMode } from '../api/types';
import { LoadingState, ErrorState } from '../components/QueryState';

// D-MSSO-2: Stage 2 read-only SSO view. Displays declared GitOps configuration from gitops/values/sso.yaml.
// D-MSSO-5: Prominent notice distinguishing declared Git configuration from live runtime state, upholding
// Beluga integration contract (inferred/uncertain data must not be presented as authoritative).

interface SsoViewProps {
  t: Translations;
  locale?: Locale;
}

export const SsoView: React.FC<SsoViewProps> = ({ t, locale = 'en-US' }) => {
  const { data, isLoading, error } = useSsoConfig();

  if (isLoading) {
    return <LoadingState t={t} />;
  }

  if (error) {
    return <ErrorState t={t} error={error} />;
  }

  if (!data || data.status === 'not-configured') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.sso.title}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">
            {t.sso.subtitle}
          </p>
        </div>

        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/60 p-6 shadow-xs">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-6 w-6 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-2">
              <h3 className="font-bold text-amber-900 dark:text-amber-200 text-base">
                {t.sso.notConfiguredTitle}
              </h3>
              <p className="text-xs text-amber-800 dark:text-amber-300 font-medium leading-relaxed">
                {t.sso.notConfiguredMessage}
              </p>
              {data?.message && (
                <details className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                  <summary className="cursor-pointer font-medium hover:underline text-[11px] text-amber-700 dark:text-amber-400">
                    {t.sso.serverDetails}
                  </summary>
                  <p className="mt-1 font-mono text-[11px] whitespace-pre-wrap bg-amber-100/60 dark:bg-amber-900/40 p-2 rounded border border-amber-300/40 text-amber-900 dark:text-amber-200">
                    {data.message}
                  </p>
                </details>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { config, source } = data;

  const renderModeBadge = (mode: SsoEndpointMode) => {
    switch (mode) {
      case 'gateway-oidc':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-cyan-100 dark:bg-cyan-950 text-cyan-800 dark:text-cyan-300 border border-cyan-300 dark:border-cyan-700">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t.sso.modeGatewayOidc}</span>
          </span>
        );
      case 'app-oidc':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300 border border-purple-300 dark:border-purple-700">
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t.sso.modeAppOidc}</span>
          </span>
        );
      case 'none':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t.sso.modeNone}</span>
          </span>
        );
    }
  };

  const getModeExplanation = (mode: SsoEndpointMode) => {
    switch (mode) {
      case 'gateway-oidc':
        return t.sso.modeExplanationGatewayOidc;
      case 'app-oidc':
        return t.sso.modeExplanationAppOidc;
      case 'none':
      default:
        return t.sso.modeExplanationNone;
    }
  };

  return (
    <div className="space-y-6">
      {/* View Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          {t.sso.title}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">
          {t.sso.subtitle}
        </p>
      </div>

      {/* D-MSSO-5: Declared Git Configuration Notice Banner */}
      <div className="rounded-xl border border-cyan-200 dark:border-cyan-800 bg-cyan-50/70 dark:bg-cyan-950/40 p-4 shadow-xs backdrop-blur-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-cyan-100 dark:bg-cyan-900 p-2 text-cyan-800 dark:text-cyan-200 border border-cyan-300 dark:border-cyan-700">
              <Shield className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <span>{t.sso.declaredNoticeTitle}</span>
                <span className="font-mono text-xs text-cyan-800 dark:text-cyan-300 font-bold bg-cyan-100 dark:bg-cyan-900/60 px-2 py-0.5 rounded">
                  {source.path}
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 font-medium leading-relaxed">
                {t.sso.declaredNoticeDescription}
              </p>
            </div>
          </div>
          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 shrink-0">
            <span>{t.sso.loadedAtLabel}: </span>
            <span className="font-bold text-slate-700 dark:text-slate-200">
              {formatDateTime(source.loadedAt, locale)}
            </span>
          </div>
        </div>
      </div>

      {/* Realm & Issuer Metadata Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Realm Card */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs">
          <div className="text-xs font-bold text-slate-500 dark:text-slate-400">
            {t.sso.realmLabel}
          </div>
          <div className="mt-1 text-lg font-mono font-bold text-slate-900 dark:text-white">
            {config.realm}
          </div>
        </div>

        {/* Issuer Host Card */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs">
          <div className="text-xs font-bold text-slate-500 dark:text-slate-400">
            {t.sso.issuerHostLabel}
          </div>
          <div className="mt-1 text-sm font-mono font-bold text-cyan-700 dark:text-cyan-400 truncate">
            {config.issuerHost}
          </div>
        </div>

        {/* Issuer URL Card */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs">
          <div className="text-xs font-bold text-slate-500 dark:text-slate-400">
            {t.sso.issuerLabel}
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-xs font-mono font-medium text-slate-700 dark:text-slate-300 truncate">
              {config.issuer}
            </span>
            <a
              href={config.issuer}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 shrink-0 p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
              title={t.common.openInNewTab}
              aria-label={t.common.openInNewTab}
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>

      {/* Endpoints Section Header */}
      <div>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">
          {t.sso.endpointsTitle}
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
          {t.sso.endpointsSubtitle}
        </p>
      </div>

      {/* Endpoints Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {config.endpoints.map((endpoint: SsoEndpoint) => (
          <div
            key={endpoint.name}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs flex flex-col justify-between space-y-4"
          >
            <div>
              {/* Header: Service Name & Mode Badge */}
              <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
                  <span className="font-mono font-bold text-sm text-slate-900 dark:text-white">
                    {endpoint.name}
                  </span>
                </div>
                {renderModeBadge(endpoint.mode)}
              </div>

              {/* Host Link & Client ID */}
              <div className="mt-3 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 dark:text-slate-400 font-medium">
                    {t.sso.endpointHost}:
                  </span>
                  <a
                    href={`https://${endpoint.host}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono font-bold text-cyan-700 dark:text-cyan-400 hover:underline"
                    title={t.sso.visitEndpoint}
                    aria-label={t.sso.visitEndpoint}
                  >
                    <span>{endpoint.host}</span>
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-500 dark:text-slate-400 font-medium">
                    {t.sso.endpointClientId}:
                  </span>
                  <span className="font-mono text-slate-800 dark:text-slate-200 font-semibold">
                    {endpoint.clientId || t.sso.noneClientId}
                  </span>
                </div>
              </div>

              {/* Path Rules Section */}
              <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2.5 text-xs">
                {/* Protected Paths */}
                <div>
                  <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300 font-bold mb-1.5">
                    <Lock className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    <span>{t.sso.protectedPaths}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pl-1">
                    {endpoint.protectedPathPrefixes.length > 0 ? (
                      endpoint.protectedPathPrefixes.map((p) => (
                        <span
                          key={p}
                          className="px-2 py-0.5 rounded font-mono text-[11px] bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                        >
                          {p}
                        </span>
                      ))
                    ) : (
                      <span className="text-slate-400 italic text-[11px]">{t.sso.noPaths}</span>
                    )}
                  </div>
                </div>

                {/* Bypass Paths */}
                <div>
                  <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300 font-bold mb-1.5">
                    <Unlock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                    <span>{t.sso.bypassPaths}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pl-1">
                    {endpoint.bypassPathPrefixes.length > 0 ? (
                      endpoint.bypassPathPrefixes.map((p) => (
                        <span
                          key={p}
                          className="px-2 py-0.5 rounded font-mono text-[11px] bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
                        >
                          {p}
                        </span>
                      ))
                    ) : (
                      <span className="text-slate-400 italic text-[11px]">{t.sso.noPaths}</span>
                    )}
                  </div>
                </div>

                {/* Redirect & Logout Paths */}
                {(endpoint.redirectPath || endpoint.logoutPath) && (
                  <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-slate-600 dark:text-slate-400 font-mono">
                    {endpoint.redirectPath && (
                      <div className="flex items-center gap-1">
                        <span className="text-slate-500 font-sans">{t.sso.redirectPath}:</span>
                        <span className="px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200">
                          {endpoint.redirectPath}
                        </span>
                      </div>
                    )}
                    {endpoint.logoutPath && (
                      <div className="flex items-center gap-1">
                        <LogOut className="h-3 w-3 text-slate-400" aria-hidden="true" />
                        <span className="text-slate-500 font-sans">{t.sso.logoutPath}:</span>
                        <span className="px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200">
                          {endpoint.logoutPath}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Mode Explanation Footer Callout */}
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed font-medium">
              {getModeExplanation(endpoint.mode)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
