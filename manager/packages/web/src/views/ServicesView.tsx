import React, { useState } from 'react';
import { Search, ExternalLink, Tag } from 'lucide-react';
import { Translations } from '../i18n/translations';
import { useServices } from '../api/hooks';
import { StatusBadge } from '../components/StatusBadge';
import { LoadingState, ErrorState } from '../components/QueryState';
import { WarningsBadge } from '../components/WarningsBadge';

interface ServicesViewProps {
  t: Translations;
  initialServiceId?: string;
}

export const ServicesView: React.FC<ServicesViewProps> = ({ t, initialServiceId }) => {
  const [searchTerm, setSearchTerm] = useState(initialServiceId ?? '');
  const [selectedType, setSelectedType] = useState<string>('ALL');

  const servicesQuery = useServices();
  const services = servicesQuery.data?.data ?? [];
  const warnings = servicesQuery.data?.warnings ?? [];

  const types = ['ALL', ...Array.from(new Set(services.map((svc) => svc.type)))];

  const filteredServices = services.filter((svc) => {
    const search = searchTerm.toLowerCase();
    const matchesSearch =
      svc.name.toLowerCase().includes(search) ||
      svc.id.toLowerCase().includes(search) ||
      (svc.endpoint?.toLowerCase().includes(search) ?? false) ||
      svc.capabilities.some((cap) => cap.toLowerCase().includes(search));

    const matchesType = selectedType === 'ALL' || svc.type === selectedType;
    return matchesSearch && matchesType;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.services.title}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.services.subtitle}</p>
        </div>
        <WarningsBadge warnings={warnings} t={t} />
      </div>

      {servicesQuery.isLoading && <LoadingState t={t} />}
      {!servicesQuery.isLoading && servicesQuery.isError && <ErrorState t={t} error={servicesQuery.error} />}

      {!servicesQuery.isLoading && !servicesQuery.isError && (
        <>
          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
            <div className="relative w-full sm:w-96">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={t.services.searchPlaceholder}
                className="w-full pl-9 pr-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 shadow-xs"
              />
            </div>

            {/* Type Pills */}
            <div className="flex flex-wrap gap-1.5 w-full sm:w-auto">
              {types.map((type) => (
                <button
                  key={type}
                  onClick={() => setSelectedType(type)}
                  className={`px-2.5 py-1 rounded-md text-xs font-bold transition-colors ${
                    selectedType === type
                      ? 'bg-cyan-50 dark:bg-cyan-950/80 text-cyan-800 dark:text-cyan-200 border border-cyan-300 dark:border-cyan-500/60 shadow-xs'
                      : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white border border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {type === 'ALL' ? t.services.filterAll : type}
                </button>
              ))}
            </div>
          </div>

          {/* Services Table */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs backdrop-blur-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-700 dark:text-slate-200">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-300">
                  <tr>
                    <th className="py-3.5 px-4">{t.services.columns.name}</th>
                    <th className="py-3.5 px-4">{t.services.columns.category}</th>
                    <th className="py-3.5 px-4">{t.services.columns.status}</th>
                    <th className="py-3.5 px-4">{t.services.columns.version}</th>
                    <th className="py-3.5 px-4">{t.services.columns.endpoint}</th>
                    <th className="py-3.5 px-4 text-right">{t.services.columns.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
                  {filteredServices.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-slate-500 dark:text-slate-400">
                        {t.services.emptyState}
                      </td>
                    </tr>
                  )}
                  {filteredServices.map((svc) => (
                    <tr key={svc.id} className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${svc.id === searchTerm ? 'bg-cyan-50 dark:bg-cyan-950' : ''}`}>
                      <td className="py-4 px-4">
                        <div className="font-bold text-slate-900 dark:text-white text-sm">{svc.name}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-300 mt-0.5 font-mono font-medium">{svc.id}</div>
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {svc.capabilities.slice(0, 3).map((cap) => (
                            <span
                              key={cap}
                              className="inline-flex items-center gap-1 rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-700 dark:text-slate-300 font-mono border border-slate-200 dark:border-slate-700 font-medium"
                            >
                              <Tag className="h-2.5 w-2.5 text-cyan-600 dark:text-cyan-400" /> {cap}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-4 px-4 whitespace-nowrap">
                        <span className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-xs text-slate-700 dark:text-slate-200 font-bold border border-slate-200 dark:border-slate-700">
                          {svc.type}
                        </span>
                      </td>
                      <td className="py-4 px-4 whitespace-nowrap">
                        <StatusBadge status={svc.status} t={t} />
                      </td>
                      <td className="py-4 px-4 whitespace-nowrap font-mono text-xs text-slate-700 dark:text-slate-200 font-bold">
                        {svc.version ?? '—'}
                      </td>
                      <td className="py-4 px-4 font-mono text-xs text-slate-500 dark:text-slate-300 max-w-xs truncate font-medium">
                        {svc.endpoint ?? '—'}
                      </td>
                      <td className="py-4 px-4 text-right whitespace-nowrap">
                        {svc.endpoint ? (
                          <a
                            href={svc.endpoint}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg bg-cyan-50 dark:bg-cyan-950/80 hover:bg-cyan-100 dark:hover:bg-cyan-900 text-cyan-800 dark:text-cyan-300 px-2.5 py-1.5 text-xs font-bold border border-cyan-200 dark:border-cyan-700 transition-colors shadow-xs"
                          >
                            {t.services.openUi}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-xs text-slate-400 font-mono">{t.services.internalOnly}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
