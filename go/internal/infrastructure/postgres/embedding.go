package postgres

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func EmbeddingAlignPlan(currentDim, wantDim, stored int) string {
	if wantDim <= 0 || currentDim <= 0 || currentDim == wantDim {
		return "keep"
	}
	if stored > 0 {
		return "keep-mismatch"
	}
	return "alter"
}

func vectorDim(formatted string) int {
	formatted = strings.TrimSpace(formatted)
	if !strings.HasPrefix(formatted, "vector(") || !strings.HasSuffix(formatted, ")") {
		return 0
	}
	n, err := strconv.Atoi(formatted[len("vector(") : len(formatted)-1])
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func AlignEmbeddingDimension(ctx context.Context, pool *pgxpool.Pool, want int) error {
	if pool == nil || want <= 0 {
		return nil
	}
	var formatted string
	err := pool.QueryRow(ctx, `SELECT format_type(a.atttypid, a.atttypmod)
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		WHERE c.relname = 'rag_items' AND a.attname = 'embedding' AND NOT a.attisdropped`).Scan(&formatted)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	}
	var stored int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM rag_items WHERE embedding IS NOT NULL`).Scan(&stored); err != nil {
		return err
	}
	switch EmbeddingAlignPlan(vectorDim(formatted), want, stored) {
	case "alter":
		_, err = pool.Exec(ctx, fmt.Sprintf(`ALTER TABLE rag_items ALTER COLUMN embedding TYPE vector(%d)`, want))
		if err != nil {
			return err
		}
		log.Printf("[rag] embedding column aligned to vector(%d)", want)
	case "keep-mismatch":
		log.Printf("[rag] embedding column is %s but configured dimension is %d; %d stored vectors were left unchanged", formatted, want, stored)
	}
	return nil
}
