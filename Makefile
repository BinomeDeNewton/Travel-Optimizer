UV ?= uv
NPM ?= npm
API_PORT ?= 8000
YEAR ?= 2025
LEAVE ?= 25
MIN_REST ?= 3
PIPELINE ?= 0
API ?= 1
PIPELINE_JSON ?= outputs/reports/pipeline.json
WEB_PIPELINE_JSON ?= web/public/pipeline.json

.PHONY: help deps bootstrap dev web-dev api-dev pipeline map-data audit clean celery-worker

help:
	@printf "%s\n" \
		"Targets:" \
		"  deps          Install Python (uv sync) + Web (npm install)" \
		"  bootstrap     deps + map-data" \
		"  dev           Start API + UI (no install)" \
		"  api-dev       Start FastAPI on port $(API_PORT)" \
		"  web-dev       Start Vite dev server" \
		"  pipeline      Run optimizer pipeline" \
		"  map-data      Regenerate map data" \
		"  audit         Run npm audit + uv pip check" \
		"  clean         Remove venv, node_modules, caches, outputs" \
		"  celery-worker Start Celery worker"

deps:
	$(UV) sync
	cd web && $(NPM) install

bootstrap: deps map-data

web-dev:
	cd web && $(NPM) run dev

api-dev:
	$(UV) run uvicorn travel_optimizer.api.app:app --reload --port $(API_PORT)

celery-worker:
	$(UV) run celery -A travel_optimizer.api.celery_app worker --loglevel=info

pipeline:
	$(UV) run travel-optimizer --year $(YEAR) --leave $(LEAVE) --min-rest $(MIN_REST)

dev:
	$(MAKE) map-data
	mkdir -p web/public
	if [ -f $(PIPELINE_JSON) ]; then cp -f $(PIPELINE_JSON) $(WEB_PIPELINE_JSON); fi
	if [ "$(PIPELINE)" = "1" ]; then \
		( $(MAKE) pipeline && cp -f $(PIPELINE_JSON) $(WEB_PIPELINE_JSON) ) & \
	fi
	if [ "$(API)" = "1" ]; then \
		( $(MAKE) api-dev ) & \
	fi
	$(MAKE) web-dev

map-data:
	python3 scripts/generate_airports_json.py

audit:
	cd web && $(NPM) audit
	$(UV) pip check

clean:
	rm -rf .venv web/node_modules web/dist web/.vite
	find . -type d -name "__pycache__" -prune -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
	find outputs -type f ! -name ".gitkeep" -delete
	find data/cache -type f ! -name ".gitkeep" -delete
