PNPM := corepack pnpm

.PHONY: help install browser connect probe test-live verify dev up down status logs
help:
	@printf '%s\n' 'install    Install pinned dependencies without lifecycle scripts' 'browser    Install the matching Playwright Chromium browser' 'connect    Open a separate browser for normal McCarren login' 'probe      Inspect the public portal (no saved session)' 'test-live  Collect all eight posted McCarren dates and full grids' 'dev        Build and run the local calendar on 127.0.0.1:4317' 'up         Build and run the Docker calendar' 'down       Stop the Docker calendar, preserving local state' 'status     Show source freshness, latest failure, and next retry' 'logs       Follow timestamped, redacted service/refresh events' 'verify     Check formatting, types, tests, and production build'

install:
	$(PNPM) install --frozen-lockfile --ignore-scripts

browser:
	$(PNPM) exec playwright install chromium

connect:
	$(PNPM) connect

probe:
	$(PNPM) probe

test-live:
	$(PNPM) exec node scripts/collect.ts

dev:
	$(PNPM) build
	$(PNPM) dev

up:
	docker compose up --build -d --wait --wait-timeout 60

down:
	docker compose down

status:
	$(PNPM) exec node scripts/status.ts

logs:
	docker compose logs --timestamps --follow --tail 100 calendar

verify:
	$(PNPM) verify
