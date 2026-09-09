.PHONY: lint test verify

PYTHON ?= python3

lint:
	$(PYTHON) -m compileall -q scripts tests

test:
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py'

verify: lint test
	$(PYTHON) scripts/verify.py
