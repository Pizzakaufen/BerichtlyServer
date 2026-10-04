# Berichtly Server 1.1 – Linux-Container-Image (mehrstufiger, reproduzierbarer Build).
#   docker build --build-arg VERSION=1.1.0 -t berichtly-server:1.1.0 .
# Start: siehe docker-compose.yml

FROM golang:1.27-alpine AS build
ARG VERSION=1.1.0
WORKDIR /src
# Abhängigkeiten zuerst (Layer-Cache); go.sum stellt identische Versionen sicher.
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -buildvcs=false \
    -ldflags "-s -w -X berichtly-server/internal/app.Version=${VERSION}" \
    -o /out/berichtly-server ./cmd/berichtly-server

# Minimales Laufzeit-Image: nur die statische Binärdatei – keine Shell, kein Paketmanager,
# läuft als unprivilegierter Benutzer "nonroot" (UID 65532).
FROM gcr.io/distroless/static-debian12:nonroot
ARG VERSION=1.1.0
LABEL org.opencontainers.image.title="Berichtly Server" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.description="Linux-Backend und Synchronisationsplattform für die Berichtly-Android-App"
COPY --from=build /out/berichtly-server /usr/local/bin/berichtly-server
USER nonroot:nonroot
ENV APP_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8080 \
    LOG_FORMAT=json
EXPOSE 8080
STOPSIGNAL SIGTERM
# Readiness: Datenbank erreichbar und Schema aktuell.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["/usr/local/bin/berichtly-server", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/berichtly-server"]
CMD ["serve"]
