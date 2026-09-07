# Beluga Data Platform Makefile

.PHONY: up down status test lint validate clean help

help:
	@echo "Beluga Data Platform Helper Targets:"
	@echo "  make up       - Host RAM 감지 후 전체 클러스터 기동 및 GitOps 배포"
	@echo "  make down     - Vagrant VM 전체 삭제"
	@echo "  make status   - VM 및 K8s 클러스터 파드 상태 확인"
	@echo "  make test     - tests/ 전체 검증 스크립트 실행 (라이브 클러스터 필요)"
	@echo "  make lint     - shellcheck 및 helm lint 검증"
	@echo "  make validate - helm template 렌더 + YAML 문법 검증 (클러스터 불필요, CI용)"
	@echo "  make clean    - 임시 파일 및 Kubeconfig 캐시 삭제"

up:
	bash scripts/up.sh

down:
	vagrant destroy -f

status:
	vagrant status
	@if [ -f .kube/config ]; then \
		KUBECONFIG=.kube/config kubectl get nodes -o wide; \
		KUBECONFIG=.kube/config kubectl get pods -A; \
	fi

test:
	bash tests/run-all.sh

lint:
	@echo "Running shellcheck..."
	find scripts/ tests/ demo/ -name "*.sh" -exec shellcheck {} +
	@echo "Running helm lint..."
	helm lint gitops/charts/beluga-platform
	helm lint gitops/charts/beluga-data

# 클러스터 없이 도는 정적 검증 (CI용) — "렌더 통과"만 증명하고 런타임 동작은
# 증명하지 않는다 (docs/development.md 검증 레벨 구분 참고).
validate:
	@echo "Rendering beluga-platform chart..."
	helm template gitops/charts/beluga-platform > /dev/null
	@echo "Rendering beluga-data chart..."
	helm template gitops/charts/beluga-data > /dev/null
	@echo "Validating YAML syntax (policies/, gitops/apps/)..."
	python3 scripts/ci/validate-yaml.py policies gitops/apps

clean:
	rm -rf .kube/
