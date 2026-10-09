package authsec

import (
	"os"
	"sync"
	"time"
)

type bucket struct {
	count int
	reset time.Time
}

var (
	rateMu      sync.Mutex
	rateBuckets = map[string]*bucket{}
	emailMu     sync.Mutex
	emailBuckets = map[string]time.Time{}
)

func Allow(key string, max int, window time.Duration) bool {
	rateMu.Lock()
	defer rateMu.Unlock()
	now := time.Now()
	current := rateBuckets[key]
	if current == nil || current.reset.Before(now) {
		rateBuckets[key] = &bucket{count: 1, reset: now.Add(window)}
		return true
	}
	current.count++
	return current.count <= max
}

func ReserveEmailCode(email, ip string, window time.Duration) bool {
	emailMu.Lock()
	defer emailMu.Unlock()
	now := time.Now()
	for key, reset := range emailBuckets {
		if !reset.After(now) {
			delete(emailBuckets, key)
		}
	}
	keys := []string{"email:" + email, "ip:" + ip}
	for _, key := range keys {
		if reset, ok := emailBuckets[key]; ok && reset.After(now) {
			return false
		}
	}
	until := now.Add(window)
	for _, key := range keys {
		emailBuckets[key] = until
	}
	return true
}

func SessionTTLDays() int {
	raw := os.Getenv("SESSION_TTL_DAYS")
	if raw == "" {
		return 30
	}
	n := 0
	for _, c := range raw {
		if c < '0' || c > '9' {
			return 30
		}
		n = n*10 + int(c-'0')
	}
	if n <= 0 {
		return 30
	}
	return n
}

func MaxUploadBytes() int64 {
	mb := 5
	if raw := os.Getenv("MAX_UPLOAD_MB"); raw != "" {
		n := 0
		ok := true
		for _, c := range raw {
			if c < '0' || c > '9' {
				ok = false
				break
			}
			n = n*10 + int(c-'0')
		}
		if ok && n > 0 {
			mb = n
		}
	}
	return int64(mb) * 1024 * 1024
}

func MaxUploadLabel() string {
	if raw := os.Getenv("MAX_UPLOAD_MB"); raw != "" {
		return raw + "MB"
	}
	return "5MB"
}

func AllowedImage(mime string) bool {
	switch mime {
	case "image/jpeg", "image/png", "image/webp":
		return true
	default:
		return false
	}
}

func AllowedTable(mime string) bool {
	switch mime {
	case "text/csv", "text/plain", "application/csv", "application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream":
		return true
	default:
		return false
	}
}

const TableUploadMaxBytes int64 = 100 * 1024 * 1024
