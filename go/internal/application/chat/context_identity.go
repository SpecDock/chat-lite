package chat

import (
	"context"
	"log"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Snapshot-only metadata. It survives compaction with the system message, but
// expandImageRefs removes it from every message before sending to the model.
const contextIdentityKey = "_chat_context"

func initialMessages(ctx context.Context, pool *pgxpool.Pool, in Input) ([]any, error) {
	lastUserID := ""
	for _, item := range in.History {
		if item.Role == "user" {
			lastUserID = item.ID
		}
	}
	if snapshotMatchesPrompt(in.Prior) {
		head := in.Prior[0].(map[string]any)
		identity, ok := head[contextIdentityKey].(map[string]any)
		if ok && identity["format"] == "1" && identity["last_user_message_id"] == lastUserID && lastUserID != "" {
			return append([]any(nil), in.Prior...), nil
		}
	}
	// Legacy snapshots can have holes even when their covered_message_id was
	// advanced by a later successful retry. Rebuild once instead of guessing at
	// version/timestamp alignment or replaying any historical tool calls.
	if len(in.Prior) > 0 {
		log.Printf("[conversation-context] conversation=%s rebuilding_unverified_snapshot", in.ConversationID)
	}
	history := append([]HistoryItem(nil), in.History...)
	var userIDs []string
	positions := make(map[string]int)
	for i, item := range history {
		if item.Role == "user" && item.ID != "" {
			userIDs = append(userIDs, item.ID)
			positions[item.ID] = i
		}
	}
	if len(userIDs) > 0 {
		// Message text only contains attachment links; parsed PDF text lives on
		// attachments. Hydrate it independently of RAG and of current uploads.
		rows, err := pool.Query(ctx, `SELECT message_id, COALESCE(original_name,''), pdf_status, pdf_chars, pdf_inline FROM attachments WHERE user_id=$1 AND conversation_id=$2 AND message_id=ANY($3) AND (mime_type='application/pdf' OR lower(original_name) LIKE '%.pdf') ORDER BY created_at, id`, in.UserID, in.ConversationID, userIDs)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var messageID, name string
			var status, inline *string
			var chars *int
			if err := rows.Scan(&messageID, &name, &status, &chars, &inline); err != nil {
				return nil, err
			}
			i := positions[messageID]
			history[i].Content += "\n\n" + pdfContextNote(name, status, chars, inline)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return PrefixMessages(in.Summary, history), nil
}

func markAcceptedUser(messages []any, userMessageID string) {
	if len(messages) == 0 || userMessageID == "" {
		return
	}
	head, ok := messages[0].(map[string]any)
	if !ok {
		return
	}
	cloned := make(map[string]any, len(head)+1)
	for key, value := range head {
		cloned[key] = value
	}
	cloned[contextIdentityKey] = map[string]any{"format": "1", "last_user_message_id": userMessageID}
	messages[0] = cloned
}
