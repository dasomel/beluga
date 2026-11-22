# 현행 배포는 차트 13-clickstream-gen.yaml(ConfigMap 방식) — 이 Dockerfile은 레지스트리 도입 시 대안 (빌드: docker build -f demo/clickstream-gen/Dockerfile .)
FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928

WORKDIR /app
COPY demo/clickstream-gen/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY gitops/charts/beluga-data/files/clickstream-producer.py /app/producer.py

CMD ["python", "producer.py"]

