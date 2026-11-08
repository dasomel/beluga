-- Iceberg 싱크는 체크포인트 시점에만 커밋 — 클러스터 기본값과 무관하게 잡 단위로 강제
SET 'execution.checkpointing.interval' = '30s';
-- 이슈 #114: ArgoCD sync 훅은 매번 재실행된다 — 제출 전 사전 체크(jobs/overview)가
-- 이 이름으로 활성 잡을 찾아 재제출을 건너뛰므로, 파일명과 반드시 일치해야 한다.
SET 'pipeline.name' = 'beluga-cdc_customers';

-- Flink SQL: Debezium CDC Upsert Mirroring into Iceberg Lakehouse (customers)
-- §5 ②: customers 미러 (PII — §10 매트릭스의 차단 대상 테이블)

CREATE CATALOG lakekeeper WITH (
    'type' = 'iceberg',
    'catalog-type' = 'rest',
    'uri' = 'http://lakekeeper.lakehouse.svc.cluster.local:8181/catalog',
    'warehouse' = 'lake',
__LK_AUTH_OPTIONS__
    's3.endpoint' = 'http://seaweedfs-s3.storage.svc.cluster.local:8333',
    's3.path-style-access' = 'true',
    's3.access-key-id' = '__FLINK_S3_ACCESS_KEY__',
    's3.secret-access-key' = '__FLINK_S3_SECRET_KEY__',
    'io-impl' = 'org.apache.iceberg.aws.s3.S3FileIO'
);

-- Iceberg 네임스페이스 선생성 (없으면 CREATE TABLE이 NoSuchNamespace로 실패 — E2E 실측)
CREATE DATABASE IF NOT EXISTS lakekeeper.lake;

CREATE TABLE cdc_customers_source (
    customer_id INT,
    name STRING,
    email STRING,
    city STRING,
    created_at STRING,
    PRIMARY KEY (customer_id) NOT ENFORCED
) WITH (
    'connector' = 'kafka',
    'topic' = 'cdc.shop.public.customers',
    'properties.bootstrap.servers' = 'beluga-kafka-kafka-bootstrap:9092',
    'properties.group.id' = 'flink-cdc-customers-group',
    -- #350: 재제출(JM 재시작·sync 훅)마다 처음부터 다시 읽지 않도록 group.id의 커밋 오프셋에서 재개한다.
    -- 오프셋은 체크포인트 완료 시 Kafka 소스가 커밋한다(earliest-offset 모드에서도 이미 커밋됨, 라이브 확인).
    -- 커밋이 없는 신규 클러스터는 auto.offset.reset=earliest로 처음부터 읽는다.
    'scan.startup.mode' = 'group-offsets',
    'properties.auto.offset.reset' = 'earliest',
    'format' = 'debezium-json'
);

CREATE TABLE IF NOT EXISTS lakekeeper.lake.customers (
    customer_id INT,
    name STRING,
    email STRING,
    city STRING,
    created_at TIMESTAMP(3),
    PRIMARY KEY (customer_id) NOT ENFORCED
) WITH (
    'format-version' = '2',
    'write.upsert.enabled' = 'true'
);

INSERT INTO lakekeeper.lake.customers
SELECT
    customer_id, name, email, city,
    CAST(REPLACE(REPLACE(created_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM cdc_customers_source;
