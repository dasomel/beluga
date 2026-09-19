import React, { useState } from 'react';
import { Shield, Lock, FileCode, Users, CheckCircle2 } from 'lucide-react';
import { Translations } from '../i18n/translations';

interface PolicyViewProps {
  t: Translations;
}

export const PolicyView: React.FC<PolicyViewProps> = ({ t }) => {
  const [activeTab, setActiveTab] = useState<'roles' | 'rego' | 'sql'>('roles');

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
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t.policy.subtitle}</p>
      </div>

      {/* Compiler Banner */}
      <div className="rounded-xl border border-cyan-200 dark:border-cyan-500/30 bg-cyan-50/70 dark:bg-cyan-950/20 p-4 shadow-xs dark:shadow-none backdrop-blur-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-cyan-100 dark:bg-cyan-500/20 p-2 text-cyan-700 dark:text-cyan-400 border border-cyan-200 dark:border-transparent">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-slate-900 dark:text-white">Central Policy Compiler: policyctl v0.1.0</div>
            <div className="text-xs text-slate-600 dark:text-slate-400 font-mono mt-0.5">
              Source YAML: <span className="text-cyan-800 dark:text-cyan-300 font-semibold">beluga/policies/*.yaml</span> &rarr; Target: OPA Rego, PG DDL, Keycloak Mapper
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">
            <CheckCircle2 className="h-3.5 w-3.5" /> Seam Coherence Verified
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-4">
        <button
          onClick={() => setActiveTab('roles')}
          className={`pb-3 text-sm font-semibold transition-colors border-b-2 flex items-center gap-2 ${
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
          className={`pb-3 text-sm font-semibold transition-colors border-b-2 flex items-center gap-2 ${
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
          className={`pb-3 text-sm font-semibold transition-colors border-b-2 flex items-center gap-2 ${
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
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-5 shadow-xs dark:shadow-none backdrop-blur-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-500/20 text-purple-800 dark:text-purple-300 border border-purple-200 dark:border-purple-500/30">
                ROLE: admins
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono font-medium">LDAP: cn=admins</span>
            </div>
            <h3 className="font-bold text-slate-900 dark:text-white text-base">플랫폼 전체 관리자</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              모든 카탈로그, 스키마, 파이프라인 및 인프라 구성에 대한 완전한 읽기/쓰기/인가 제어 권한을 보유합니다.
            </p>
            <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800/80 text-xs space-y-1">
              <div className="text-slate-700 dark:text-slate-300 font-semibold">부여된 권한:</div>
              <div className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">&bull; Trino: ALL OPERATIONS</div>
              <div className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">&bull; Postgres: SUPERUSER / ALL</div>
              <div className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">&bull; Keycloak: realm-admin</div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-5 shadow-xs dark:shadow-none backdrop-blur-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-500/20 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-500/30">
                ROLE: engineers
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono font-medium">LDAP: cn=engineers</span>
            </div>
            <h3 className="font-bold text-slate-900 dark:text-white text-base">데이터 엔지니어</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              파이프라인 구축, 테이블 DDL 생성 및 Flink/Kafka 잡에 대한 운영/수정 권한을 보유합니다.
            </p>
            <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800/80 text-xs space-y-1">
              <div className="text-slate-700 dark:text-slate-300 font-semibold">부여된 권한:</div>
              <div className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">&bull; Trino: SELECT, INSERT, CREATE</div>
              <div className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">&bull; Postgres: CRUD on public</div>
              <div className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">&bull; Flink: Submit / Cancel Job</div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-5 shadow-xs dark:shadow-none backdrop-blur-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30">
                ROLE: analysts
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono font-medium">LDAP: cn=analysts</span>
            </div>
            <h3 className="font-bold text-slate-900 dark:text-white text-base">데이터 분석가</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              Iceberg 레이크하우스 및 원천 DB에 대한 읽기 전용 쿼리 권한과 민감정보(PII) 마스킹이 적용됩니다.
            </p>
            <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800/80 text-xs space-y-1">
              <div className="text-slate-700 dark:text-slate-300 font-semibold">부여된 권한:</div>
              <div className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">&bull; Trino: SELECT-only (Masked PII)</div>
              <div className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">&bull; Postgres: SELECT-only</div>
              <div className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">&bull; Superset: Dashboard Consumer</div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'rego' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 shadow-xs dark:shadow-none backdrop-blur-sm">
          <div className="text-xs font-mono text-slate-500 dark:text-slate-400 mb-2">
            Target: <span className="text-cyan-700 dark:text-cyan-300 font-semibold">beluga/gitops/charts/beluga-platform/files/opa/trino.rego</span>
          </div>
          <pre className="p-4 rounded-lg bg-slate-900 font-mono text-xs text-cyan-200 leading-relaxed border border-slate-800 shadow-inner overflow-x-auto">
            {sampleRego}
          </pre>
        </div>
      )}

      {activeTab === 'sql' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 shadow-xs dark:shadow-none backdrop-blur-sm">
          <div className="text-xs font-mono text-slate-500 dark:text-slate-400 mb-2">
            Target: <span className="text-cyan-700 dark:text-cyan-300 font-semibold">beluga/gitops/charts/beluga-data/files/db-roles.sql</span>
          </div>
          <pre className="p-4 rounded-lg bg-slate-900 font-mono text-xs text-cyan-200 leading-relaxed border border-slate-800 shadow-inner overflow-x-auto">
            {sampleSql}
          </pre>
        </div>
      )}
    </div>
  );
};
