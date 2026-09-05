FROM node:22-alpine AS frontend
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26.5-alpine AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal/ internal/
COPY cmd/ cmd/
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /ledger ./cmd/ledger

FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata sqlite && addgroup -g 10001 ledger && adduser -D -u 10001 -G ledger ledger && mkdir /data && chown ledger:ledger /data
WORKDIR /app
COPY --from=backend /ledger /app/ledger
COPY --from=frontend /src/web/dist /app/web
ENV LEDGER_ADDR=:8080 LEDGER_DB=/data/ledger.db LEDGER_WEB=/app/web TZ=Asia/Shanghai
USER 10001:10001
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/app/ledger"]
