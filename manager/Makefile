.PHONY: lint test verify audit dev-up dev-down

NODE ?= node
PYTHON ?= python3
# Override with COMPOSE="podman compose" (v2 provider) to use Podman.
COMPOSE ?= docker compose

lint:
	$(PYTHON) -m compileall -q scripts tests

test:
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py'

audit:
	$(NODE) scripts/ci/check-dependency-vulnerabilities.mjs
	$(NODE) scripts/ci/check-license-policy.mjs

verify: lint test
	$(PYTHON) scripts/verify.py

.PHONY: research-check
research-check:
	python3 scripts/research/check-research-evidence.py

dev-up:
	$(COMPOSE) up --build --wait -d

dev-down:
	$(COMPOSE) down --remove-orphans
