import React, { useState } from 'react';
import { 
  LayoutDashboard, 
  Server, 
  GitFork, 
  Database, 
  Terminal, 
  ShieldCheck, 
  Globe, 
  Activity,
  Layers,
  ChevronRight,
  ExternalLink
} from 'lucide-react';
import { translations, Locale } from './i18n/translations';
import { OverviewView } from './views/OverviewView';
import { ServicesView } from './views/ServicesView';
import { PipelinesView } from './views/PipelinesView';
import { DataCatalogView } from './views/DataCatalogView';
import { QueryWorkspaceView } from './views/QueryWorkspaceView';
import { PolicyView } from './views/PolicyView';

export const App: React.FC = () => {
  const [locale, setLocale] = useState<Locale>('ko-KR');
  const [currentTab, setCurrentTab] = useState<string>('overview');

  const t = translations[locale];

  const navItems = [
    { id: 'overview', label: t.nav.overview, icon: LayoutDashboard },
    { id: 'services', label: t.nav.services, icon: Server },
    { id: 'pipelines', label: t.nav.pipelines, icon: GitFork },
    { id: 'catalog', label: t.nav.dataCatalog, icon: Database },
    { id: 'query', label: t.nav.query, icon: Terminal },
    { id: 'policy', label: t.nav.policy, icon: ShieldCheck },
  ];

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100 font-sans">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-800/80 bg-slate-950/80 flex flex-col justify-between flex-shrink-0 backdrop-blur-md">
        <div>
          {/* Brand Logo */}
          <div className="p-5 border-b border-slate-800/80 flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Layers className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="font-bold text-sm tracking-tight text-white flex items-center gap-1.5">
                {t.appName}
                <span className="text-[10px] rounded bg-cyan-500/10 px-1.5 py-0.2 font-mono text-cyan-400 font-semibold border border-cyan-500/20">v0.1</span>
              </div>
              <div className="text-[11px] text-slate-400 font-medium">Control Plane</div>
            </div>
          </div>

          {/* Navigation Items */}
          <nav className="p-3 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setCurrentTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-gradient-to-r from-cyan-500/15 to-blue-500/10 text-cyan-300 border border-cyan-500/30 font-semibold shadow-sm'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className={`h-4 w-4 ${isActive ? 'text-cyan-400' : 'text-slate-500'}`} />
                    <span>{item.label}</span>
                  </div>
                  {isActive && <ChevronRight className="h-3.5 w-3.5 text-cyan-400/80" />}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer */}
        <div className="p-4 border-t border-slate-800/80 space-y-3">
          {/* Cluster Status Indicator */}
          <div className="rounded-lg bg-slate-900/80 p-3 border border-slate-800/80">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 font-medium">Cluster</span>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                HEALTHY
              </span>
            </div>
            <div className="text-[10px] font-mono text-slate-500 mt-1">192.168.77.x &bull; MetalLB 80</div>
          </div>

          {/* Language Switcher */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400 flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-slate-500" />
              {t.common.language}
            </span>
            <div className="flex rounded-md bg-slate-900 p-0.5 border border-slate-800 text-[11px]">
              <button
                onClick={() => setLocale('ko-KR')}
                className={`px-2 py-0.5 rounded font-medium transition-colors ${
                  locale === 'ko-KR' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                KO
              </button>
              <button
                onClick={() => setLocale('en-US')}
                className={`px-2 py-0.5 rounded font-medium transition-colors ${
                  locale === 'en-US' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                EN
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <header className="h-16 border-b border-slate-800/80 px-8 flex items-center justify-between bg-slate-950/60 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono px-2 py-1 rounded bg-slate-900 text-slate-400 border border-slate-800">
              mdp / beluga-manager
            </span>
            <span className="text-slate-600 text-xs">&bull;</span>
            <span className="text-xs text-slate-400">
              Gateway: <span className="text-slate-300 font-mono">*.local.beluga.internal</span>
            </span>
          </div>

          <div className="flex items-center gap-3">
            <a
              href="http://argocd.local.beluga.internal"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-cyan-300 font-mono transition-colors"
            >
              <span>ArgoCD</span>
              <ExternalLink className="h-3 w-3" />
            </a>
            <span className="text-slate-700">|</span>
            <a
              href="http://sso.local.beluga.internal"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-cyan-300 font-mono transition-colors"
            >
              <span>Keycloak</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </header>

        {/* View Container */}
        <main className="flex-1 p-8 max-w-7xl w-full mx-auto">
          {currentTab === 'overview' && <OverviewView t={t} onNavigate={(tab) => setCurrentTab(tab)} />}
          {currentTab === 'services' && <ServicesView t={t} />}
          {currentTab === 'pipelines' && <PipelinesView t={t} />}
          {currentTab === 'catalog' && <DataCatalogView t={t} />}
          {currentTab === 'query' && <QueryWorkspaceView t={t} />}
          {currentTab === 'policy' && <PolicyView t={t} />}
        </main>
      </div>
    </div>
  );
};
