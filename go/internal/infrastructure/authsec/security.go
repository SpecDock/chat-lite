package authsec

import (
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"chatlite/config"
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
	if n := config.Current().Server.SessionTTLDays; n > 0 {
		return n
	}
	return 30
}

func MaxUploadBytes() int64 {
	mb := config.Current().Server.MaxUploadMB
	if mb <= 0 {
		mb = 5
	}
	return int64(mb) * 1024 * 1024
}

func MaxUploadLabel() string {
	mb := config.Current().Server.MaxUploadMB
	if mb <= 0 {
		mb = 5
	}
	return strconv.Itoa(mb) + "MB"
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
const PDFUploadMaxBytes int64 = 32 * 1024 * 1024

func AllowedPDF(name, mimeType string) bool {
	if strings.ToLower(filepath.Ext(name)) != ".pdf" {
		return false
	}
	switch strings.ToLower(mimeType) {
	case "", "application/pdf", "application/octet-stream", "application/x-pdf":
		return true
	default:
		return false
	}
}
