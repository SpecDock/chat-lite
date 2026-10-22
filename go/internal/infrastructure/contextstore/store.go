package contextstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const lockPX = 30000

var renewScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`)

var unlockScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`)

var saveCASScript = redis.NewScript(`
local key = KEYS[1]
local expected = tonumber(ARGV[1])
local updated = ARGV[2]
local messages = ARGV[3]
if expected == nil then
  return {0, 0}
end
local function build(version)
  return string.format('{"version":%d,"updated_unix":%s,"messages":%s}', version, updated, messages)
end
local raw = redis.call("GET", key)
if raw == false then
  if expected < 0 then
    return {0, 0}
  end
  local created = expected + 1
  redis.call("SET", key, build(created))
  return {created, 1}
end
local ok, doc = pcall(cjson.decode, raw)
if not ok or type(doc) ~= "table" then
  return redis.error_reply("contextstore: 上下文 JSON 无法解析")
end
local stored = tonumber(doc["version"])
if stored == nil or stored ~= expected then
  return {0, 0}
end
local newVersion = expected + 1
redis.call("SET", key, build(newVersion))
	return {newVersion, 1}
`)

var cleanupScript = redis.NewScript(`
local ctxKey = KEYS[1]
local lockKey = KEYS[2]
local dbKey = KEYS[3]
local now = tonumber(ARGV[1])
local idle = tonumber(ARGV[2])
if now == nil or idle == nil then
  return 0
end
if redis.call("EXISTS", lockKey) == 1 then
  return 0
end
local raw = redis.call("GET", ctxKey)
if raw == false then
  return 0
end
local ok, doc = pcall(cjson.decode, raw)
if not ok or type(doc) ~= "table" then
  return 0
end
local version = tonumber(doc["version"])
local updated = tonumber(doc["updated_unix"])
if version == nil or updated == nil then
  return 0
end
local dbv = redis.call("GET", dbKey)
if dbv == false then
  return 0
end
local stored = tonumber(dbv)
if stored == nil or stored ~= version then
  return 0
end
if now - updated < idle then
  return 0
end
redis.call("DEL", ctxKey)
return 1
`)

var (
	ErrSessionBusy       = errors.New("会话正在生成")
	ErrLockTokenMismatch = errors.New("会话锁令牌不符")
)

type Store struct {
	rdb *redis.Client
}

type document struct {
	Version     int             `json:"version"`
	UpdatedUnix int64           `json:"updated_unix"`
	Messages    json.RawMessage `json:"messages"`
}

func Open(addr, password string, db int) (*Store, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       db,
	})
	return &Store{rdb: rdb}, nil
}

func (s *Store) TryExclusive(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	rdb, err := s.client()
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(key) == "" {
		return false, errors.New("contextstore: 锁键为空")
	}
	if ttl < time.Millisecond {
		ttl = time.Millisecond
	}
	token, err := newToken()
	if err != nil {
		return false, err
	}
	reply, err := rdb.Do(ctx, "SET", key, token, "NX", "PX", ttl.Milliseconds()).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return replyOK(reply), nil
}

func (s *Store) Ping(ctx context.Context) error {
	rdb, err := s.client()
	if err != nil {
		return err
	}
	return rdb.Ping(ctx).Err()
}

func (s *Store) Lock(ctx context.Context, conversationID string) (string, error) {
	rdb, err := s.ready(conversationID)
	if err != nil {
		return "", err
	}
	token, err := newToken()
	if err != nil {
		return "", err
	}
	reply, err := rdb.Do(ctx, "SET", lockKey(conversationID), token, "NX", "PX", lockPX).Result()
	if errors.Is(err, redis.Nil) {
		return "", ErrSessionBusy
	}
	if err != nil {
		return "", err
	}
	if !replyOK(reply) {
		return "", ErrSessionBusy
	}
	return token, nil
}

func (s *Store) Renew(ctx context.Context, conversationID, token string) error {
	rdb, err := s.ready(conversationID)
	if err != nil {
		return err
	}
	n, err := renewScript.Run(ctx, rdb, []string{lockKey(conversationID)}, token, lockPX).Int()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrLockTokenMismatch
	}
	return nil
}

func (s *Store) Unlock(ctx context.Context, conversationID, token string) error {
	rdb, err := s.ready(conversationID)
	if err != nil {
		return err
	}
	n, err := unlockScript.Run(ctx, rdb, []string{lockKey(conversationID)}, token).Int()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrLockTokenMismatch
	}
	return nil
}

func (s *Store) Load(ctx context.Context, conversationID string) (version int, updatedUnix int64, messages json.RawMessage, ok bool, err error) {
	rdb, err := s.ready(conversationID)
	if err != nil {
		return 0, 0, nil, false, err
	}
	raw, err := rdb.Get(ctx, ctxKey(conversationID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return 0, 0, nil, false, nil
	}
	if err != nil {
		return 0, 0, nil, false, err
	}
	var doc document
	if err := json.Unmarshal(raw, &doc); err != nil {
		return 0, 0, nil, false, err
	}
	return doc.Version, doc.UpdatedUnix, doc.Messages, true, nil
}

func (s *Store) SaveCAS(ctx context.Context, conversationID string, expectedVersion int, updatedUnix int64, messages json.RawMessage) (newVersion int, ok bool, err error) {
	rdb, err := s.ready(conversationID)
	if err != nil {
		return 0, false, err
	}
	msg, err := normalizeMessages(messages)
	if err != nil {
		return 0, false, err
	}
	reply, err := saveCASScript.Run(
		ctx,
		rdb,
		[]string{ctxKey(conversationID)},
		expectedVersion,
		strconv.FormatInt(updatedUnix, 10),
		string(msg),
	).Slice()
	if err != nil {
		return 0, false, err
	}
	if len(reply) != 2 {
		return 0, false, errors.New("contextstore: SaveCAS 返回异常")
	}
	newVersion, okVersion := asInt(reply[0])
	flag, okFlag := asInt(reply[1])
	if !okVersion || !okFlag {
		return 0, false, errors.New("contextstore: SaveCAS 返回异常")
	}
	if flag != 1 {
		return 0, false, nil
	}
	return newVersion, true, nil
}

func (s *Store) Warm(ctx context.Context, conversationID string, version int, updatedUnix int64, messages json.RawMessage) error {
	rdb, err := s.ready(conversationID)
	if err != nil {
		return err
	}
	payload, err := marshalDocument(version, updatedUnix, messages)
	if err != nil {
		return err
	}
	_, err = rdb.Do(ctx, "SET", ctxKey(conversationID), payload, "NX").Result()
	if errors.Is(err, redis.Nil) {
		return nil
	}
	return err
}

func (s *Store) client() (*redis.Client, error) {
	if s == nil || s.rdb == nil {
		return nil, errors.New("contextstore: redis 未初始化")
	}
	return s.rdb, nil
}

func (s *Store) ready(conversationID string) (*redis.Client, error) {
	if strings.TrimSpace(conversationID) == "" {
		return nil, errors.New("contextstore: conversationID 为空")
	}
	return s.client()
}

func lockKey(conversationID string) string {
	return "chatlite:lock:" + conversationID
}

func ctxKey(conversationID string) string {
	return "chatlite:ctx:" + conversationID
}

func dbKey(conversationID string) string {
	return "chatlite:ctxdb:" + conversationID
}

func conversationIDFromKey(key string) (string, bool) {
	const prefix = "chatlite:ctx:"
	if strings.HasPrefix(key, "chatlite:ctxdb:") || !strings.HasPrefix(key, prefix) {
		return "", false
	}
	id := strings.TrimPrefix(key, prefix)
	if id == "" {
		return "", false
	}
	return id, true
}

func newToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func normalizeMessages(messages json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(messages)
	if len(trimmed) == 0 {
		return json.RawMessage("[]"), nil
	}
	if !json.Valid(trimmed) {
		return nil, errors.New("contextstore: messages 不是合法 JSON")
	}
	return trimmed, nil
}

func marshalDocument(version int, updatedUnix int64, messages json.RawMessage) ([]byte, error) {
	msg, err := normalizeMessages(messages)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(document{
		Version:     version,
		UpdatedUnix: updatedUnix,
		Messages:    msg,
	}); err != nil {
		return nil, err
	}
	return bytes.TrimSpace(buf.Bytes()), nil
}

func replyOK(reply any) bool {
	switch v := reply.(type) {
	case string:
		return v == "OK"
	case []byte:
		return string(v) == "OK"
	default:
		return false
	}
}

func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case int64:
		return int(n), true
	case int:
		return n, true
	case string:
		i, err := strconv.Atoi(n)
		return i, err == nil
	default:
		return 0, false
	}
}

func (s *Store) DBVersion(ctx context.Context, conversationID string) (int, bool, error) {
	rdb, err := s.ready(conversationID)
	if err != nil {
		return 0, false, err
	}
	val, err := rdb.Get(ctx, dbKey(conversationID)).Result()
	if errors.Is(err, redis.Nil) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(val))
	if err != nil {
		return 0, false, errors.New("contextstore: ctxdb 不是整数")
	}
	return n, true, nil
}

func (s *Store) SetDBVersion(ctx context.Context, conversationID string, version int) error {
	if version <= 0 {
		return errors.New("contextstore: ctxdb 版本必须为正整数")
	}
	rdb, err := s.ready(conversationID)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, dbKey(conversationID), strconv.Itoa(version), 0).Err()
}

func (s *Store) ForEachContextID(ctx context.Context, fn func(string) error) error {
	rdb, err := s.client()
	if err != nil {
		return err
	}
	iter := rdb.Scan(ctx, 0, "chatlite:ctx:*", 100).Iterator()
	for iter.Next(ctx) {
		id, ok := conversationIDFromKey(iter.Val())
		if !ok {
			continue
		}
		if err := fn(id); err != nil {
			return err
		}
	}
	return iter.Err()
}

func (s *Store) DeleteIdleContext(ctx context.Context, conversationID string, nowUnix, idleSeconds int64) (bool, error) {
	rdb, err := s.ready(conversationID)
	if err != nil {
		return false, err
	}
	n, err := cleanupScript.Run(ctx, rdb, []string{ctxKey(conversationID), lockKey(conversationID), dbKey(conversationID)}, nowUnix, idleSeconds).Int()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}
