package chat

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/platform/idgen"
)

func LoadSnapshot(ctx context.Context, pool *pgxpool.Pool, conversationID, userID string) []any {
	var raw []byte
	err := pool.QueryRow(ctx, `SELECT context_json FROM conversation_context_snapshots WHERE conversation_id=$1 AND user_id=$2 AND status='current'`, conversationID, userID).Scan(&raw)
	if err != nil || len(raw) == 0 {
		return nil
	}
	var messages []any
	if json.Unmarshal(raw, &messages) != nil || !snapshotMatchesPrompt(messages) {
		return nil
	}
	return messages
}

func InvalidateSnapshots(ctx context.Context, pool *pgxpool.Pool, conversationID, userID string) {
	_, _ = pool.Exec(ctx, `UPDATE conversation_context_snapshots SET status='invalid' WHERE conversation_id=$1 AND user_id=$2 AND status IN ('current','pending')`, conversationID, userID)
}

func SaveSnapshot(ctx context.Context, pool *pgxpool.Pool, conversationID, userID, messageID, createdAt string, messages []any) error {
	if len(messages) == 0 || messageID == "" || createdAt == "" {
		return nil
	}
	raw, err := json.Marshal(messages)
	if err != nil {
		return err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var version int
	if err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(version),0)+1 FROM conversation_context_snapshots WHERE conversation_id=$1 AND user_id=$2`, conversationID, userID).Scan(&version); err != nil {
		return err
	}
	id := idgen.NewID("ctx")
	now := idgen.NowISO()
	if _, err = tx.Exec(ctx, `INSERT INTO conversation_context_snapshots (id,conversation_id,user_id,version,covered_message_id,covered_message_created_at,context_json,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`, id, conversationID, userID, version, messageID, createdAt, raw, now); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversation_context_snapshots SET status='superseded' WHERE conversation_id=$1 AND user_id=$2 AND status='current' AND id<>$3`, conversationID, userID, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversation_context_snapshots SET status='current' WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func snapshotMatchesPrompt(messages []any) bool {
	if len(messages) == 0 {
		return false
	}
	first, ok := messages[0].(map[string]any)
	if !ok || first["role"] != "system" {
		return false
	}
	return systemText(first["content"]) == systemPrompt
}

func systemText(content any) string {
	switch typed := content.(type) {
	case string:
		return typed
	case []any:
		for _, part := range typed {
			block, ok := part.(map[string]any)
			if !ok || block["type"] != "text" {
				continue
			}
			text, _ := block["text"].(string)
			if text != "" {
				return text
			}
		}
	}
	return ""
}
