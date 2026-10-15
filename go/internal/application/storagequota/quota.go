package storagequota

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/infrastructure/storage"
)

const Limit int64 = 2 << 30

var ErrFull = errors.New("储存已满")

func Used(ctx context.Context, pool *pgxpool.Pool, userID string) (int64, error) {
	var used int64
	err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(size),0) FROM attachments WHERE user_id=$1 AND conversation_id IS NOT NULL`, userID).Scan(&used)
	if err != nil {
		return 0, err
	}
	rows, err := pool.Query(ctx, `SELECT file_path FROM studio_images WHERE user_id=$1 AND file_path IS NOT NULL
		UNION ALL
		SELECT file_path FROM studio_image_references WHERE user_id=$1 AND file_path<>''`, userID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var path string
		if err = rows.Scan(&path); err != nil {
			return 0, err
		}
		size, statErr := storage.Size(ctx, path)
		if statErr == nil && size > 0 {
			used += size
		}
	}
	return used, rows.Err()
}

func Ensure(ctx context.Context, pool *pgxpool.Pool, userID string, extra int64) error {
	if extra < 0 {
		extra = 0
	}
	used, err := Used(ctx, pool, userID)
	if err != nil {
		return err
	}
	if used+extra > Limit {
		return ErrFull
	}
	return nil
}
