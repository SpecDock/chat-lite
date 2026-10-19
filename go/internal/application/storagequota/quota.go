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
	fillMissingSizes(ctx, pool, userID, "studio_images")
	fillMissingSizes(ctx, pool, userID, "studio_image_references")
	var attachments, studio, refs int64
	err := pool.QueryRow(ctx, `SELECT COALESCE(SUM(size),0) FROM attachments WHERE user_id=$1 AND conversation_id IS NOT NULL`, userID).Scan(&attachments)
	if err != nil {
		return 0, err
	}
	err = pool.QueryRow(ctx, `SELECT COALESCE(SUM(COALESCE(file_size,0)+COALESCE(thumbnail_size,0)),0) FROM studio_images WHERE user_id=$1`, userID).Scan(&studio)
	if err != nil {
		return 0, err
	}
	err = pool.QueryRow(ctx, `SELECT COALESCE(SUM(COALESCE(file_size,0)+COALESCE(thumbnail_size,0)),0) FROM studio_image_references WHERE user_id=$1`, userID).Scan(&refs)
	if err != nil {
		return 0, err
	}
	return attachments + studio + refs, nil
}

func fillMissingSizes(ctx context.Context, pool *pgxpool.Pool, userID, table string) {
	query := `SELECT id, file_path FROM studio_images WHERE user_id=$1 AND file_path IS NOT NULL AND file_size IS NULL`
	update := `UPDATE studio_images SET file_size=$1 WHERE id=$2 AND user_id=$3 AND file_size IS NULL`
	if table == "studio_image_references" {
		query = `SELECT id, file_path FROM studio_image_references WHERE user_id=$1 AND file_path<>'' AND file_size IS NULL`
		update = `UPDATE studio_image_references SET file_size=$1 WHERE id=$2 AND user_id=$3 AND file_size IS NULL`
	}
	rows, err := pool.Query(ctx, query, userID)
	if err != nil {
		return
	}
	defer rows.Close()
	type pending struct{ id, path string }
	var items []pending
	for rows.Next() {
		var item pending
		if rows.Scan(&item.id, &item.path) == nil {
			items = append(items, item)
		}
	}
	rows.Close()
	for _, item := range items {
		size, statErr := storage.Size(ctx, item.path)
		if statErr == nil && size > 0 {
			_, _ = pool.Exec(ctx, update, size, item.id, userID)
		}
	}
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
