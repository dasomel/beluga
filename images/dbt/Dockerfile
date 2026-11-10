# D-DBT-5: install reviewed Core/Trino hashes, never the dbt v2 download shim.
# Cost: explicit lock updates; revisit v2 only with OSI-licensed hash-pinnable sources.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

ARG VCS_REF
LABEL org.opencontainers.image.source="https://github.com/dasomel/beluga" \
  org.opencontainers.image.revision="${VCS_REF}" \
  org.opencontainers.image.licenses="Apache-2.0"

COPY images/dbt/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt \
  && useradd --create-home --user-group --uid 10001 dbt \
  && install -d -o dbt -g dbt /opt/beluga/dbt

WORKDIR /opt/beluga/dbt
COPY --chown=dbt:dbt dbt/ /opt/beluga/dbt/
ENV DBT_PROFILES_DIR=/opt/beluga/dbt \
  DBT_TARGET=trino \
  DBT_SEND_ANONYMOUS_USAGE_STATS=False
USER dbt
ENTRYPOINT ["dbt"]
