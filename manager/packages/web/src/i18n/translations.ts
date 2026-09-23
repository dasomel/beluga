export type Locale = 'ko-KR' | 'en-US';

export interface Translations {
  appName: string;
  tagline: string;
  nav: {
    overview: string;
    services: string;
    pipelines: string;
    architecture: string;
    operations: string;
    dataCatalog: string;
    query: string;
    policy: string;
  };
  overview: {
    title: string;
    subtitle: string;
    totalServices: string;
    activePipelines: string;
    catalogTables: string;
    clusterHealth: string;
    quickLaunch: string;
    pipelineFlow: string;
    recentEvents: string;
    systemAlerts: string;
  };
  services: {
    title: string;
    subtitle: string;
    searchPlaceholder: string;
    emptyState: string;
    filterAll: string;
    columns: {
      name: string;
      category: string;
      status: string;
      version: string;
      endpoint: string;
      actions: string;
    };
    openUi: string;
    statusHealthy: string;
    statusDegraded: string;
    statusStopped: string;
  };
  pipelines: {
    title: string;
    subtitle: string;
    topologyTitle: string;
    source: string;
    ingest: string;
    processing: string;
    lakehouse: string;
    queryServing: string;
    jobState: string;
    throughput: string;
    recordsSec: string;
    stagesLabel: string;
    correlationLabel: string;
    confidenceLabel: string;
    lastUpdatedLabel: string;
    noStageDetail: string;
    notFound: string;
  };
  architecture: {
    title: string;
    subtitle: string;
    dataPipelineTopology: string;
    infrastructureTopology: string;
    comingSoon: string;
    infrastructureHint: string;
    clickNodeHint: string;
    stageDetailTitle: string;
    serviceIdLabel: string;
    detailLabel: string;
    closeLabel: string;
  };
  operations: {
    title: string;
    subtitle: string;
    eventsTab: string;
    resourcesTab: string;
    logsTab: string;
    comingSoon: string;
    resourcesHint: string;
    logsHint: string;
    deepLinkNote: string;
    emptyState: string;
    relatedServiceLabel: string;
    relatedPipelineLabel: string;
  };
  catalog: {
    title: string;
    subtitle: string;
    catalogs: string;
    schemas: string;
    tables: string;
    columns: string;
    sampleQuery: string;
    format: string;
    location: string;
    type: string;
  };
  query: {
    title: string;
    subtitle: string;
    editorLabel: string;
    runQuery: string;
    results: string;
    executionTime: string;
    rowCount: string;
    presetQueries: string;
  };
  policy: {
    title: string;
    subtitle: string;
    rolesTab: string;
    catalogsTab: string;
    resourcesTab: string;
    compiledRego: string;
    compiledSql: string;
    identitySource: string;
  };
  // ADR-0003: healthy/degraded/stale/unknown/unavailable 상태 어휘를 하나로 정의하고,
  // 색상 하나에만 의존하지 않도록 항상 라벨과 함께 쓴다(components/StatusBadge.tsx).
  status: {
    healthy: string;
    degraded: string;
    stale: string;
    unknown: string;
    unavailable: string;
  };
  // ADR-0003과 동일한 원칙(색상 단독 금지, 아이콘+라벨 병행)을 severity 어휘에도 적용한다 --
  // health status(5-value)와는 다른 별개의 어휘이므로 여기서 독립적으로 정의한다
  // (components/SeverityBadge.tsx).
  severity: {
    info: string;
    warning: string;
    error: string;
  };
  common: {
    status: string;
    healthy: string;
    degraded: string;
    running: string;
    ready: string;
    version: string;
    endpoint: string;
    refresh: string;
    language: string;
    openInNewTab: string;
    theme: string;
    lightMode: string;
    darkMode: string;
    figmaSpec: string;
    figmaConnected: string;
    loading: string;
    loadError: string;
    warningsCount: string;
  };
}

export const translations: Record<Locale, Translations> = {
  'ko-KR': {
    appName: 'Beluga Manager',
    tagline: '통합 현대적 데이터 플랫폼 컨트롤 플레인',
    nav: {
      overview: '플랫폼 개요',
      services: '서비스 카탈로그',
      pipelines: '파이프라인 토폴로지',
      architecture: '아키텍처',
      operations: '운영 이벤트',
      dataCatalog: '데이터 자산',
      query: '쿼리 워크스페이스',
      policy: '보안 & 정책',
    },
    overview: {
      title: '플랫폼 운영 개요',
      subtitle: 'Beluga Modern Data Platform의 통합 인프라 및 실시간 상태',
      totalServices: '등록된 플랫폼 서비스',
      activePipelines: '활성 데이터 파이프라인',
      catalogTables: 'Iceberg 관리 테이블',
      clusterHealth: 'Domain API 상태',
      quickLaunch: '원천 OSS 콘솔 바로가기',
      pipelineFlow: '파이프라인 현황',
      recentEvents: '최근 플랫폼 이벤트',
      systemAlerts: '시스템 알림',
    },
    services: {
      title: '서비스 카탈로그',
      subtitle: 'APISIX 게이트웨이 및 Kubernetes에 프로비저닝된 인프라 서비스',
      searchPlaceholder: '서비스 이름, 능력, 태그 검색...',
      emptyState: '검색 조건에 맞는 서비스가 없습니다',
      filterAll: '전체 보기',
      columns: {
        name: '서비스명',
        category: '역할 / 범주',
        status: '상태',
        version: '버전',
        endpoint: '내부 엔드포인트',
        actions: '작업',
      },
      openUi: '콘솔 열기',
      statusHealthy: '정상 작동',
      statusDegraded: '일부 지연',
      statusStopped: '중지됨',
    },
    pipelines: {
      title: '파이프라인 & 토폴로지',
      subtitle: 'CDC 수집부터 Iceberg 테이블 적재, Trino 서빙까지의 상호연관 흐름',
      topologyTitle: '파이프라인 상관관계 토폴로지',
      source: '원천 트랜잭션 DB (PostgreSQL)',
      ingest: 'CDC 스트리밍 (Debezium + Kafka)',
      processing: '실시간 스트림 처리 (Apache Flink)',
      lakehouse: '오픈 레이크하우스 (Lakekeeper / Iceberg)',
      queryServing: '분산 쿼리 엔진 (Trino)',
      jobState: '작업 상태',
      throughput: '처리량',
      recordsSec: '레코드/초',
      stagesLabel: '스테이지',
      correlationLabel: '상관관계',
      confidenceLabel: '신뢰도',
      lastUpdatedLabel: '최종 갱신',
      noStageDetail: '이상 없음',
      notFound: '참조된 파이프라인을 현재 목록에서 찾을 수 없습니다',
    },
    architecture: {
      title: '아키텍처 토폴로지',
      subtitle: '데이터 파이프라인 관점과 인프라 관점을 명확히 구분하여 시각화합니다',
      dataPipelineTopology: '데이터 파이프라인 토폴로지',
      infrastructureTopology: '인프라 토폴로지',
      comingSoon: '준비 중',
      infrastructureHint: 'Kubernetes 네임스페이스/워크로드/서비스/스토리지 관계 표현에는 domain-api 스키마 확장이 필요합니다',
      clickNodeHint: '노드를 클릭하면 상세 정보와 drill-down을 확인할 수 있습니다',
      stageDetailTitle: '스테이지 상세',
      serviceIdLabel: '서비스 ID',
      detailLabel: '상세 메시지',
      closeLabel: '닫기',
    },
    operations: {
      title: '운영 이벤트',
      subtitle: 'Kubernetes 리소스, 이벤트 타임라인, 로그 탐색을 아우르는 운영 경험 (MVP 범위: 이벤트 타임라인)',
      eventsTab: '이벤트 타임라인',
      resourcesTab: '리소스 (K8s)',
      logsTab: '로그',
      comingSoon: '준비 중',
      resourcesHint: 'Namespace/Workload/Pod/Service/Endpoint/PVC 등 Kubernetes 리소스 표현에는 domain-api 스키마 확장이 필요합니다',
      logsHint: '기존 관측(Observability) 백엔드(Loki 등)로 연결하는 탐색 UX가 될 예정입니다 -- Manager가 별도 로그 저장소를 만들지 않습니다',
      deepLinkNote: '관련 참조를 선택하면 서비스는 ID로 검색하고 파이프라인은 해당 항목을 선택한 화면으로 이동합니다',
      emptyState: '표시할 이벤트가 없습니다',
      relatedServiceLabel: '관련 서비스',
      relatedPipelineLabel: '관련 파이프라인',
    },
    catalog: {
      title: '데이터 카탈로그 & 자산',
      subtitle: 'Lakekeeper 및 Trino 기반의 카탈로그, 스키마, 파티션 메타데이터',
      catalogs: '카탈로그',
      schemas: '스키마',
      tables: '테이블 목록',
      columns: '컬럼 구조',
      sampleQuery: '샘플 쿼리',
      format: '스토리지 포맷',
      location: 'S3 버킷 경로',
      type: '타입',
    },
    query: {
      title: '쿼리 워크스페이스',
      subtitle: 'Trino 분산 엔진을 통한 실시간 Lakehouse 및 스트리밍 데이터 탐색',
      editorLabel: 'SQL 에디터',
      runQuery: '쿼리 실행 (Run)',
      results: '실행 결과',
      executionTime: '소요 시간',
      rowCount: '반환 행수',
      presetQueries: '자주 쓰는 쿼리 프리셋',
    },
    policy: {
      title: '보안 & 정책 컴파일러',
      subtitle: 'YAML 정책 선언 및 Keycloak, Trino OPA Rego, PostgreSQL GRANT 매핑',
      rolesTab: '플랫폼 역할 (Roles)',
      catalogsTab: '카탈로그 권한',
      resourcesTab: '리소스 정책',
      compiledRego: '컴파일된 OPA Rego (trino.rego)',
      compiledSql: '컴파일된 PostgreSQL 권한 (db-roles.sql)',
      identitySource: '단일 인증 원천: Keycloak SSO + OpenLDAP',
    },
    status: {
      healthy: '정상',
      degraded: '저하됨',
      stale: '오래됨',
      unknown: '알 수 없음',
      unavailable: '사용 불가',
    },
    severity: {
      info: '정보',
      warning: '경고',
      error: '오류',
    },
    common: {
      status: '상태',
      healthy: '정상 (Healthy)',
      degraded: '주의 (Degraded)',
      running: '실행 중 (Running)',
      ready: '준비됨 (Ready)',
      version: '버전',
      endpoint: '엔드포인트',
      refresh: '새로고침',
      language: '언어',
      openInNewTab: '새 탭에서 열기',
      theme: '테마',
      lightMode: '화이트 모드 (기본)',
      darkMode: '다크 모드',
      figmaSpec: 'Figma 디자인 시스템',
      figmaConnected: 'Figma DS 연동됨',
      loading: '불러오는 중...',
      loadError: '데이터를 불러오지 못했습니다',
      warningsCount: '건의 경고',
    },
  },
  'en-US': {
    appName: 'Beluga Manager',
    tagline: 'Unified Modern Data Platform Control Plane',
    nav: {
      overview: 'Platform Overview',
      services: 'Services Catalog',
      pipelines: 'Pipeline Topology',
      architecture: 'Architecture',
      operations: 'Operations',
      dataCatalog: 'Data Assets',
      query: 'Query Workspace',
      policy: 'Security & Policy',
    },
    overview: {
      title: 'Platform Operations Overview',
      subtitle: 'Unified infrastructure and live state of Beluga Modern Data Platform',
      totalServices: 'Registered Services',
      activePipelines: 'Active Data Pipelines',
      catalogTables: 'Iceberg Tables',
      clusterHealth: 'Domain API Health',
      quickLaunch: 'Upstream OSS Consoles',
      pipelineFlow: 'Pipelines Snapshot',
      recentEvents: 'Recent Platform Events',
      systemAlerts: 'System Alerts',
    },
    services: {
      title: 'Services Catalog',
      subtitle: 'Infrastructure services provisioned behind APISIX Gateway on Kubernetes',
      searchPlaceholder: 'Search service name, capabilities, tags...',
      emptyState: 'No services match the current filters',
      filterAll: 'All Categories',
      columns: {
        name: 'Service Name',
        category: 'Category / Role',
        status: 'Status',
        version: 'Version',
        endpoint: 'Internal Endpoint',
        actions: 'Actions',
      },
      openUi: 'Launch UI',
      statusHealthy: 'Healthy',
      statusDegraded: 'Degraded',
      statusStopped: 'Stopped',
    },
    pipelines: {
      title: 'Pipelines & Topology',
      subtitle: 'Correlated data flow from CDC ingest to Iceberg storage and Trino query serving',
      topologyTitle: 'Correlated Pipeline Topology',
      source: 'Source Transactional DB (PostgreSQL)',
      ingest: 'CDC Streaming (Debezium + Kafka)',
      processing: 'Stream Processing (Apache Flink)',
      lakehouse: 'Open Lakehouse (Lakekeeper / Iceberg)',
      queryServing: 'Query Engine (Trino)',
      jobState: 'Job State',
      throughput: 'Throughput',
      recordsSec: 'records/sec',
      stagesLabel: 'Stages',
      correlationLabel: 'Correlation',
      confidenceLabel: 'Confidence',
      lastUpdatedLabel: 'Last updated',
      noStageDetail: 'No issues',
      notFound: 'The referenced pipeline was not found in the current list',
    },
    architecture: {
      title: 'Architecture Topology',
      subtitle: 'Visualizes the platform as two clearly separated topology perspectives',
      dataPipelineTopology: 'Data Pipeline Topology',
      infrastructureTopology: 'Infrastructure Topology',
      comingSoon: 'Coming soon',
      infrastructureHint: 'Requires new domain-api schema for Kubernetes namespace/workload/service/storage relationships',
      clickNodeHint: 'Click a node to view its details and drill down',
      stageDetailTitle: 'Stage Detail',
      serviceIdLabel: 'Service ID',
      detailLabel: 'Detail',
      closeLabel: 'Close',
    },
    operations: {
      title: 'Operations',
      subtitle: 'Operational experience spanning Kubernetes resources, event timeline, and log drill-down (MVP scope: event timeline)',
      eventsTab: 'Event Timeline',
      resourcesTab: 'Resources (K8s)',
      logsTab: 'Logs',
      comingSoon: 'Coming soon',
      resourcesHint: 'Requires a domain-api schema extension for Kubernetes Namespace/Workload/Pod/Service/Endpoint/PVC resources',
      logsHint: 'Will link out to the existing observability backend (e.g. Loki) -- Manager does not host its own log store',
      deepLinkNote: 'Select a related reference to search Services by ID or open Pipelines with that item selected',
      emptyState: 'No events to display',
      relatedServiceLabel: 'Related service',
      relatedPipelineLabel: 'Related pipeline',
    },
    catalog: {
      title: 'Data Catalog & Assets',
      subtitle: 'Catalog, schema, and partition metadata backed by Lakekeeper and Trino',
      catalogs: 'Catalogs',
      schemas: 'Schemas',
      tables: 'Tables',
      columns: 'Columns Schema',
      sampleQuery: 'Sample Query',
      format: 'Storage Format',
      location: 'S3 Location',
      type: 'Data Type',
    },
    query: {
      title: 'Query Workspace',
      subtitle: 'Interactive Lakehouse exploration powered by Trino distributed query engine',
      editorLabel: 'SQL Editor',
      runQuery: 'Run Query',
      results: 'Execution Results',
      executionTime: 'Elapsed Time',
      rowCount: 'Rows Returned',
      presetQueries: 'Preset Queries',
    },
    policy: {
      title: 'Security & Policy Compiler',
      subtitle: 'Declarative YAML policies compiled to Keycloak, Trino OPA Rego, and Postgres GRANTs',
      rolesTab: 'Platform Roles',
      catalogsTab: 'Catalog Policies',
      resourcesTab: 'Resource Policies',
      compiledRego: 'Compiled OPA Rego (trino.rego)',
      compiledSql: 'Compiled Postgres DDL (db-roles.sql)',
      identitySource: 'Single Identity Source: Keycloak SSO + OpenLDAP',
    },
    status: {
      healthy: 'Healthy',
      degraded: 'Degraded',
      stale: 'Stale',
      unknown: 'Unknown',
      unavailable: 'Unavailable',
    },
    severity: {
      info: 'Info',
      warning: 'Warning',
      error: 'Error',
    },
    common: {
      status: 'Status',
      healthy: 'Healthy',
      degraded: 'Degraded',
      running: 'Running',
      ready: 'Ready',
      version: 'Version',
      endpoint: 'Endpoint',
      refresh: 'Refresh',
      language: 'Language',
      openInNewTab: 'Open in new tab',
      theme: 'Theme',
      lightMode: 'Light (Default)',
      darkMode: 'Dark Mode',
      figmaSpec: 'Figma Design System',
      figmaConnected: 'Figma DS Linked',
      loading: 'Loading...',
      loadError: 'Failed to load data',
      warningsCount: 'warning(s)',
    },
  },
};
