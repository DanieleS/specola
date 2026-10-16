// Command specola runs the Specola server: it applies database migrations, then
// serves the API, the sandboxed page viewer, and the embedded SPA.
package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/danieles/specola/internal/auth"
	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/migrations"
	"github.com/danieles/specola/internal/server"
	"github.com/danieles/specola/internal/store"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver for goose
	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/pressly/goose/v3"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg, err := config.Load()
	if err != nil {
		fatal("config", err)
	}

	if err := runMigrations(cfg.DatabaseURL); err != nil {
		fatal("migrations", err)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		fatal("db pool", err)
	}
	defer pool.Close()

	var authn *auth.Auth
	switch {
	case cfg.TrustedUserHeader != "":
		slog.Info("auth: trusting proxy header", "header", cfg.TrustedUserHeader)
	case cfg.UsesOwnOIDC():
		if authn, err = auth.New(ctx, cfg); err != nil {
			fatal("oidc discovery", err)
		}
	default:
		slog.Warn("auth: dev bypass — every request is one user", "dev_email", cfg.DevAuthEmail)
	}

	var tokens mcpauth.TokenVerifier
	switch cfg.MCPMode() {
	case "oauth":
		if tokens, err = auth.NewAccessTokenVerifier(ctx, cfg.OIDCIssuer, cfg.MCPResource); err != nil {
			fatal("oidc discovery for mcp", err)
		}
		slog.Info("mcp: bearer tokens", "issuer", cfg.OIDCIssuer, "resource", cfg.MCPResource)
	case "dev":
		slog.Warn("mcp: dev bypass — no token required", "dev_email", cfg.DevAuthEmail)
	default:
		slog.Info("mcp: disabled (set SPECOLA_OIDC_ISSUER to enable)")
	}

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           server.New(cfg, store.New(pool), authn, tokens),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("specola listening", "addr", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatal("listen", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	slog.Info("specola stopped")
}

func runMigrations(dbURL string) error {
	db, err := sql.Open("pgx", dbURL)
	if err != nil {
		return err
	}
	defer db.Close()
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	return goose.Up(db, ".")
}

func fatal(msg string, err error) {
	slog.Error(msg, "err", err)
	os.Exit(1)
}
