import React, { useState } from 'react';
import { Shield, FileCode, Users, Copy, Check, Lock, Eye, AlertCircle } from 'lucide-react';
import type { Translations } from '../i18n/translations';
import { interpolate } from '../i18n/interpolate';
import { usePolicies } from '../api/hooks';
import { LoadingState, ErrorState } from '../components/QueryState';

interface PolicyViewProps {
  t: Translations;
}

export const PolicyView: React.FC<PolicyViewProps> = ({ t }) => {
  const [activeTab, setActiveTab] = useState<'roles' | 'artefacts'>('roles');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { data, isLoading, error } = usePolicies();

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  if (isLoading) {
    return <LoadingState t={t} />;
  }

  if (error) {
    return <ErrorState t={t} error={error} />;
  }

  const policy = data?.data[0];

  if (!policy) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400 font-medium">
        {t.policy.emptyState}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.policy.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.policy.subtitle}</p>
      </div>

      {/* Compiler Banner */}
      <div className="rounded-xl border border-cyan-200 dark:border-cyan-800 bg-cyan-50 dark:bg-cyan-950/80 p-4 shadow-xs backdrop-blur-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-cyan-100 dark:bg-cyan-900 p-2 text-cyan-800 dark:text-cyan-200 border border-cyan-300 dark:border-cyan-700">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-slate-900 dark:text-white">
              {t.policy.compilerTitle}: {interpolate(t.policy.compilerVersion, { version: policy.version })}
            </div>
            <div className="text-xs text-slate-600 dark:text-slate-300 font-mono mt-0.5 font-medium">
              {t.policy.sourceYamlLabel} <span className="text-cyan-800 dark:text-cyan-300 font-bold">{policy.sourceFile}</span> {t.policy.compileTargetsSummary}
            </div>
          </div>
        </div>
        <div className="text-xs text-cyan-900 dark:text-cyan-100 font-medium">
          {policy.description}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-4">
        <button
          type="button"
          onClick={() => setActiveTab('roles')}
          className={`pb-3 text-sm font-bold transition-colors border-b-2 flex items-center gap-2 ${
            activeTab === 'roles'
              ? 'border-cyan-600 dark:border-cyan-400 text-cyan-800 dark:text-cyan-300'
              : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Users className="h-4 w-4" />
          {t.policy.rolesTab}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('artefacts')}
          className={`pb-3 text-sm font-bold transition-colors border-b-2 flex items-center gap-2 ${
            activeTab === 'artefacts'
              ? 'border-cyan-600 dark:border-cyan-400 text-cyan-800 dark:text-cyan-300'
              : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <FileCode className="h-4 w-4" />
          {t.policy.artefactsTab}
        </button>
      </div>

      {/* Tab Content: Roles */}
      {activeTab === 'roles' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {policy.roles.map((role) => {
            const readOnlyPerms = role.permissions.filter((p) => p.accessType === 'read-only');
            const mutatingPerms = role.permissions.filter((p) => p.accessType === 'mutating');

            return (
              <div
                key={role.name}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-950/80 text-purple-800 dark:text-purple-300 border border-purple-200 dark:border-purple-700">
                      {`${t.policy.roleBadge}: ${role.name}`}
                    </span>
                  </div>

                  <h3 className="font-bold text-slate-900 dark:text-white text-base">
                    {role.name}
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed font-medium">
                    {`${t.policy.ldapGroupNameLabel}: ${role.name}`}
                  </p>

                  {role.includes.length > 0 && (
                    <div className="mt-2 text-[11px] font-mono text-slate-500 dark:text-slate-400 font-medium">
                      {`${t.policy.includesLabel}: [${role.includes.join(', ')}]`}
                    </div>
                  )}
                </div>

                <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
                  {/* Read-only Section */}
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Eye className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-200">
                        {t.policy.readOnlySection}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded font-mono font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300">
                        {t.policy.readOnlyBadge}
                      </span>
                    </div>
                    {readOnlyPerms.length > 0 ? (
                      <div className="space-y-1 pl-1">
                        {readOnlyPerms.map((perm, idx) => (
                          <div
                            key={`${perm.catalog}-${perm.resource}-${perm.operation}-${idx}`}
                            className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium"
                          >
                            {`• ${perm.catalog}:${perm.resource} [${perm.operation}]`}
                            {perm.columnMask && (
                              <span className="text-cyan-700 dark:text-cyan-400 text-[10px] ml-1">
                                {`(${interpolate(t.policy.maskAnnotation, { columns: Object.keys(perm.columnMask).join(', ') })})`}
                              </span>
                            )}
                            {perm.rowFilter && (
                              <span className="text-purple-700 dark:text-purple-400 text-[10px] ml-1">
                                {`(${interpolate(t.policy.filterAnnotation, { filter: perm.rowFilter })})`}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-400 italic pl-1">{t.policy.noPermissions}</div>
                    )}
                  </div>

                  {/* Mutating Section */}
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Lock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-200">
                        {t.policy.mutatingSection}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded font-mono font-bold bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300">
                        {t.policy.mutatingBadge}
                      </span>
                    </div>
                    {mutatingPerms.length > 0 ? (
                      <div className="space-y-1 pl-1">
                        {mutatingPerms.map((perm, idx) => (
                          <div
                            key={`${perm.catalog}-${perm.resource}-${perm.operation}-${idx}`}
                            className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium"
                          >
                            {`• ${perm.catalog}:${perm.resource} [${perm.operation}]`}
                            {perm.allowUnmasked && (
                              <span className="text-amber-700 dark:text-amber-400 text-[10px] ml-1">
                                {`(${t.policy.unmaskedAnnotation})`}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-400 italic pl-1">{t.policy.noPermissions}</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tab Content: Artefacts */}
      {activeTab === 'artefacts' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3.5 flex items-center gap-2.5 text-xs text-slate-600 dark:text-slate-300">
            <AlertCircle className="h-4 w-4 text-cyan-600 dark:text-cyan-400 shrink-0" />
            <span>{t.policy.metadataSecurityNotice}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {policy.artefacts.map((artefact) => (
              <div
                key={artefact.target}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-200 dark:border-slate-800">
                    <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-cyan-50 dark:bg-cyan-950/80 text-cyan-800 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-700">
                      {artefact.target}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400 font-mono font-medium">
                      {interpolate(t.policy.linesCount, { count: artefact.lineCount })}
                    </span>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-bold text-slate-700 dark:text-slate-200">
                      {t.policy.hashLabel}
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-950 font-mono text-[11px] text-cyan-200 leading-relaxed border border-slate-800 shadow-inner break-all select-all">
                      {artefact.contentHash}
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end">
                  <button
                    type="button"
                    onClick={() => handleCopy(artefact.contentHash, artefact.target)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors border border-slate-200 dark:border-slate-700 shadow-xs"
                  >
                    {copiedKey === artefact.target ? (
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5 text-slate-500" />
                    )}
                    <span>{copiedKey === artefact.target ? t.common.copied : t.policy.copyHash}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
