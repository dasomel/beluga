import type { HealthStatus, ListMeta, ListWarning } from '@beluga-manager/domain-api/schema';

export interface ListEnvelope<T> {
  data: T[];
  meta: ListMeta;
  warnings?: ListWarning[];
}

// packages/domain-api/src/routes/health.ts가 정의하는 DomainApiHealth 응답 모양이다.
// 그 타입은 route 전용이라 schema/index.ts의 공개 ./schema export에는 포함되지 않으므로,
// 공유되는 HealthStatus만 재사용하고 이 최소 봉투는 여기서 직접 선언한다.
export interface DomainApiHealthResponse {
  status: HealthStatus;
  version: string;
  // D-MDEV-2: absent on older API builds, so every field is optional for the UI.
  components?: {
    flink?: 'stub' | 'live';
    trinoQueryHistory?: 'disabled' | 'live';
    lakekeeper?: 'stub' | 'live';
  };
}

export type {
  SsoEndpointMode,
  SsoEndpoint,
  SsoConfig,
  SsoSource,
  SsoConfiguredResponse,
  SsoNotConfiguredResponse,
  SsoResponse,
} from '@beluga-manager/domain-api/schema';

// ADR-0009 rollout 4 contract (spec-m4-contract.md "API additions"). The schema package does not export
// these shapes, so they are mirrored here; the server stays the authority on what is valid.
export type SsoChangeStage =
  | 'submitted'
  | 'pr_open'
  | 'unknown_recovering'
  | 'merged'
  | 'applied'
  | 'rejected'
  | 'failed';

export interface SsoChangeRecord {
  id: string;
  stage: SsoChangeStage;
  endpoint: string;
  patch: { allowedGroups: string[] };
  baseBlobSha: string;
  sourceCommitSha: string;
  branch: string;
  pr: { number: number; url: string } | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  diff?: string;
}

export interface SsoChangePreview {
  endpoint: string;
  patch: { allowedGroups: string[] };
  before: string[] | null;
  after: string[];
  baseBlobSha: string;
  sourceCommitSha: string;
  diff: string;
}

export interface SsoChangeContract {
  editableEndpoints: string[];
  field: 'allowedGroups';
  requiredGroups: string[];
  availableGroups: string[];
  current: Record<string, string[] | null>;
  sourceCommitSha: string;
  baseBlobSha: string;
  gitWriterConfigured: boolean;
}

export interface SsoChangeDraft {
  endpoint: string;
  allowedGroups: string[];
  reason?: string;
}
