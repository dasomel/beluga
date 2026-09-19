import React, { useState } from 'react';
import { Shield, Lock, FileCode, Users, CheckCircle2, Copy, Check } from 'lucide-react';
import { Translations } from '../i18n/translations';

interface PolicyViewProps {
  t: Translations;
}

export const PolicyView: React.FC<PolicyViewProps> = ({ t }) => {
  const [activeTab, setActiveTab] = useState<'roles' | 'rego' | 'sql'>('roles');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const sampleRego = `package trino

import rego.v1

default allow := false

# Root admins have unrestricted access
allow if {
    "admins" in input.context.identity.groups
}

# Engineers can read all catalogs and schemas
allow if {
    "engineers" in input.context.identity.groups
    input.action.operation in ["SelectFromColumns", "FilterCatalogs", "FilterSchemas", "FilterTables"]
}

# Analysts read-only access with column masking on PII
allow if {
    "analysts" in input.context.identity.groups
    input.action.operation in ["SelectFromColumns", "FilterCatalogs", "FilterSchemas", "FilterTables"]
    input.action.resource.table.catalogName == "beluga_lake"
}`;

  const sampleSql = `-- Beluga Policy Compiler Output: db-roles.sql
-- Managed by beluga-manager policyctl (Do not edit manually)

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- NOLOGIN Authority Roles
CREATE ROLE admins NOLOGIN;
CREATE ROLE engineers NOLOGIN;
CREATE ROLE analysts NOLOGIN;

-- Engineers CRUD Privileges
GRANT USAGE ON SCHEMA public TO engineers;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO engineers;

-- Analysts Read-Only Privileges
GRANT USAGE ON SCHEMA public TO analysts;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO analysts;

-- Beluga Admin Superuser
GRANT admins TO beluga_admin;`;

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
            <div className="text-sm font-bold text-slate-900 dark:text-white">Central Policy Compiler: policyctl v0.1.0</div>
            <div className="text-xs text-slate-600 dark:text-slate-300 font-mono mt-0.5 font-medium">
              Source YAML: <span className="text-cyan-800 dark:text-cyan-300 font-bold">beluga/policies/*.yaml</span> &rarr; Target: OPA Rego, PG DDL, Keycloak Mapper
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-500/20 px-2.5 py-1 text-xs font-bold text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-500/40">
            <CheckCircle2 className="h-3.5 w-3.5" /> Seam Coherence Verified
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-4">
        <button
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
          onClick={() => setActiveTab('rego')}
          className={`pb-3 text-sm font-bold transition-colors border-b-2 flex items-center gap-2 ${
            activeTab === 'rego'
              ? 'border-cyan-600 dark:border-cyan-400 text-cyan-800 dark:text-cyan-300'
              : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <FileCode className="h-4 w-4" />
          {t.policy.compiledRego}
        </button>
        <button
          onClick={() => setActiveTab('sql')}
          className={`pb-3 text-sm font-bold transition-colors border-b-2 flex items-center gap-2 ${
            activeTab === 'sql'
              ? 'border-cyan-600 dark:border-cyan-400 text-cyan-800 dark:text-cyan-300'
              : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Lock className="h-4 w-4" />
          {t.policy.compiledSql}
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'roles' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-950/80 text-purple-800 dark:text-purple-300 border border-purple-200 dark:border-purple-700">
                ROLE: admins
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono font-bold">LDAP: cn=admins</span>
            </div>
            <h3 className="font-bold text-slate-900 dark:text-white text-base">플랫폼 전체 관리자</h3>
            <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed font-medium">
              모든 카탈로그, 스키마, 파이프라인 및 인프라 구성에 대한 완전한 읽기/쓰기/인가 제어 권한을 보유합니다.
            </p>
            <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-xs space-y-1">
              <div className="text-slate-700 dark:text-slate-200 font-bold">부여된 권한:</div>
              <div className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium">&bull; Trino: ALL OPERATIONS</div>
              <div className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium">&bull; Postgres: SUPERUSER / ALL</div>
              <div className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium">&bull; Keycloak: realm-admin</div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950/80 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-700">
                ROLE: engineers
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono font-bold">LDAP: cn=engineers</span>
            </div>
            <h3 className="font-bold text-slate-900 dark:text-white text-base">데이터 엔지니어</h3>
            <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed font-medium">
              파이프라인 구축, 테이블 DDL 생성 및 Flink/Kafka 잡에 대한 운영/수정 권한을 보유합니다.
            </p>
            <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-xs space-y-1">
              <div className="text-slate-700 dark:text-slate-200 font-bold">부여된 권한:</div>
              <div className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium">&bull; Trino: SELECT, INSERT, CREATE</div>
              <div className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium">&bull; Postgres: CRUD on public</div>
              <div className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium">&bull; Flink: Submit / Cancel Job</div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700">
                ROLE: analysts
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono font-bold">LDAP: cn=analysts</span>
            </div>
            <h3 className="font-bold text-slate-900 dark:text-white text-base">데이터 분석가</h3>
            <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed font-medium">
              Iceberg 레이크하우스 및 원천 DB에 대한 읽기 전용 쿼리 권한과 민감정보(PII) 마스킹이 적용됩니다.
            </p>
            <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-xs space-y-1">
              <div className="text-slate-700 dark:text-slate-200 font-bold">부여된 권한:</div>
              <div className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium">&bull; Trino: SELECT-only (Masked PII)</div>
              <div className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium">&bull; Postgres: SELECT-only</div>
              <div className="text-slate-600 dark:text-slate-300 font-mono text-[11px] font-medium">&bull; Superset: Dashboard Consumer</div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'rego' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs backdrop-blur-sm">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-200 dark:border-slate-800 text-xs">
            <div className="font-mono text-slate-700 dark:text-slate-300 font-bold">
              Target: <span className="text-cyan-700 dark:text-cyan-400">beluga/gitops/charts/beluga-platform/files/opa/trino.rego</span>
            </div>
            <button
              onClick={() => handleCopy(sampleRego, 'rego')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors border border-slate-200 dark:border-slate-700 shadow-xs"
            >
              {copiedKey === 'rego' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 text-slate-500" />}
              <span>{copiedKey === 'rego' ? '복사됨' : '코드 복사'}</span>
            </button>
          </div>
          <pre className="p-4 rounded-lg bg-slate-950 font-mono text-xs text-cyan-200 leading-relaxed border border-slate-800 shadow-inner overflow-x-auto selection:bg-cyan-600 selection:text-white">
            {sampleRego}
          </pre>
        </div>
      )}

      {activeTab === 'sql' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs backdrop-blur-sm">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-200 dark:border-slate-800 text-xs">
            <div className="font-mono text-slate-700 dark:text-slate-300 font-bold">
              Target: <span className="text-cyan-700 dark:text-cyan-400">beluga/gitops/charts/beluga-data/files/db-roles.sql</span>
            </div>
            <button
              onClick={() => handleCopy(sampleSql, 'sql')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors border border-slate-200 dark:border-slate-700 shadow-xs"
            >
              {copiedKey === 'sql' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 text-slate-500" />}
              <span>{copiedKey === 'sql' ? '복사됨' : '코드 복사'}</span>
            </button>
          </div>
          <pre className="p-4 rounded-lg bg-slate-950 font-mono text-xs text-cyan-200 leading-relaxed border border-slate-800 shadow-inner overflow-x-auto selection:bg-cyan-600 selection:text-white">
            {sampleSql}
          </pre>
        </div>
      )}
    </div>
  );
};
