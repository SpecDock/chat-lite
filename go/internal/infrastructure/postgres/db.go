package postgres

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func ApplySchema(ctx context.Context, pool *pgxpool.Pool, schemaPath string) error {
	if schemaPath == "" {
		schemaPath = filepath.Join("go", "schema.sql")
		if _, err := os.Stat(schemaPath); err != nil {
			schemaPath = "schema.sql"
		}
	}
	body, err := os.ReadFile(schemaPath)
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, string(body))
	return err
}
