.PHONY: help install install-dev test run package clean

help:
	@echo "make install      - runtime deps"
	@echo "make install-dev  - runtime + pytest"
	@echo "make test         - run pytest"
	@echo "make run          - local server on :18765 (TOKEN=devtoken)"
	@echo "make package      - tarball for deploy (no venv/data)"

install:
	python3 -m pip install -r requirements.txt

install-dev:
	python3 -m pip install -r requirements-dev.txt

test:
	python3 -m pytest -q

run:
	QUADRANT_TOKEN=$${QUADRANT_TOKEN:-devtoken} \
	QUADRANT_DATA_DIR=$${QUADRANT_DATA_DIR:-$(CURDIR)/data} \
	python3 -m uvicorn server.app:app --reload --host 127.0.0.1 --port 18765

package:
	bash scripts/package.sh

clean:
	rm -rf .pytest_cache __pycache__ server/__pycache__ tests/__pycache__
	find . -name '*.pyc' -delete
