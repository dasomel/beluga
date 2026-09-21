export interface ServiceItem {
  id: string;
  name: string;
  category: 'Query' | 'Ingestion' | 'Processing' | 'Storage' | 'Lakehouse' | 'Orchestration' | 'BI & Visualization' | 'Governance' | 'Identity & Gateway' | 'GitOps';
  version: string;
  status: 'healthy' | 'degraded' | 'stopped';
  endpoint: string;
  externalUrl?: string;
  description: string;
  capabilities: string[];
}

export interface PipelineStep {
  id: string;
  name: string;
  component: string;
  type: 'Source' | 'Ingest' | 'Stream' | 'Lakehouse' | 'Query';
  status: 'healthy' | 'degraded' | 'running';
  metrics: {
    throughput: string;
    latency: string;
    recordsProcessed: string;
  };
  details: string;
}

export interface CatalogTable {
  catalog: string;
  schema: string;
  table: string;
  format: string;
  location: string;
  columns: { name: string; type: string; comment?: string; isPartition?: boolean }[];
  snapshotCount: number;
}

export const servicesData: ServiceItem[] = [
  {
    id: 'trino',
    name: 'Trino',
    category: 'Query',
    version: '483',
    status: 'healthy',
    endpoint: 'http://trino.local.beluga.internal',
    externalUrl: 'http://trino.local.beluga.internal',
    description: '분산 SQL 쿼리 엔진 — Iceberg 오픈 레이크하우스 초고속 분석',
    capabilities: ['Distributed SQL', 'Iceberg Connector', 'OAuth2 OIDC Auth', 'OPA Authz'],
  },
  {
    id: 'lakekeeper',
    name: 'Lakekeeper',
    category: 'Lakehouse',
    version: '0.13.1',
    status: 'healthy',
    endpoint: 'http://catalog.local.beluga.internal',
    externalUrl: 'http://catalog.local.beluga.internal',
    description: 'Apache Iceberg REST Catalog 관리 서비스 및 자격 증명 제어',
    capabilities: ['Iceberg REST Protocol', 'Warehouse Management', 'S3 Credential Vending'],
  },
  {
    id: 'seaweedfs',
    name: 'SeaweedFS S3',
    category: 'Storage',
    version: '3.81',
    status: 'healthy',
    endpoint: 'http://s3.local.beluga.internal',
    externalUrl: 'http://s3.local.beluga.internal',
    description: '고성능 분산 객체 스토리지 — Iceberg Parquet 데이터 및 로그 저장',
    capabilities: ['S3 Compatible API', 'Distributed Blob Store', 'Multi-tenant Buckets'],
  },
  {
    id: 'kafka',
    name: 'Apache Kafka',
    category: 'Ingestion',
    version: '4.3.0 (Strimzi 1.1.0)',
    status: 'healthy',
    endpoint: 'kafka-cluster-kafka-bootstrap.streaming.svc:9092',
    description: '분산 이벤트 스트리밍 플랫폼 — CDC 토픽 및 실시간 이벤트 버스',
    capabilities: ['Event Streaming', 'Strimzi Operator', 'TLS Encryption', 'NodePort 9094'],
  },
  {
    id: 'flink',
    name: 'Apache Flink',
    category: 'Processing',
    version: '1.20.0',
    status: 'healthy',
    endpoint: 'http://flink.local.beluga.internal',
    externalUrl: 'http://flink.local.beluga.internal',
    description: '상태 기반 실시간 분산 스트림 처리 엔진 — CDC 미러링 및 세션화',
    capabilities: ['Event Time Processing', 'Iceberg Sink', 'Flink SQL', 'Savepoints'],
  },
  {
    id: 'airflow',
    name: 'Apache Airflow',
    category: 'Orchestration',
    version: '2.11.0',
    status: 'healthy',
    endpoint: 'http://airflow.local.beluga.internal',
    externalUrl: 'http://airflow.local.beluga.internal',
    description: '프로그래밍 방식 데이터 파이프라인 스케줄링 및 배치 워크플로우',
    capabilities: ['DAG Workflow', 'Trino Operator', 'Keycloak SSO', 'Celery Executor'],
  },
  {
    id: 'superset',
    name: 'Apache Superset',
    category: 'BI & Visualization',
    version: '6.1.0',
    status: 'healthy',
    endpoint: 'http://superset.local.beluga.internal',
    externalUrl: 'http://superset.local.beluga.internal',
    description: '현대적 비즈니스 인텔리전스 및 데이터 시각화 웹 애플리케이션',
    capabilities: ['Interactive Dashboards', 'SQL Lab', 'Trino Query Engine', 'Role-based Access'],
  },
  {
    id: 'openmetadata',
    name: 'OpenMetadata',
    category: 'Governance',
    version: '1.6.4',
    status: 'healthy',
    endpoint: 'http://metadata.local.beluga.internal',
    externalUrl: 'http://metadata.local.beluga.internal',
    description: '통합 데이터 카탈로그, 데이터 거버넌스, 리니지 및 품질 관리',
    capabilities: ['Data Discovery', 'Automated Lineage', 'OpenSearch Backend', 'Schema Profiling'],
  },
  {
    id: 'keycloak',
    name: 'Keycloak SSO',
    category: 'Identity & Gateway',
    version: '26.7.1',
    status: 'healthy',
    endpoint: 'http://sso.local.beluga.internal',
    externalUrl: 'http://sso.local.beluga.internal',
    description: '플랫폼 전역 중앙 Identity Provider (IdP) 및 OIDC 토큰 발급기',
    capabilities: ['OIDC / OAuth 2.0', 'OpenLDAP Federation', 'Role & Group Mappers', 'Single Sign-On'],
  },
  {
    id: 'apisix',
    name: 'Apache APISIX',
    category: 'Identity & Gateway',
    version: '3.17.0',
    status: 'healthy',
    endpoint: 'http://192.168.77.200:80',
    description: '고성능 클라우드 네이티브 API 게이트웨이 및 트래픽 라우터',
    capabilities: ['Unified Port 80/443', 'SSL Termination', 'OIDC Token Relay', 'etcd Backend'],
  },
  {
    id: 'argocd',
    name: 'ArgoCD',
    category: 'GitOps',
    version: '3.5.0',
    status: 'healthy',
    endpoint: 'http://argocd.local.beluga.internal',
    externalUrl: 'http://argocd.local.beluga.internal',
    description: '선언적 GitOps 기반 쿠버네티스 애플리케이션 동기화 컨트롤러',
    capabilities: ['App-of-Apps Pattern', 'Auto-Sync & Self-Heal', 'Git Revision Tracking'],
  },
  {
    id: 'cnpg',
    name: 'CloudNativePG (PostgreSQL)',
    category: 'Storage',
    version: '1.30.0 (PG 17)',
    status: 'healthy',
    endpoint: 'beluga-pg-rw.storage.svc:5432',
    description: '고가용성 엔터프라이즈 PostgreSQL 클러스터 (Shop OLTP + 메타스토어)',
    capabilities: ['Logical Replication (CDC)', 'Automated Failover', 'WAL Archiving'],
  },
];

export const pipelineSteps: PipelineStep[] = [
  {
    id: 'step-1',
    name: 'PostgreSQL shop DB',
    component: 'CloudNativePG',
    type: 'Source',
    status: 'healthy',
    metrics: {
      throughput: '1,240 tx/s',
      latency: '0.8 ms',
      recordsProcessed: '154,200',
    },
    details: 'WAL level logical 복제 활성화 (shop.orders, shop.customers 테이블)',
  },
  {
    id: 'step-2',
    name: 'Debezium CDC Connector',
    component: 'Kafka Connect',
    type: 'Ingest',
    status: 'healthy',
    metrics: {
      throughput: '1,240 msg/s',
      latency: '4.2 ms',
      recordsProcessed: '154,200',
    },
    details: 'filtered 모드로 shop 변경 이벤트를 shop.orders 토픽으로 캡처',
  },
  {
    id: 'step-3',
    name: 'Kafka Event Bus',
    component: 'Apache Kafka',
    type: 'Ingest',
    status: 'healthy',
    metrics: {
      throughput: '1.4 MB/s',
      latency: '1.2 ms',
      recordsProcessed: '154,200',
    },
    details: 'shop.orders, shop.customers 토픽 보존 및 파티션 분산',
  },
  {
    id: 'step-4',
    name: 'Flink CDC Mirroring Job',
    component: 'Apache Flink',
    type: 'Stream',
    status: 'running',
    metrics: {
      throughput: '1,240 ops/s',
      latency: '12.4 ms',
      recordsProcessed: '154,200',
    },
    details: 'beluga-cdc_orders 잡: JSON 파싱 및 Iceberg Catalog 싱크 쓰기',
  },
  {
    id: 'step-5',
    name: 'Lakekeeper Iceberg REST',
    component: 'Lakekeeper',
    type: 'Lakehouse',
    status: 'healthy',
    metrics: {
      throughput: '12 snapshots/m',
      latency: '8.1 ms',
      recordsProcessed: '3 tables',
    },
    details: 'SeaweedFS S3에 저장된 Iceberg v2 Parquet 메타데이터 카탈로그 관리',
  },
  {
    id: 'step-6',
    name: 'Trino Serving Engine',
    component: 'Trino',
    type: 'Query',
    status: 'healthy',
    metrics: {
      throughput: '42 queries/m',
      latency: '45 ms avg',
      recordsProcessed: 'All',
    },
    details: 'beluga_lake.default.orders 실시간 OLAP 쿼리 및 OPA 인가 제어',
  },
];

export const catalogTablesData: CatalogTable[] = [
  {
    catalog: 'beluga_lake',
    schema: 'default',
    table: 'orders',
    format: 'Iceberg v2 (Parquet)',
    location: 's3://beluga-lake/warehouse/default/orders',
    snapshotCount: 84,
    columns: [
      { name: 'order_id', type: 'BIGINT', comment: '주문 고유 식별자 (PK)' },
      { name: 'customer_id', type: 'BIGINT', comment: '고객 식별자' },
      { name: 'order_status', type: 'VARCHAR', comment: '주문 상태 (COMPLETED, PENDING, CANCELLED)' },
      { name: 'total_amount', type: 'DECIMAL(12, 2)', comment: '총 주문 결제 금액' },
      { name: 'order_date', type: 'DATE', isPartition: true, comment: '주문 일자 (파티션 키)' },
      { name: 'created_at', type: 'TIMESTAMP(6) WITH TIME ZONE', comment: '레코드 생성 시각' },
      { name: 'updated_at', type: 'TIMESTAMP(6) WITH TIME ZONE', comment: '레코드 최종 변경 시각' },
    ],
  },
  {
    catalog: 'beluga_lake',
    schema: 'default',
    table: 'customers',
    format: 'Iceberg v2 (Parquet)',
    location: 's3://beluga-lake/warehouse/default/customers',
    snapshotCount: 42,
    columns: [
      { name: 'customer_id', type: 'BIGINT', comment: '고객 고유 식별자 (PK)' },
      { name: 'email', type: 'VARCHAR', comment: '고객 이메일 주소 (PII Masking 대상)' },
      { name: 'name', type: 'VARCHAR', comment: '고객 실명' },
      { name: 'grade', type: 'VARCHAR', comment: '회원 등급 (VIP, GOLD, REGULAR)' },
      { name: 'registered_date', type: 'DATE', isPartition: true, comment: '가입 일자' },
    ],
  },
  {
    catalog: 'beluga_lake',
    schema: 'default',
    table: 'events_enriched',
    format: 'Iceberg v2 (Parquet)',
    location: 's3://beluga-lake/warehouse/default/events_enriched',
    snapshotCount: 120,
    columns: [
      { name: 'event_id', type: 'VARCHAR', comment: '이벤트 고유 UUID' },
      { name: 'session_id', type: 'VARCHAR', comment: 'Flink 세션화 윈도우 ID' },
      { name: 'user_id', type: 'BIGINT', comment: '방문자 식별자' },
      { name: 'event_type', type: 'VARCHAR', comment: '이벤트 유형 (PAGE_VIEW, CLICK, CART, BUY)' },
      { name: 'event_time', type: 'TIMESTAMP(6) WITH TIME ZONE', isPartition: true, comment: '이벤트 발생 시각' },
    ],
  },
];
