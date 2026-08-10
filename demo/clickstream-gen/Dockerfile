# 현행 배포는 차트 13-clickstream-gen.yaml(ConfigMap 방식) — 이 Dockerfile은 레지스트리 도입 시 대안
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY producer.py .

CMD ["python", "producer.py"]

