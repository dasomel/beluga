-- Flink SQL: Event Sessionization & Window Aggregation to Iceberg

CREATE TABLE kafka_clickstream (
    event_id STRING,
    user_id STRING,
    page STRING,
    action STRING,
    `timestamp` TIMESTAMP(3),
    duration_ms INT,
    WATERMARK FOR `timestamp` AS `timestamp` - INTERVAL '5' SECOND
) WITH (
    'connector' = 'kafka',
    'topic' = 'events.clickstream',
    'properties.bootstrap.servers' = 'beluga-kafka-kafka-bootstrap:9092',
    'properties.group.id' = 'flink-events-group',
    'scan.startup.mode' = 'earliest-offset',
    'format' = 'json'
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

CREATE TABLE IF NOT EXISTS lakekeeper.lake.events_enriched (
    user_id STRING,
    window_start TIMESTAMP(3),
    window_end TIMESTAMP(3),
    event_count BIGINT,
    total_duration_ms BIGINT,
    PRIMARY KEY (user_id, window_start) NOT ENFORCED
) WITH (
    'format-version' = '2'
);

INSERT INTO lakekeeper.lake.events_enriched
SELECT
    user_id,
    TUMBLE_START(`timestamp`, INTERVAL '1' MINUTE) AS window_start,
    TUMBLE_END(`timestamp`, INTERVAL '1' MINUTE) AS window_end,
    COUNT(event_id) AS event_count,
    SUM(duration_ms) AS total_duration_ms
FROM kafka_clickstream
GROUP BY
    user_id,
    TUMBLE(`timestamp`, INTERVAL '1' MINUTE);
