# Berichtly Server – Build- und Entwicklungsbefehle (GNU make, Linux).

VERSION      ?= $(shell cat VERSION)
BINARY       := berichtly-server
LDFLAGS      := -s -w -X berichtly-server/internal/app.Version=$(VERSION)
TEST_DB_URL  ?= postgres://berichtly:berichtly-test@127.0.0.1:55432/berichtly_test?sslmode=disable

.PHONY: build run test test-race test-perf test-db test-db-stop lint release docker clean

## build: statisch gelinkte Linux-Binärdatei nach bin/ bauen
build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(BINARY) ./cmd/berichtly-server

## run: Server lokal mit .env starten
run: build
	./bin/$(BINARY) --env-file .env serve

## test: Unit- und Integrationstests (benötigt PostgreSQL, siehe test-db)
test:
	BERICHTLY_TEST_DATABASE_URL="$(TEST_DB_URL)" go test -p 1 -count=1 ./...

## test-perf: Leistungstest mit 300 000 Berichten (ca. 1 Minute)
test-perf:
	BERICHTLY_TEST_DATABASE_URL="$(TEST_DB_URL)" BERICHTLY_PERF_TEST=1 go test -count=1 -run TestLeistung -v ./internal/httpapi/

## test-race: wie test, zusätzlich mit Race-Detector (benötigt gcc, CGO)
test-race:
	BERICHTLY_TEST_DATABASE_URL="$(TEST_DB_URL)" CGO_ENABLED=1 go test -p 1 -count=1 -race ./...

## test-db: Wegwerf-PostgreSQL für Tests starten (Docker, nur 127.0.0.1)
test-db:
	docker run -d --rm --name berichtly-test-db -p 127.0.0.1:55432:5432 \
		-e POSTGRES_USER=berichtly -e POSTGRES_PASSWORD=berichtly-test -e POSTGRES_DB=berichtly_test \
		postgres:17-alpine
	@echo "Warte auf PostgreSQL ..."; until docker exec berichtly-test-db pg_isready -U berichtly >/dev/null 2>&1; do sleep 1; done

test-db-stop:
	docker stop berichtly-test-db

## lint: Formatierung und statische Analyse
lint:
	@test -z "$$(gofmt -l .)" || (echo "Nicht formatiert:"; gofmt -l .; exit 1)
	go vet ./...

## release: Linux-Release-Archive (amd64 + arm64) nach dist/
release:
	VERSION=$(VERSION) ./scripts/build-release.sh

## docker: Container-Image bauen
docker:
	docker build --build-arg VERSION=$(VERSION) -t berichtly-server:$(VERSION) .

clean:
	rm -rf bin dist
