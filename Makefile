.PHONY: dev web build run test e2e tidy image

# Run the backend with the dev auth bypass (no OIDC). Expects SPECOLA_DATABASE_URL.
dev:
	SPECOLA_DEV_AUTH_EMAIL?=you@example.com go run ./cmd/specola

# Frontend dev server (proxies /api, /view, /auth to :8080).
web:
	cd web && npm install && npm run dev

# Build the SPA then the binary with it embedded.
build:
	cd web && npm install && npm run build
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o specola ./cmd/specola

# Tests that need Postgres create throwaway databases on SPECOLA_TEST_DATABASE_URL
# and are skipped when it is unset. The runner's and the plugin's tests need
# Node 22+ (and the plugin's dependencies: cd plugin && npm install).
test:
	go test ./...
	cd runner && npm test
	cd plugin && node --test test/*.test.js

# Publishes real SPA bundles, with and without a backend, and checks them in
# Chromium; checks the page backend bridge on its own (see e2e/README.md).
e2e:
	node e2e/bundles.mjs
	node e2e/sdk-bridge.mjs
	node e2e/backends.mjs
	node e2e/page-apps.mjs

tidy:
	go mod tidy

image:
	docker build -t ghcr.io/danieles/specola:latest .
