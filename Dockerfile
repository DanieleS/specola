# syntax=docker/dockerfile:1

# 1. Build the Svelte SPA (outputs to internal/webui/dist).
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# 2. Build the Go binary with the SPA embedded.
FROM golang:1.24-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /app/internal/webui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /specola ./cmd/specola

# 3. Minimal runtime.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /specola /specola
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/specola"]
