package main

import (
	"context"
	"log"

	"chatlite/config"
	"chatlite/internal/infrastructure/postgres"
	"chatlite/internal/interfaces/httpapi"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	pool, err := postgres.Open(ctx, cfg.Postgres.URL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err = postgres.ApplySchema(ctx, pool, cfg.Server.SchemaPath); err != nil {
		log.Fatal(err)
	}
	images, refs := httpapi.New(pool).BackfillStudioFiles(ctx)
	log.Printf("[studio-backfill] done images=%d references=%d", images, refs)
}
