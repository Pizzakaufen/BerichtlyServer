# Berichtly Server 1.2 – Entwicklungsbefehle (GNU make, Linux). Alle Befehle gibt es auch als "npm run …".

VERSION      ?= $(shell cat VERSION)
TEST_DB_URL  ?= postgres://berichtly:berichtly-test@127.0.0.1:55432/berichtly_test?sslmode=disable
NGINX_BIN    ?= $(shell command -v nginx)

.PHONY: install run typecheck test test-unit test-nginx test-perf test-db test-db-stop release docker clean

## install: Abhängigkeiten exakt nach package-lock.json installieren
install:
	npm ci

## run: Server lokal mit .env starten
run:
	node src/cli.ts --env-file .env serve

## typecheck: TypeScript-Typprüfung (kein Build nötig – Node.js führt TypeScript direkt aus)
typecheck:
	npx tsc --noEmit

## test: Unit-, Integrations- und (falls Nginx installiert ist) Nginx-Tests gegen PostgreSQL (siehe test-db)
test: typecheck
	BERICHTLY_TEST_DATABASE_URL="$(TEST_DB_URL)" NGINX_BIN="$(NGINX_BIN)" npm test

## test-unit: nur Unit-Tests (ohne Datenbank)
test-unit:
	npm run test:unit

## test-nginx: Full-Stack-Tests PostgreSQL → Node.js → Nginx (HTTP und HTTPS)
test-nginx:
	BERICHTLY_TEST_DATABASE_URL="$(TEST_DB_URL)" NGINX_BIN="$(NGINX_BIN)" npm run test:nginx

## test-perf: Leistungstest mit 300 000 Berichten (ca. 1 Minute)
test-perf:
	BERICHTLY_TEST_DATABASE_URL="$(TEST_DB_URL)" BERICHTLY_PERF_TEST=1 npm run test:perf

## test-db: Wegwerf-PostgreSQL für Tests starten (Docker, nur 127.0.0.1)
test-db:
	docker run -d --rm --name berichtly-test-db -p 127.0.0.1:55432:5432 \
		-e POSTGRES_USER=berichtly -e POSTGRES_PASSWORD=berichtly-test -e POSTGRES_DB=berichtly_test \
		postgres:17-alpine
	@echo "Warte auf PostgreSQL ..."; until docker exec berichtly-test-db pg_isready -U berichtly >/dev/null 2>&1; do sleep 1; done

test-db-stop:
	docker stop berichtly-test-db

## release: Linux-Release-Archiv (inkl. Laufzeitabhängigkeiten) nach dist/
release:
	VERSION=$(VERSION) ./scripts/build-release.sh

## docker: Container-Image bauen
docker:
	docker build -t berichtly-server:$(VERSION) .

clean:
	rm -rf dist
