# Berichtly Server 1.2 – Container-Image (Node.js LTS).
#   docker build -t berichtly-server:1.2.0 .
# Start: siehe docker-compose.yml (Nginx davor, PostgreSQL im internen Netz).
#
# Node.js führt den TypeScript-Quellcode direkt aus (Type Stripping) – kein Build-Schritt, keine nativen Module.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Nur Laufzeitabhängigkeiten, exakt nach package-lock.json; keine Install-Skripte.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
LABEL org.opencontainers.image.title="Berichtly Server" \
      org.opencontainers.image.version="1.2.0" \
      org.opencontainers.image.description="Linux-Backend und Synchronisationsplattform für die Berichtly-Android-App"
WORKDIR /app
ENV NODE_ENV=production \
    APP_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=3000 \
    LOG_FORMAT=json
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY bin ./bin
COPY src ./src
COPY api ./api
# Programmdateien gehören root; der Dienst läuft als unprivilegierter Benutzer "node" (UID 1000) und kann sie
# nicht verändern.
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
# Readiness: Datenbank erreichbar und Schema aktuell.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["node", "src/cli.ts", "healthcheck"]
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["serve"]
