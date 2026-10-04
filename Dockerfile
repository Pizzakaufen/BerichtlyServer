# Berichtly Server – Linux-Container-Image (mehrstufiger Build).
#   docker build -t berichtly-server .
# Start: siehe docker-compose.yml

FROM golang:1.27-alpine AS build
ARG VERSION=1.0.0-alpha
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags "-s -w -X berichtly-server/internal/app.Version=${VERSION}" \
    -o /out/berichtly-server ./cmd/berichtly-server

# Minimales Laufzeit-Image: nur die statische Binärdatei, keine Shell, kein Paketmanager,
# läuft als unprivilegierter Benutzer "nonroot" (UID 65532).
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/berichtly-server /usr/local/bin/berichtly-server
USER nonroot:nonroot
ENV APP_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8080 \
    LOG_FORMAT=json
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD ["/usr/local/bin/berichtly-server", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/berichtly-server"]
CMD ["serve"]
