import type { PolicyPermission, PolicyProjection } from "../schema/policy.js";

// D1: 이 projection은 Domain API가 독립 실행 가능하도록 컴파일 결과를 런타임에 다시
// 만들지 않는 checked-in fixture다. 원천 YAML/컴파일러와의 일치는 drift test가 검증한다.
const analystPermissions: PolicyPermission[] = [
  { resource: "lake.events_enriched", catalog: "iceberg", engine: "trino", operation: "select", accessType: "read-only" },
  { resource: "lake.customers", catalog: "iceberg", engine: "trino", operation: "select", accessType: "read-only", columnMask: { email: "hash" }, rowFilter: "region = 'KR'" },
  { resource: "public.service_audit", catalog: "postgres", engine: "postgres", operation: "select", accessType: "read-only" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "ExecuteQuery", accessType: "read-only" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "AccessCatalog", accessType: "read-only" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "ShowSchemas", accessType: "read-only" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "ShowTables", accessType: "read-only" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "ShowColumns", accessType: "read-only" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "FilterCatalogs", accessType: "read-only" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "FilterSchemas", accessType: "read-only" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "FilterTables", accessType: "read-only" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "FilterColumns", accessType: "read-only" },
];

// D3: 각 역할에는 선언에 직접 연결된 grant만 표시한다. includes는 Keycloak composite
// (compiler/keycloak.ts)와 PostgreSQL role membership (compiler/pgddl.ts)로 별도 해석되므로,
// 실효 grant를 반복하면 같은 권한과 마스킹 상태를 중복해 보여 준다. 실효 목록이 필요해지면
// 상속 항목을 따라가야 하는 비용이 있다. API에 명시적인 provenance/effective 필드를 추가하고
// fixture projection을 바꾸는 것이 그 탈출구다.
const engineerPermissions: PolicyPermission[] = [
  { resource: "lake.customers", catalog: "iceberg", engine: "trino", operation: "select", accessType: "read-only", allowUnmasked: true },
  { resource: "lake.customers", catalog: "iceberg", engine: "trino", operation: "insert", accessType: "mutating", allowUnmasked: true },
  { resource: "public.service_audit", catalog: "postgres", engine: "postgres", operation: "select", accessType: "read-only" },
  { resource: "public.service_audit", catalog: "postgres", engine: "postgres", operation: "insert", accessType: "mutating" },
  { resource: "public.service_audit", catalog: "postgres", engine: "postgres", operation: "update", accessType: "mutating" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "SetCatalogSessionProperty", accessType: "mutating" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "ShowCreateTable", accessType: "read-only" },
  { resource: "iceberg.*", catalog: "iceberg", engine: "trino", operation: "ShowFunctions", accessType: "read-only" },
];

export const platformPolicy: PolicyProjection = {
  id: "beluga-platform-policy",
  name: "Beluga Platform Policy",
  version: "0.1.0",
  description: "Fixture-backed policy summary; not a live Keycloak or OPA integration.",
  sourceFile: "packages/domain-api/tests/fixtures/platform-policy.yaml",
  evaluatedAt: "2026-09-28T09:00:00.000Z",
  roles: [
    { name: "analysts", includes: [], permissions: analystPermissions },
    { name: "engineers", includes: ["analysts"], permissions: engineerPermissions },
    { name: "admins", includes: ["engineers"], permissions: [] },
  ],
  groups: [
    { name: "analysts", roles: ["analysts"] },
    { name: "engineers", roles: ["engineers"] },
    { name: "admins", roles: ["admins"] },
  ],
  artefacts: [
    { target: "trino-rego", contentHash: "sha256:fc54100d7325b5f984af683b360d8c30c25fa2526a4efe8e4438e58276370c59", lineCount: 261 },
    { target: "postgres-grant", contentHash: "sha256:63018af9603d2c8528cbbc0f99c9cc4c35540cf4fd7a284f8447a7fb82ca53e2", lineCount: 33 },
    { target: "keycloak-mapper", contentHash: "sha256:0e3073a992535b34f0c65f02668f07cc8fd622c9f882576c515cd8b874699f27", lineCount: 43 },
  ],
};

export const policies: PolicyProjection[] = [platformPolicy];
