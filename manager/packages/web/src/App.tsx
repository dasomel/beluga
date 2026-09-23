import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  Server,
  GitFork,
  Database,
  Terminal,
  ShieldCheck,
  Globe,
  Layers,
  Waypoints,
  Activity,
  ChevronRight,
  ExternalLink,
  Sun,
  Moon,
  X,
  Palette,
  CheckCircle2
} from 'lucide-react';
import { readStoredValue, storeValue } from './config/storage';
import { getInitialLocale, persistLocale } from './i18n/locale';
import { getTranslations } from './i18n/getTranslations';
import type { Locale } from './i18n/translations';
import { OverviewView } from './views/OverviewView';
import { ServicesView } from './views/ServicesView';
import { PipelinesView } from './views/PipelinesView';
import { ArchitectureView } from './views/ArchitectureView';
import { OperationsView } from './views/OperationsView';
import { DataCatalogView } from './views/DataCatalogView';
import { QueryWorkspaceView } from './views/QueryWorkspaceView';
import { PolicyView } from './views/PolicyView';

const FigmaIcon: React.FC<{ className?: string }> = ({ className = "h-4 w-4" }) => (
  <svg viewBox="0 0 38 57" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path d="M19 28.5C19 23.2533 23.2533 19 28.5 19C33.7467 19 38 23.2533 38 28.5C38 33.7467 33.7467 38 28.5 38C23.2533 38 19 33.7467 19 28.5Z" fill="#1ABCFE"/>
    <path d="M0 47.5C0 42.2533 4.25329 38 9.5 38H19V47.5C19 52.7467 14.7467 57 9.5 57C4.25329 57 0 52.7467 0 47.5Z" fill="#0ACF83"/>
    <path d="M19 0V19H28.5C33.7467 19 38 14.7467 38 9.5C38 4.25329 33.7467 0 28.5 0H19Z" fill="#FF7262"/>
    <path d="M0 9.5C0 14.7467 4.25329 19 9.5 19H19V0H9.5C4.25329 0 0 4.25329 0 9.5Z" fill="#F24E1E"/>
    <path d="M0 28.5C0 33.7467 4.25329 38 9.5 38H19V19H9.5C4.25329 19 0 23.2533 0 28.5Z" fill="#A259FF"/>
  </svg>
);

export const App: React.FC = () => {
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale(window));
  const [currentTab, setCurrentTab] = useState<string>('overview');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return readStoredValue('beluga_theme', window) === 'dark' ? 'dark' : 'light';
  });
  const [isFigmaModalOpen, setIsFigmaModalOpen] = useState<boolean>(false);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    storeValue('beluga_theme', theme, window);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const toggleTheme = () => {
    setTheme(prev => (prev === 'light' ? 'dark' : 'light'));
  };

  const selectLocale = (nextLocale: Locale) => {
    setLocale(nextLocale);
    persistLocale(nextLocale, window);
  };

  const t = getTranslations(locale);

  const navItems = [
    { id: 'overview', label: t.nav.overview, icon: LayoutDashboard },
    { id: 'services', label: t.nav.services, icon: Server },
    { id: 'pipelines', label: t.nav.pipelines, icon: GitFork },
    { id: 'architecture', label: t.nav.architecture, icon: Waypoints },
    { id: 'operations', label: t.nav.operations, icon: Activity },
    { id: 'catalog', label: t.nav.dataCatalog, icon: Database },
    { id: 'query', label: t.nav.query, icon: Terminal },
    { id: 'policy', label: t.nav.policy, icon: ShieldCheck },
  ];

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans transition-colors duration-150">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between flex-shrink-0 shadow-xs dark:shadow-none">
        <div>
          {/* Brand Logo */}
          <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-600 flex items-center justify-center shadow-md shadow-cyan-500/20">
                <Layers className="h-5 w-5 text-white" />
              </div>
              <div>
                <div className="font-bold text-sm tracking-tight text-slate-900 dark:text-white flex items-center gap-1.5">
                  {t.appName}
                  <span className="text-[10px] rounded bg-cyan-100 dark:bg-cyan-500/20 px-1.5 py-0.2 font-mono text-cyan-800 dark:text-cyan-300 font-bold border border-cyan-200 dark:border-cyan-500/40">v0.1</span>
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">Control Plane</div>
              </div>
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
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-semibold transition-all ${
                    isActive
                      ? 'bg-cyan-50 dark:bg-cyan-950/60 text-cyan-900 dark:text-cyan-200 border border-cyan-300 dark:border-cyan-500/50 shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800/80 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className={`h-4 w-4 ${isActive ? 'text-cyan-700 dark:text-cyan-400' : 'text-slate-400 dark:text-slate-400'}`} />
                    <span>{item.label}</span>
                  </div>
                  {isActive && <ChevronRight className="h-3.5 w-3.5 text-cyan-700 dark:text-cyan-400" />}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3 bg-slate-50/50 dark:bg-slate-950/40">
          {/* Cluster Status Indicator */}
          <div className="rounded-lg bg-white dark:bg-slate-900 p-3 border border-slate-200 dark:border-slate-800 shadow-xs">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-600 dark:text-slate-300 font-medium">Cluster</span>
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse"></span>
                HEALTHY
              </span>
            </div>
            <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-1 font-medium">192.168.77.x &bull; MetalLB 80</div>
          </div>

          {/* Theme & Language Controls */}
          <div className="flex items-center justify-between gap-2 text-xs">
            {/* Theme Toggle Button */}
            <button
              onClick={toggleTheme}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 font-bold transition-colors shadow-xs"
              title={theme === 'light' ? t.common.darkMode : t.common.lightMode}
            >
              {theme === 'light' ? (
                <>
                  <Sun className="h-3.5 w-3.5 text-amber-500" />
                  <span className="text-[11px]">화이트</span>
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5 text-cyan-400" />
                  <span className="text-[11px]">다크</span>
                </>
              )}
            </button>

            {/* Language Switcher */}
            <div className="flex rounded-md bg-white dark:bg-slate-800 p-0.5 border border-slate-200 dark:border-slate-700 text-[11px] shadow-xs">
              <button
                onClick={() => selectLocale('ko-KR')}
                className={`px-2 py-1 rounded font-bold transition-colors ${
                  locale === 'ko-KR' 
                    ? 'bg-cyan-50 dark:bg-cyan-900/50 text-cyan-800 dark:text-cyan-300 shadow-xs' 
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                KO
              </button>
              <button
                onClick={() => selectLocale('en-US')}
                className={`px-2 py-1 rounded font-bold transition-colors ${
                  locale === 'en-US' 
                    ? 'bg-cyan-50 dark:bg-cyan-900/50 text-cyan-800 dark:text-cyan-300 shadow-xs' 
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
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
        <header className="h-16 border-b border-slate-200 dark:border-slate-800 px-8 flex items-center justify-between bg-white dark:bg-slate-900 sticky top-0 z-10 shadow-xs">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700">
              mdp / beluga-manager
            </span>
            <span className="text-slate-300 dark:text-slate-600 text-xs">&bull;</span>
            <span className="text-xs text-slate-600 dark:text-slate-300">
              Gateway: <span className="text-slate-900 dark:text-white font-mono font-bold">*.local.beluga.internal</span>
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Figma Link & Spec Button */}
            <button
              onClick={() => setIsFigmaModalOpen(true)}
              className="flex items-center gap-1.5 text-xs font-bold text-purple-800 dark:text-purple-200 bg-purple-50 dark:bg-purple-950/70 border border-purple-200 dark:border-purple-700 hover:bg-purple-100 dark:hover:bg-purple-900/80 px-2.5 py-1.5 rounded-lg transition-all shadow-xs"
            >
              <FigmaIcon className="h-3.5 w-3.5" />
              <span>{t.common.figmaSpec}</span>
            </button>

            <div className="h-4 w-px bg-slate-200 dark:border-slate-800" />

            <a
              href="http://argocd.local.beluga.internal"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 hover:text-cyan-700 dark:hover:text-cyan-300 font-mono font-medium transition-colors"
            >
              <span>ArgoCD</span>
              <ExternalLink className="h-3 w-3" />
            </a>
            <span className="text-slate-300 dark:text-slate-600">|</span>
            <a
              href="http://sso.local.beluga.internal"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 hover:text-cyan-700 dark:hover:text-cyan-300 font-mono font-medium transition-colors"
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
          {currentTab === 'architecture' && <ArchitectureView t={t} theme={theme} />}
          {currentTab === 'operations' && <OperationsView t={t} />}
          {currentTab === 'catalog' && <DataCatalogView t={t} />}
          {currentTab === 'query' && <QueryWorkspaceView t={t} />}
          {currentTab === 'policy' && <PolicyView t={t} />}
        </main>
      </div>

      {/* Figma Design System Modal (High-Contrast & Dual-Theme Tokens) */}
      {isFigmaModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
          <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 w-full max-w-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-purple-100 dark:bg-purple-950/80 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                  <FigmaIcon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-slate-900 dark:text-white">Beluga Design System (Figma Spec)</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">WCAG AAA High-Contrast & Dual-Theme Tokens</p>
                </div>
              </div>
              <button
                onClick={() => setIsFigmaModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-5 text-xs text-slate-700 dark:text-slate-200">
              <div className="rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-700 p-4">
                <div className="font-bold text-purple-900 dark:text-purple-200 text-sm mb-1.5 flex items-center gap-1.5">
                  <Palette className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                  피그마 가독성 원칙 & 고대비(High-Contrast) 레이어링
                </div>
                <p className="text-xs text-purple-900 dark:text-purple-200 leading-relaxed font-medium">
                  다크 모드와 화이트 모드 모두에서 명도 대비를 7:1(WCAG AAA) 수준으로 확보하여 테이블 그리드, 
                  파이프라인 토폴로지, SQL 에디터의 시인성을 극대화하도록 토큰 계층(Canvas &rarr; Surface &rarr; Card &rarr; Control)이 재정의되었습니다.
                </p>
              </div>

              {/* Tokens Preview: Light vs Dark Side-by-Side */}
              <div className="space-y-3">
                <div className="font-bold text-slate-900 dark:text-white flex items-center justify-between">
                  <span>디자인 토큰 대비 체계 (Design Tokens Comparison):</span>
                  <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-semibold">
                    <CheckCircle2 className="h-3.5 w-3.5" /> High-Contrast Verified
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 font-mono text-[11px]">
                  {/* Light Tokens Box */}
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 space-y-2">
                    <div className="text-xs font-bold text-slate-900 dark:text-white pb-1 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                      <span>Light Mode (화이트)</span>
                      <span className="text-[10px] text-cyan-700 dark:text-cyan-400">Default</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-slate-400">Canvas</span>
                      <div className="flex items-center gap-1.5">
                        <span className="h-3.5 w-6 rounded bg-white border border-slate-300 shadow-xs"></span>
                        <span className="text-slate-800 dark:text-slate-200 font-semibold">#FFFFFF</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-slate-400">Surface Card</span>
                      <div className="flex items-center gap-1.5">
                        <span className="h-3.5 w-6 rounded bg-slate-100 border border-slate-200"></span>
                        <span className="text-slate-800 dark:text-slate-200 font-semibold">#F8FAFC</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-slate-400">Text Primary</span>
                      <div className="flex items-center gap-1.5">
                        <span className="h-3.5 w-6 rounded bg-slate-900 border border-slate-700"></span>
                        <span className="text-slate-800 dark:text-slate-200 font-semibold">#0F172A</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-slate-400">Accent Cyan</span>
                      <div className="flex items-center gap-1.5">
                        <span className="h-3.5 w-6 rounded bg-cyan-600"></span>
                        <span className="text-slate-800 dark:text-slate-200 font-semibold">#0891B2</span>
                      </div>
                    </div>
                  </div>

                  {/* Dark Tokens Box */}
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 space-y-2">
                    <div className="text-xs font-bold text-slate-900 dark:text-white pb-1 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                      <span>Dark Mode (다크)</span>
                      <span className="text-[10px] text-purple-600 dark:text-purple-400">Layered</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-slate-400">Canvas</span>
                      <div className="flex items-center gap-1.5">
                        <span className="h-3.5 w-6 rounded bg-slate-950 border border-slate-700"></span>
                        <span className="text-slate-800 dark:text-slate-200 font-semibold">#020617</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-slate-400">Surface Card</span>
                      <div className="flex items-center gap-1.5">
                        <span className="h-3.5 w-6 rounded bg-slate-900 border border-slate-700"></span>
                        <span className="text-slate-800 dark:text-slate-200 font-semibold">#0F172A</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-slate-400">Text Primary</span>
                      <div className="flex items-center gap-1.5">
                        <span className="h-3.5 w-6 rounded bg-white border border-slate-300"></span>
                        <span className="text-slate-800 dark:text-slate-200 font-semibold">#FFFFFF</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600 dark:text-slate-400">Accent Cyan</span>
                      <div className="flex items-center gap-1.5">
                        <span className="h-3.5 w-6 rounded bg-cyan-400"></span>
                        <span className="text-slate-800 dark:text-slate-200 font-semibold">#22D3EE</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* External Link Action */}
              <div className="pt-3 flex justify-between items-center border-t border-slate-200 dark:border-slate-800">
                <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">Beluga UI Design System Specification</span>
                <a
                  href="https://www.figma.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 text-white font-bold text-xs transition-colors shadow-sm"
                >
                  <span>피그마에서 디자인 열기</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
