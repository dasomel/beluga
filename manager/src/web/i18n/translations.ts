export type Locale = 'ko-KR' | 'en-US';

export interface Translations {
  appName: string;
  tagline: string;
  nav: {
    overview: string;
    services: string;
    pipelines: string;
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
      clusterHealth: '클러스터 전반 상태',
      quickLaunch: '원천 OSS 콘솔 바로가기',
      pipelineFlow: '종단간 CDC 미러링 흐름',
      recentEvents: '최근 플랫폼 이벤트',
      systemAlerts: '시스템 알림',
    },
    services: {
      title: '서비스 카탈로그',
      subtitle: 'APISIX 게이트웨이 및 Kubernetes에 프로비저닝된 인프라 서비스',
      searchPlaceholder: '서비스 이름, 능력, 태그 검색...',
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
      topologyTitle: 'Shop 주문 데이터 실시간 동기화 파이프라인',
      source: '원천 트랜잭션 DB (PostgreSQL)',
      ingest: 'CDC 스트리밍 (Debezium + Kafka)',
      processing: '실시간 스트림 처리 (Apache Flink)',
      lakehouse: '오픈 레이크하우스 (Lakekeeper / Iceberg)',
      queryServing: '분산 쿼리 엔진 (Trino)',
      jobState: '작업 상태',
      throughput: '처리량',
      recordsSec: '레코드/초',
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
    },
  },
  'en-US': {
    appName: 'Beluga Manager',
    tagline: 'Unified Modern Data Platform Control Plane',
    nav: {
      overview: 'Platform Overview',
      services: 'Services Catalog',
      pipelines: 'Pipeline Topology',
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
      clusterHealth: 'Overall Health',
      quickLaunch: 'Upstream OSS Consoles',
      pipelineFlow: 'End-to-End CDC Mirroring Flow',
      recentEvents: 'Recent Platform Events',
      systemAlerts: 'System Alerts',
    },
    services: {
      title: 'Services Catalog',
      subtitle: 'Infrastructure services provisioned behind APISIX Gateway on Kubernetes',
      searchPlaceholder: 'Search service name, capabilities, tags...',
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
      topologyTitle: 'Shop Orders Real-Time Mirroring Pipeline',
      source: 'Source Transactional DB (PostgreSQL)',
      ingest: 'CDC Streaming (Debezium + Kafka)',
      processing: 'Stream Processing (Apache Flink)',
      lakehouse: 'Open Lakehouse (Lakekeeper / Iceberg)',
      queryServing: 'Query Engine (Trino)',
      jobState: 'Job State',
      throughput: 'Throughput',
      recordsSec: 'records/sec',
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
    },
  },
};
