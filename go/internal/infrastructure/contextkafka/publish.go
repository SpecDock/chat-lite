package contextkafka

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
)

const GroupID = "chatlite-context"

type SnapshotEvent struct {
	ConversationID string          `json:"conversation_id"`
	UserID         string          `json:"user_id"`
	MessageID      string          `json:"message_id"`
	Version        int             `json:"version"`
	UpdatedUnix    int64           `json:"updated_unix"`
	Messages       json.RawMessage `json:"messages"`
}

var active atomic.Pointer[Runtime]

func Publish(ctx context.Context, event SnapshotEvent) error {
	rt := active.Load()
	if rt == nil || rt.writer == nil {
		return errors.New("contextkafka: 未启动")
	}
	if strings.TrimSpace(event.ConversationID) == "" {
		return errors.New("contextkafka: conversation_id 为空")
	}
	body, err := json.Marshal(event)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return rt.writer.WriteMessages(writeCtx, kafka.Message{
		Key:   []byte(event.ConversationID),
		Value: body,
	})
}
