# D1: Bake the chart's verified connectors once; image builds require Maven access.
# Keep chart adoption separate; rebuild and pin a new index to change these bytes.
FROM flink:1.20.0-scala_2.12-java17@sha256:b46dcc4c70cde81859ef0daa2210a4c2f7bb3f96eb0fee5c9a1229f95176551e

ARG VCS_REF
LABEL org.opencontainers.image.source="https://github.com/dasomel/beluga" \
  org.opencontainers.image.revision="${VCS_REF}" \
  org.opencontainers.image.licenses="Apache-2.0"

USER root
RUN set -eu; \
  curl -fsSL -o /opt/flink/lib/flink-sql-connector-kafka-3.4.0-1.20.jar \
    https://repo1.maven.org/maven2/org/apache/flink/flink-sql-connector-kafka/3.4.0-1.20/flink-sql-connector-kafka-3.4.0-1.20.jar; \
  curl -fsSL -o /opt/flink/lib/iceberg-flink-runtime-1.20-1.7.1.jar \
    https://repo1.maven.org/maven2/org/apache/iceberg/iceberg-flink-runtime-1.20/1.7.1/iceberg-flink-runtime-1.20-1.7.1.jar; \
  curl -fsSL -o /opt/flink/lib/iceberg-aws-bundle-1.7.1.jar \
    https://repo1.maven.org/maven2/org/apache/iceberg/iceberg-aws-bundle/1.7.1/iceberg-aws-bundle-1.7.1.jar; \
  curl -fsSL -o /opt/flink/lib/flink-shaded-hadoop-2-uber-2.8.3-10.0.jar \
    https://repo1.maven.org/maven2/org/apache/flink/flink-shaded-hadoop-2-uber/2.8.3-10.0/flink-shaded-hadoop-2-uber-2.8.3-10.0.jar; \
  printf '%s\n' \
    'b860724fd97d7da0901bfc3859680442f4c1aa2b35ab944407558b393a1cf93e  /opt/flink/lib/flink-sql-connector-kafka-3.4.0-1.20.jar' \
    '4886de53d83bd2c00d4edf1f709e114b895370c18281b30d654b4913d6a7bf2b  /opt/flink/lib/iceberg-flink-runtime-1.20-1.7.1.jar' \
    '5d7c0baf877ee4296c4f98425165484404af4227fb487f1847a3cb1a577dfc3b  /opt/flink/lib/iceberg-aws-bundle-1.7.1.jar' \
    '492b2a559f2a1dad3808b51d9a26a575dbb1202004c9f85f5059c520e0632127  /opt/flink/lib/flink-shaded-hadoop-2-uber-2.8.3-10.0.jar' \
    | sha256sum -c -; \
  chown flink:flink /opt/flink/lib/flink-sql-connector-kafka-3.4.0-1.20.jar /opt/flink/lib/iceberg-flink-runtime-1.20-1.7.1.jar /opt/flink/lib/iceberg-aws-bundle-1.7.1.jar /opt/flink/lib/flink-shaded-hadoop-2-uber-2.8.3-10.0.jar; \
  chmod 0644 /opt/flink/lib/flink-sql-connector-kafka-3.4.0-1.20.jar /opt/flink/lib/iceberg-flink-runtime-1.20-1.7.1.jar /opt/flink/lib/iceberg-aws-bundle-1.7.1.jar /opt/flink/lib/flink-shaded-hadoop-2-uber-2.8.3-10.0.jar

USER flink
