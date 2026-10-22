package contextkafka

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/segmentio/kafka-go"

	"chatlite/internal/application/chat"
	"chatlite/internal/infrastructure/contextstore"
)

const idleSeconds int64 = 1800

type Runtime struct {
	writer *kafka.Writer
	reader *kafka.Reader
	store  *contextstore.Store
	pool   *pgxpool.Pool
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func Start(brokers []string, topic string, store *contextstore.Store, pool *pgxpool.Pool) (*Runtime, error) {
	if len(brokers) == 0 {
		return nil, errors.New("contextkafka: brokers 为空")
	}
	if store == nil || pool == nil {
		return nil, errors.New("contextkafka: redis 或 postgres 未配置")
	}
	topic = strings.TrimSpace(topic)
	if topic == "" {
		topic = "chatlite-context"
	}
	ctx, cancel := context.WithCancel(context.Background())
	rt := &Runtime{
		writer: &kafka.Writer{
			Addr:                   kafka.TCP(brokers...),
			Topic:                  topic,
			Balancer:               &kafka.Hash{},
			RequiredAcks:           kafka.RequireAll,
			AllowAutoTopicCreation: true,
			BatchTimeout:           time.Millisecond,
		},
		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers:     brokers,
			GroupID:     GroupID,
			Topic:       topic,
			StartOffset: kafka.FirstOffset,
			MaxBytes:    10 << 20,
		}),
		store:  store,
		pool:   pool,
		cancel: cancel,
	}
	active.Store(rt)
	rt.wg.Add(2)
	go func() {
		defer rt.wg.Done()
		rt.consume(ctx)
	}()
	go func() {
		defer rt.wg.Done()
		rt.cleanup(ctx)
	}()
	log.Printf("[context-kafka] started topic=%s group=%s brokers=%s", topic, GroupID, strings.Join(brokers, ","))
	return rt, nil
}

func (rt *Runtime) Close() error {
	if rt == nil {
		return nil
	}
	rt.cancel()
	rt.wg.Wait()
	err := rt.reader.Close()
	if werr := rt.writer.Close(); err == nil {
		err = werr
	}
	return err
}

func (rt *Runtime) consume(ctx context.Context) {
	for {
		msg, err := rt.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("[context-kafka] fetch_failed err=%v", err)
			if !wait(ctx, time.Second) {
				return
			}
			continue
		}
		for {
			err = rt.apply(ctx, msg)
			if err == nil {
				break
			}
			if ctx.Err() != nil {
				return
			}
			log.Printf("[context-kafka] apply_failed partition=%d offset=%d err=%v", msg.Partition, msg.Offset, err)
			if !wait(ctx, time.Second) {
				return
			}
		}
		for {
			if err = rt.reader.CommitMessages(ctx, msg); err == nil {
				break
			}
			if ctx.Err() != nil {
				return
			}
			log.Printf("[context-kafka] commit_failed partition=%d offset=%d err=%v", msg.Partition, msg.Offset, err)
			if !wait(ctx, time.Second) {
				return
			}
		}
	}
}

func (rt *Runtime) apply(ctx context.Context, msg kafka.Message) error {
	event, version, drop, err := parseEvent(msg.Value)
	if drop {
		log.Printf("[context-kafka] drop_invalid partition=%d offset=%d err=%v", msg.Partition, msg.Offset, err)
		return nil
	}
	stored, ok, err := rt.store.DBVersion(ctx, event.ConversationID)
	if err != nil {
		return err
	}
	seen := 0
	if ok {
		seen = stored
	}
	if version <= seen {
		log.Printf("[context-kafka] conversation=%s version=%d stored=%d skip_old", event.ConversationID, version, seen)
		return nil
	}
	wrote, err := chat.SaveSnapshotWithSourceVersion(ctx, rt.pool, event.ConversationID, event.UserID, event.MessageID, version, event.Messages)
	if err != nil {
		if permanentPostgres(err) {
			log.Printf("[context-kafka] conversation=%s version=%d drop_permanent err=%v", event.ConversationID, version, err)
			return nil
		}
		return err
	}
	if !wrote {
		return nil
	}
	return rt.store.SetDBVersion(ctx, event.ConversationID, version)
}

func parseEvent(body []byte) (SnapshotEvent, int, bool, error) {
	var raw struct {
		ConversationID string          `json:"conversation_id"`
		UserID         string          `json:"user_id"`
		MessageID      string          `json:"message_id"`
		Version        json.RawMessage `json:"version"`
		Messages       json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return SnapshotEvent{}, 0, true, err
	}
	version, err := positiveVersion(raw.Version)
	if err != nil {
		return SnapshotEvent{}, 0, true, err
	}
	if strings.TrimSpace(raw.ConversationID) == "" || strings.TrimSpace(raw.UserID) == "" || strings.TrimSpace(raw.MessageID) == "" {
		return SnapshotEvent{}, 0, true, errors.New("conversation_id、user_id 或 message_id 为空")
	}
	messages := bytes.TrimSpace(raw.Messages)
	if !nonEmptyJSONArray(messages) {
		return SnapshotEvent{}, 0, true, errors.New("messages 不是非空 JSON 数组")
	}
	return SnapshotEvent{
		ConversationID: strings.TrimSpace(raw.ConversationID),
		UserID:         strings.TrimSpace(raw.UserID),
		MessageID:      strings.TrimSpace(raw.MessageID),
		Version:        int(version),
		Messages:       json.RawMessage(append([]byte(nil), messages...)),
	}, int(version), false, nil
}

func nonEmptyJSONArray(raw []byte) bool {
	if len(raw) == 0 || raw[0] != '[' {
		return false
	}
	var items []json.RawMessage
	return json.Unmarshal(raw, &items) == nil && len(items) > 0
}

func positiveVersion(raw json.RawMessage) (int, error) {
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "null" {
		return 0, errors.New("version 不是正整数")
	}
	number, err := json.Number(text).Int64()
	if err != nil || number <= 0 || number > math.MaxInt32 || text != fmt.Sprintf("%d", number) {
		return 0, fmt.Errorf("version 不是正整数: %s", text)
	}
	return int(number), nil
}

func permanentPostgres(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == "23503"
}

func shanghaiLocation() *time.Location {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("CST", 8*3600)
	}
	return loc
}

func nextCleanupAt(now time.Time) time.Time {
	loc := shanghaiLocation()
	local := now.In(loc)
	next := time.Date(local.Year(), local.Month(), local.Day(), 3, 0, 0, 0, loc)
	if !local.Before(next) {
		next = next.Add(24 * time.Hour)
	}
	return next
}

func cleanupLockTTL(now time.Time) time.Duration {
	loc := shanghaiLocation()
	local := now.In(loc)
	noon := time.Date(local.Year(), local.Month(), local.Day(), 12, 0, 0, 0, loc)
	if !noon.After(local) {
		noon = noon.Add(24 * time.Hour)
	}
	ttl := noon.Sub(local)
	if ttl < time.Minute {
		return time.Minute
	}
	return ttl
}

func (rt *Runtime) cleanup(ctx context.Context) {
	for {
		wait := time.Until(nextCleanupAt(time.Now()))
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		fired := time.Now()
		date := fired.In(shanghaiLocation()).Format("2006-01-02")
		won, err := rt.store.TryExclusive(ctx, "chatlite:cleanup:"+date, cleanupLockTTL(fired))
		if err != nil {
			log.Printf("[context-kafka] cleanup_lock_failed date=%s err=%v", date, err)
			continue
		}
		if !won {
			log.Printf("[context-kafka] cleanup_skipped date=%s", date)
			continue
		}
		log.Printf("[context-kafka] cleanup_started date=%s", date)
		rt.cleanupOnce(ctx)
	}
}

func (rt *Runtime) cleanupOnce(ctx context.Context) {
	now := time.Now().Unix()
	err := rt.store.ForEachContextID(ctx, func(conversationID string) error {
		deleted, err := rt.store.DeleteIdleContext(ctx, conversationID, now, idleSeconds)
		if err != nil {
			log.Printf("[context-kafka] conversation=%s cleanup_failed err=%v", conversationID, err)
			return nil
		}
		if deleted {
			log.Printf("[context-kafka] conversation=%s cleanup_deleted", conversationID)
		}
		return nil
	})
	if err != nil && ctx.Err() == nil {
		log.Printf("[context-kafka] cleanup_scan_failed err=%v", err)
	}
}

func wait(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
