-- Flink SQL: Debezium CDC Upsert Mirroring into Iceberg Lakehouse

CREATE TABLE cdc_orders_source (
    order_id INT,
    customer_id INT,
    total_amount DECIMAL(10, 2),
    status STRING,
    updated_at TIMESTAMP(3),
    PRIMARY KEY (order_id) NOT ENFORCED
) WITH (
    'connector' = 'kafka',
    'topic' = 'cdc.shop.orders',
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
SELECT order_id, customer_id, total_amount, status, updated_at
FROM cdc_orders_source;
