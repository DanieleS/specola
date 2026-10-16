.PHONY: dev web build run tidy image

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

tidy:
	go mod tidy

image:
	docker build -t ghcr.io/danieles/specola:latest .
