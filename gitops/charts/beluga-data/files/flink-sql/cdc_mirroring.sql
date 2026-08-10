-- Iceberg 싱크는 체크포인트 시점에만 커밋 — 클러스터 기본값과 무관하게 잡 단위로 강제
SET 'execution.checkpointing.interval' = '30s';

-- Flink SQL: Debezium CDC Upsert Mirroring into Iceberg Lakehouse

-- Debezium 원문 타입 주의: DECIMAL은 string 모드(커넥터 설정), timestamptz는 ISO+Z 문자열
-- → 소스는 STRING으로 받고 INSERT에서 CAST (역직렬화 실패 실측 대응)
CREATE TABLE cdc_orders_source (
    order_id INT,
    customer_id INT,
    total_amount STRING,
    status STRING,
    updated_at STRING,
    PRIMARY KEY (order_id) NOT ENFORCED
) WITH (
    'connector' = 'kafka',
    'topic' = 'cdc.shop.public.orders',
    'properties.bootstrap.servers' = 'beluga-kafka-kafka-bootstrap:9092',
    'properties.group.id' = 'flink-cdc-orders-group',
    'scan.startup.mode' = 'earliest-offset',
    'format' = 'debezium-json'
);

CREATE CATALOG lakekeeper WITH (
    'type' = 'iceberg',
    'catalog-type' = 'rest',
    'uri' = 'http://lakekeeper:8181/catalog',
    'warehouse' = 'lake',
    's3.endpoint' = 'http://seaweedfs-s3:8333',
    's3.path-style-access' = 'true',
    's3.access-key-id' = 'any',
    's3.secret-access-key' = 'any',
    'io-impl' = 'org.apache.iceberg.aws.s3.S3FileIO'
);

-- Iceberg 네임스페이스 선생성 (없으면 CREATE TABLE이 NoSuchNamespace로 실패 — E2E 실측)
CREATE DATABASE IF NOT EXISTS lakekeeper.lake;

CREATE TABLE IF NOT EXISTS lakekeeper.lake.orders (
    order_id INT,
    customer_id INT,
    total_amount DECIMAL(10, 2),
    status STRING,
    updated_at TIMESTAMP(3),
    PRIMARY KEY (order_id) NOT ENFORCED
) WITH (
    'format-version' = '2'
);

INSERT INTO lakekeeper.lake.orders
SELECT
    order_id,
    customer_id,
    CAST(total_amount AS DECIMAL(10, 2)),
    status,
    CAST(REPLACE(REPLACE(updated_at, 'T', ' '), 'Z', '') AS TIMESTAMP(3))
FROM cdc_orders_source;
