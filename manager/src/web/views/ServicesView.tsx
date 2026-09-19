import React, { useState } from 'react';
import { Search, ExternalLink, CheckCircle2, Tag } from 'lucide-react';
import { Translations } from '../i18n/translations';
import { servicesData } from '../data/mockData';

interface ServicesViewProps {
  t: Translations;
}

export const ServicesView: React.FC<ServicesViewProps> = ({ t }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');

  const categories = ['ALL', ...Array.from(new Set(servicesData.map(s => s.category)))];

  const filteredServices = servicesData.filter(svc => {
    const matchesSearch = 
      svc.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      svc.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      svc.endpoint.toLowerCase().includes(searchTerm.toLowerCase()) ||
      svc.capabilities.some(c => c.toLowerCase().includes(searchTerm.toLowerCase()));
    
    const matchesCategory = selectedCategory === 'ALL' || svc.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.services.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t.services.subtitle}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
        <div className="relative w-full sm:w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t.services.searchPlaceholder}
            className="w-full pl-9 pr-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 shadow-xs"
          />
        </div>

        {/* Category Pills */}
        <div className="flex flex-wrap gap-1.5 w-full sm:w-auto">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                selectedCategory === cat
                  ? 'bg-cyan-50 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-500/40 shadow-xs'
                  : 'bg-white dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 border border-slate-200 dark:border-slate-800'
              }`}
            >
              {cat === 'ALL' ? t.services.filterAll : cat}
            </button>
          ))}
        </div>
      </div>

      {/* Services Table */}
      <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 overflow-hidden shadow-xs dark:shadow-xl backdrop-blur-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-700 dark:text-slate-300">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/70 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <tr>
                <th className="py-3.5 px-4">{t.services.columns.name}</th>
                <th className="py-3.5 px-4">{t.services.columns.category}</th>
                <th className="py-3.5 px-4">{t.services.columns.status}</th>
                <th className="py-3.5 px-4">{t.services.columns.version}</th>
                <th className="py-3.5 px-4">{t.services.columns.endpoint}</th>
                <th className="py-3.5 px-4 text-right">{t.services.columns.actions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/60">
              {filteredServices.map((svc) => (
                <tr key={svc.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/30 transition-colors">
                  <td className="py-4 px-4">
                    <div className="font-bold text-slate-900 dark:text-white">{svc.name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">{svc.description}</div>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {svc.capabilities.slice(0, 3).map((cap) => (
                        <span key={cap} className="inline-flex items-center gap-1 rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-700 dark:text-slate-300 font-mono border border-slate-200 dark:border-transparent">
                          <Tag className="h-2.5 w-2.5 text-cyan-600 dark:text-cyan-400" /> {cap}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-4 px-4 whitespace-nowrap">
                    <span className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-xs text-slate-700 dark:text-slate-300 font-semibold border border-slate-200 dark:border-transparent">
                      {svc.category}
                    </span>
                  </td>
                  <td className="py-4 px-4 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {svc.status === 'healthy' ? t.services.statusHealthy : svc.status}
                    </span>
                  </td>
                  <td className="py-4 px-4 whitespace-nowrap font-mono text-xs text-slate-700 dark:text-slate-300 font-medium">
                    {svc.version}
                  </td>
                  <td className="py-4 px-4 font-mono text-xs text-slate-500 dark:text-slate-400 max-w-xs truncate">
                    {svc.endpoint}
                  </td>
                  <td className="py-4 px-4 text-right whitespace-nowrap">
                    {svc.externalUrl ? (
                      <a
                        href={svc.externalUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg bg-cyan-50 dark:bg-cyan-600/20 hover:bg-cyan-100 dark:hover:bg-cyan-600/30 text-cyan-800 dark:text-cyan-300 px-2.5 py-1.5 text-xs font-semibold border border-cyan-200 dark:border-cyan-500/30 transition-colors shadow-xs"
                      >
                        {t.services.openUi}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-xs text-slate-400 font-mono">Internal-only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
