package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/platform/idgen"
)

func LoadSnapshot(ctx context.Context, pool *pgxpool.Pool, conversationID, userID string) []any {
	messages, _ := LoadSnapshotSource(ctx, pool, conversationID, userID)
	return messages
}

func LoadSnapshotSource(ctx context.Context, pool *pgxpool.Pool, conversationID, userID string) ([]any, int) {
	var raw []byte
	var source *int
	err := pool.QueryRow(ctx, `SELECT context_json, source_version FROM conversation_context_snapshots WHERE conversation_id=$1 AND user_id=$2 AND status='current'`, conversationID, userID).Scan(&raw, &source)
	version := 0
	if source != nil && *source > 0 {
		version = *source
	}
	if err != nil || len(raw) == 0 {
		return nil, version
	}
	var messages []any
	if json.Unmarshal(raw, &messages) != nil || !snapshotMatchesPrompt(messages) {
		return nil, version
	}
	return messages, version
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

func SaveSnapshotWithSourceVersion(ctx context.Context, pool *pgxpool.Pool, conversationID, userID, messageID string, sourceVersion int, messages json.RawMessage) (bool, error) {
	if pool == nil {
		return false, errors.New("postgres 未配置")
	}
	if strings.TrimSpace(conversationID) == "" || strings.TrimSpace(userID) == "" || strings.TrimSpace(messageID) == "" {
		return false, errors.New("快照身份不完整")
	}
	if sourceVersion <= 0 {
		return false, errors.New("source_version 必须为正整数")
	}
	raw := bytes.TrimSpace(messages)
	var items []json.RawMessage
	if len(raw) == 0 || raw[0] != '[' || json.Unmarshal(raw, &items) != nil || len(items) == 0 {
		return false, errors.New("快照消息不是非空 JSON 数组")
	}
	var created string
	_ = pool.QueryRow(ctx, `SELECT created_at FROM messages WHERE id=$1 AND user_id=$2`, messageID, userID).Scan(&created)
	if created == "" {
		created = idgen.NowISO()
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var current *int
	err = tx.QueryRow(ctx, `SELECT source_version FROM conversation_context_snapshots WHERE conversation_id=$1 AND user_id=$2 AND status='current' FOR UPDATE`, conversationID, userID).Scan(&current)
	if err == nil {
		if current != nil && *current >= sourceVersion {
			return false, nil
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	var version int
	if err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(version),0)+1 FROM conversation_context_snapshots WHERE conversation_id=$1 AND user_id=$2`, conversationID, userID).Scan(&version); err != nil {
		return false, err
	}
	id := idgen.NewID("ctx")
	now := idgen.NowISO()
	if _, err = tx.Exec(ctx, `INSERT INTO conversation_context_snapshots (id,conversation_id,user_id,version,covered_message_id,covered_message_created_at,context_json,status,created_at,source_version) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending',$8,$9)`, id, conversationID, userID, version, messageID, created, string(raw), now, sourceVersion); err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversation_context_snapshots SET status='superseded' WHERE conversation_id=$1 AND user_id=$2 AND status='current' AND id<>$3`, conversationID, userID, id); err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversation_context_snapshots SET status='current' WHERE id=$1`, id); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
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
