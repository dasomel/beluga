# Beluga Data Platform Makefile

.PHONY: up down status test lint clean help

help:
	@echo "Beluga Data Platform Helper Targets:"
	@echo "  make up       - Host RAM 감지 후 전체 클러스터 기동 및 GitOps 배포"
	@echo "  make down     - Vagrant VM 전체 삭제"
	@echo "  make status   - VM 및 K8s 클러스터 파드 상태 확인"
	@echo "  make test     - tests/ 전체 검증 스크립트 실행"
	@echo "  make lint     - shellcheck 및 helm lint 검증"
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
	helm lint gitops/charts/beluga-platform || true
	helm lint gitops/charts/beluga-data || true

clean:
	rm -rf .kube/
