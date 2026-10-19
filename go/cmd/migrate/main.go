package main

import (
	"context"
	"database/sql"
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	_ "modernc.org/sqlite"
)

// 源库和目标库都写在这里。不读 .env。
const (
	sqliteAppSQL = `file:D:/chat-lite/data/app.db?mode=ro`
	sqliteRagSQL = `file:D:/chat-lite/data/rag.db?mode=ro`
	postgresSQL  = `postgres://chatlite:chatlite@127.0.0.1:5432/chatlite?sslmode=disable`
	schemaPath   = `schema.sql`
	// one 只迁 1 个用户及其关联行；all 迁全部。
	migrateMode = "one"
)

func main() {
	ctx := context.Background()
	var err error
	switch migrateMode {
	case "one":
		err = migrateOne(ctx)
	case "all":
		err = migrateAll(ctx)
	default:
		err = fmt.Errorf("migrateMode 只能是 one 或 all")
	}
	if err != nil {
		log.Fatal(err)
	}
}

func migrateOne(ctx context.Context) error {
	return run(ctx, 1)
}

func migrateAll(ctx context.Context) error {
	return run(ctx, 0)
}

func run(ctx context.Context, limit int) error {
	appDB, err := sql.Open("sqlite", sqliteAppSQL)
	if err != nil {
		return err
	}
	defer appDB.Close()
	ragDB, err := sql.Open("sqlite", sqliteRagSQL)
	if err != nil {
		return err
	}
	defer ragDB.Close()
	pg, err := pgx.Connect(ctx, postgresSQL)
	if err != nil {
		return err
	}
	defer pg.Close(ctx)
	if err := applySchema(ctx, pg); err != nil {
		return err
	}

	userID, err := oneUser(ctx, appDB, limit)
	if err != nil {
		return err
	}
	if err := copyUsers(ctx, appDB, pg, userID); err != nil {
		return err
	}
	if err := copyConversations(ctx, appDB, pg, userID, limit); err != nil {
		return err
	}
	if err := copyMessages(ctx, appDB, pg, userID, limit); err != nil {
		return err
	}
	if err := copyAttachments(ctx, appDB, pg, userID, limit); err != nil {
		return err
	}
	if err := restoreAvatars(ctx, appDB, pg, userID); err != nil {
		return err
	}
	steps := []func() error{
		func() error { return copySimple(ctx, appDB, pg, "sessions", userID, limit) },
		func() error { return copySimple(ctx, appDB, pg, "email_codes", "", limit) },
		func() error { return copySimple(ctx, appDB, pg, "conversation_context_states", userID, limit) },
		func() error { return copySnapshots(ctx, appDB, pg, userID, limit) },
		func() error { return copySimple(ctx, appDB, pg, "message_search_documents", userID, limit) },
		func() error { return copySimple(ctx, appDB, pg, "image_generations", userID, limit) },
		func() error { return copySerial(ctx, appDB, pg, "token_usage", userID, limit) },
		func() error { return copySerial(ctx, appDB, pg, "image_usage", userID, limit) },
		func() error { return copySimple(ctx, appDB, pg, "studio_images", userID, limit) },
		func() error { return copySimple(ctx, appDB, pg, "studio_image_references", userID, limit) },
		func() error { return copyRag(ctx, ragDB, pg, userID, limit) },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return err
		}
	}
	log.Printf("迁移完成 mode=%s", migrateMode)
	return nil
}

func applySchema(ctx context.Context, pg *pgx.Conn) error {
	body, err := os.ReadFile(schemaPath)
	if err != nil {
		return err
	}
	_, err = pg.Exec(ctx, string(body))
	return err
}

func oneUser(ctx context.Context, appDB *sql.DB, limit int) (string, error) {
	if limit == 0 {
		return "", nil
	}
	var id string
	err := appDB.QueryRowContext(ctx, `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return id, err
}

func userWhere(column, userID string, args []any) (string, []any) {
	if userID == "" || column == "" {
		return "", args
	}
	return " WHERE " + column + " = ?", append(args, userID)
}

func copyUsers(ctx context.Context, appDB *sql.DB, pg *pgx.Conn, userID string) error {
	query := `SELECT id, email, password_hash, email_verified_at, created_at FROM users`
	args := []any{}
	if userID != "" {
		query += ` WHERE id = ?`
		args = append(args, userID)
	}
	rows, err := appDB.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id, email, hash, created string
		var verified sql.NullString
		if err := rows.Scan(&id, &email, &hash, &verified, &created); err != nil {
			return err
		}
		_, err = pg.Exec(ctx, `
			INSERT INTO users (id, email, password_hash, avatar_attachment_id, email_verified_at, created_at)
			VALUES ($1,$2,$3,NULL,$4,$5)
			ON CONFLICT (id) DO NOTHING`, id, email, hash, nullString(verified), created)
		if err != nil {
			return err
		}
		count++
	}
	log.Printf("users %d", count)
	return rows.Err()
}

func copyConversations(ctx context.Context, appDB *sql.DB, pg *pgx.Conn, userID string, limit int) error {
	query := `SELECT id, user_id, title, pinned_at, title_manually_set, created_at, updated_at FROM conversations`
	where, args := userWhere("user_id", userID, nil)
	query += where + ` ORDER BY created_at ASC`
	if limit > 0 {
		query += ` LIMIT 1`
	}
	rows, err := appDB.QueryContext(ctx, query, args...)
	if err != nil {
		return missingTable(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id, uid, title, created, updated string
		var pinned sql.NullString
		var manual int
		if err := rows.Scan(&id, &uid, &title, &pinned, &manual, &created, &updated); err != nil {
			return err
		}
		_, err = pg.Exec(ctx, `
			INSERT INTO conversations (id, user_id, title, pinned_at, title_manually_set, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (id) DO NOTHING`, id, uid, title, nullString(pinned), manual != 0, created, updated)
		if err != nil {
			return err
		}
		count++
	}
	log.Printf("conversations %d", count)
	return rows.Err()
}

func copyMessages(ctx context.Context, appDB *sql.DB, pg *pgx.Conn, userID string, limit int) error {
	query := `SELECT id, user_id, conversation_id, role, content, status, created_at FROM messages`
	where, args := userWhere("user_id", userID, nil)
	query += where + ` ORDER BY created_at ASC`
	if limit > 0 {
		query += ` LIMIT 1`
	}
	rows, err := appDB.QueryContext(ctx, query, args...)
	if err != nil {
		return missingTable(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id, uid, cid, role, content, status, created string
		if err := rows.Scan(&id, &uid, &cid, &role, &content, &status, &created); err != nil {
			return err
		}
		_, err = pg.Exec(ctx, `
			INSERT INTO messages (id, user_id, conversation_id, role, content, status, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (id) DO NOTHING`, id, uid, cid, role, content, status, created)
		if err != nil {
			return err
		}
		count++
	}
	log.Printf("messages %d", count)
	return rows.Err()
}

func copyAttachments(ctx context.Context, appDB *sql.DB, pg *pgx.Conn, userID string, limit int) error {
	query := `SELECT id, user_id, conversation_id, message_id, original_name, file_path, public_path, mime_type, size, created_at FROM attachments`
	where, args := userWhere("user_id", userID, nil)
	query += where + ` ORDER BY created_at ASC`
	if limit > 0 {
		query += ` LIMIT 1`
	}
	rows, err := appDB.QueryContext(ctx, query, args...)
	if err != nil {
		return missingTable(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id, uid, path, publicPath, mime, created string
		var cid, mid, name sql.NullString
		var size int
		if err := rows.Scan(&id, &uid, &cid, &mid, &name, &path, &publicPath, &mime, &size, &created); err != nil {
			return err
		}
		_, err = pg.Exec(ctx, `
			INSERT INTO attachments (id, user_id, conversation_id, message_id, original_name, file_path, public_path, mime_type, size, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			ON CONFLICT (id) DO NOTHING`,
			id, uid, nullString(cid), nullString(mid), nullString(name), path, publicPath, mime, size, created)
		if err != nil {
			return err
		}
		count++
	}
	log.Printf("attachments %d", count)
	return rows.Err()
}

func restoreAvatars(ctx context.Context, appDB *sql.DB, pg *pgx.Conn, userID string) error {
	query := `SELECT id, avatar_attachment_id FROM users WHERE avatar_attachment_id IS NOT NULL AND avatar_attachment_id != ''`
	args := []any{}
	if userID != "" {
		query += ` AND id = ?`
		args = append(args, userID)
	}
	rows, err := appDB.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, avatar string
		if err := rows.Scan(&id, &avatar); err != nil {
			return err
		}
		if _, err := pg.Exec(ctx, `UPDATE users SET avatar_attachment_id=$1 WHERE id=$2`, avatar, id); err != nil {
			log.Printf("跳过头像 %s: %v", id, err)
		}
	}
	return rows.Err()
}

func copySimple(ctx context.Context, appDB *sql.DB, pg *pgx.Conn, table, userID string, limit int) error {
	cols, err := sqliteColumns(ctx, appDB, table)
	if err != nil {
		return err
	}
	if len(cols) == 0 {
		log.Printf("%s 不存在，跳过", table)
		return nil
	}
	query := "SELECT " + strings.Join(cols, ", ") + " FROM " + table
	args := []any{}
	if userID != "" && hasColumn(cols, "user_id") {
		query += " WHERE user_id = ?"
		args = append(args, userID)
	}
	if limit > 0 {
		query += " LIMIT 1"
	}
	rows, err := appDB.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}
		if err := insertDynamic(ctx, pg, table, cols, values); err != nil {
			return fmt.Errorf("%s: %w", table, err)
		}
		count++
	}
	log.Printf("%s %d", table, count)
	return rows.Err()
}

func copySnapshots(ctx context.Context, appDB *sql.DB, pg *pgx.Conn, userID string, limit int) error {
	if err := copySimple(ctx, appDB, pg, "conversation_context_snapshots", userID, limit); err != nil {
		return err
	}
	return nil
}

func copySerial(ctx context.Context, appDB *sql.DB, pg *pgx.Conn, table, userID string, limit int) error {
	if err := copySimple(ctx, appDB, pg, table, userID, limit); err != nil {
		return err
	}
	_, err := pg.Exec(ctx, fmt.Sprintf(`
		SELECT setval(pg_get_serial_sequence('%s','id'), COALESCE((SELECT MAX(id) FROM %s), 1), true)`, table, table))
	return err
}

func copyRag(ctx context.Context, ragDB *sql.DB, pg *pgx.Conn, userID string, limit int) error {
	cols, err := sqliteColumns(ctx, ragDB, "rag_items")
	if err != nil || len(cols) == 0 {
		log.Printf("rag_items 不存在，跳过")
		return nil
	}
	query := `SELECT rowid, id, user_id, conversation_id, message_id, role, chunk_index, chunk_text, chunk_type, importance, created_at, embedded_at, embedding_dim, hit_count, last_hit_at, last_injected_at, content_hash`
	if hasColumn(cols, "parent_text") {
		query += `, parent_text`
	}
	query += ` FROM rag_items`
	args := []any{}
	if userID != "" {
		query += ` WHERE user_id = ?`
		args = append(args, userID)
	}
	query += ` ORDER BY created_at ASC`
	if limit > 0 {
		query += ` LIMIT 1`
	}
	rows, err := ragDB.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	vectors := loadVectors(ctx, ragDB)
	count := 0
	for rows.Next() {
		var rowid int64
		var id, uid, cid, mid, role, text, kind, created string
		var index, hits int
		var importance float64
		var embedded, hash, parent sql.NullString
		var dim sql.NullInt64
		var lastHit, lastInjected sql.NullString
		dest := []any{&rowid, &id, &uid, &cid, &mid, &role, &index, &text, &kind, &importance, &created, &embedded, &dim, &hits, &lastHit, &lastInjected, &hash}
		if hasColumn(cols, "parent_text") {
			dest = append(dest, &parent)
		}
		if err := rows.Scan(dest...); err != nil {
			return err
		}
		vector := vectors[rowid]
		var vectorArg any
		if vector != "" {
			vectorArg = vector
		}
		_, err = pg.Exec(ctx, `
			INSERT INTO rag_items (
				id, user_id, conversation_id, message_id, role, chunk_index, chunk_text, parent_text, chunk_type, importance,
				created_at, embedded_at, embedding_dim, hit_count, last_hit_at, last_injected_at, content_hash, embedding
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
			ON CONFLICT (id) DO NOTHING`,
			id, uid, cid, mid, role, index, text, nullString(parent), kind, importance, created,
			nullString(embedded), nullInt(dim), hits, nullString(lastHit), nullString(lastInjected), nullString(hash), vectorArg)
		if err != nil {
			return err
		}
		count++
	}
	log.Printf("rag_items %d", count)
	return rows.Err()
}

func loadVectors(ctx context.Context, ragDB *sql.DB) map[int64]string {
	out := map[int64]string{}
	rows, err := ragDB.QueryContext(ctx, `SELECT rowid, embedding FROM vec_rag_items`)
	if err != nil {
		log.Printf("向量表读不到，RAG 文本仍会迁移: %v", err)
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var rowid int64
		var blob []byte
		if err := rows.Scan(&rowid, &blob); err != nil {
			continue
		}
		if text, ok := vectorLiteral(blob, 1536); ok {
			out[rowid] = text
		}
	}
	return out
}

func vectorLiteral(blob []byte, dimensions int) (string, bool) {
	if len(blob) != dimensions*4 {
		return "", false
	}
	parts := make([]string, dimensions)
	for i := 0; i < dimensions; i++ {
		bits := binary.LittleEndian.Uint32(blob[i*4 : (i+1)*4])
		parts[i] = fmt.Sprintf("%g", math.Float32frombits(bits))
	}
	return "[" + strings.Join(parts, ",") + "]", true
}

func sqliteColumns(ctx context.Context, db *sql.DB, table string) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		cols = append(cols, name)
	}
	return cols, rows.Err()
}

func hasColumn(cols []string, name string) bool {
	for _, col := range cols {
		if col == name {
			return true
		}
	}
	return false
}

func insertDynamic(ctx context.Context, pg *pgx.Conn, table string, cols []string, values []any) error {
	placeholders := make([]string, len(cols))
	args := make([]any, len(cols))
	for i, col := range cols {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
		args[i] = normalize(col, values[i])
	}
	sqlText := fmt.Sprintf(`INSERT INTO %s (%s) VALUES (%s) ON CONFLICT DO NOTHING`,
		table, strings.Join(cols, ", "), strings.Join(placeholders, ","))
	_, err := pg.Exec(ctx, sqlText, args...)
	return err
}

func normalize(column string, value any) any {
	if value == nil {
		return nil
	}
	if column == "title_manually_set" {
		switch n := value.(type) {
		case int64:
			return n != 0
		case int:
			return n != 0
		}
	}
	switch v := value.(type) {
	case []byte:
		return string(v)
	default:
		return v
	}
}

func nullString(value sql.NullString) any {
	if !value.Valid || value.String == "" {
		return nil
	}
	return value.String
}

func nullInt(value sql.NullInt64) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}

func missingTable(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), "no such table") {
		log.Printf("跳过: %v", err)
		return nil
	}
	return err
}
