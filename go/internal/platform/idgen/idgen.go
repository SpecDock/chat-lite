package idgen

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"time"
)

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

func NewID(prefix string) string {
	buf := make([]byte, 24)
	random := make([]byte, 24)
	_, _ = rand.Read(random)
	for i := range buf {
		buf[i] = alphabet[int(random[i])%len(alphabet)]
	}
	return prefix + "_" + string(buf)
}

func NewToken() string {
	buf := make([]byte, 32)
	_, _ = rand.Read(buf)
	return base64.RawURLEncoding.EncodeToString(buf)
}

func SHA256(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func NowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func AfterISO(prev string) string {
	now := NowISO()
	if prev == "" || now > prev {
		return now
	}
	t, err := time.Parse("2006-01-02T15:04:05.000Z", prev)
	if err != nil {
		return now
	}
	return t.Add(time.Millisecond).UTC().Format("2006-01-02T15:04:05.000Z")
}
