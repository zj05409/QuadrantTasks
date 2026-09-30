.PHONY: help install install-dev test lint run package clean add-user list-users

help:
	@echo "make install      - runtime deps"
	@echo "make install-dev  - runtime + pytest"
	@echo "make test         - run pytest"
	@echo "make run          - local server on :18765 (TOKEN=devtoken)"
	@echo "make lint         - ruff check + format check"
	@echo "make add-user NAME=alice  - create a user in ./data, print its token"
	@echo "make list-users   - list users in ./data"
	@echo "make package      - tarball for deploy (no venv/data)"

install:
	python3 -m pip install -r requirements.txt

install-dev:
	python3 -m pip install -r requirements-dev.txt

test:
	python3 -m pytest -q

lint:
	python3 -m ruff check .
	python3 -m ruff format --check .

run:
	QUADRANT_TOKEN=$${QUADRANT_TOKEN:-devtoken} \
	QUADRANT_DATA_DIR=$${QUADRANT_DATA_DIR:-$(CURDIR)/data} \
	python3 -m uvicorn server.app:app --reload --host 127.0.0.1 --port 18765

add-user:
	@test -n "$(NAME)" || (echo "usage: make add-user NAME=alice" && exit 1)
	QUADRANT_DATA_DIR=$${QUADRANT_DATA_DIR:-$(CURDIR)/data} python3 -m server.admin add $(NAME)

list-users:
	QUADRANT_DATA_DIR=$${QUADRANT_DATA_DIR:-$(CURDIR)/data} python3 -m server.admin list

package:
	bash scripts/package.sh

clean:
	rm -rf .pytest_cache __pycache__ server/__pycache__ tests/__pycache__
	find . -name '*.pyc' -delete
