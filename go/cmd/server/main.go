package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/infrastructure/postgres"
	"chatlite/internal/interfaces/httpapi"
	"chatlite/internal/platform/config"
	"chatlite/internal/platform/httpx"
)

func main() {
	cfg := config.Load()
	ctx := context.Background()
	var pool *pgxpool.Pool
	if cfg.DatabaseURL != "" {
		opened, err := postgres.Open(ctx, cfg.DatabaseURL)
		if err != nil {
			log.Fatal(err)
		}
		pool = opened
		defer pool.Close()
		if err := postgres.ApplySchema(ctx, pool, os.Getenv("SCHEMA_PATH")); err != nil {
			log.Fatal(err)
		}
	}

	mux := http.NewServeMux()
	httpapi.New(pool).Register(mux)

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           httpx.CORS(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("chat-lite go listening on http://localhost:%s", cfg.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
}
