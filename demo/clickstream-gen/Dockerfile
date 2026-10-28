# 현행 배포는 차트 13-clickstream-gen.yaml(ConfigMap 방식) — 이 Dockerfile은 레지스트리 도입 시 대안 (빌드: docker build -f demo/clickstream-gen/Dockerfile .)
FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159

WORKDIR /app
COPY demo/clickstream-gen/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY gitops/charts/beluga-data/files/clickstream-producer.py /app/producer.py

CMD ["python", "producer.py"]

