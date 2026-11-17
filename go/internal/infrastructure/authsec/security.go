package authsec

import (
	"bytes"
	"mime"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"chatlite/config"
)

type bucket struct {
	count int
	reset time.Time
}

var (
	rateMu       sync.Mutex
	rateBuckets  = map[string]*bucket{}
	emailMu      sync.Mutex
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
const TextUploadMaxBytes int64 = 5 * 1024 * 1024

// Text uploads are ordinary attachments, not executable workspace scripts.
// Keep this extension/MIME policy shared by admission, chat and staging.
func textUploadTypes(name string) []string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".txt", ".log":
		return []string{"text/plain"}
	case ".md":
		return []string{"text/markdown", "text/x-markdown"}
	case ".json":
		return []string{"application/json", "text/json"}
	case ".tsv":
		return []string{"text/tab-separated-values", "text/tsv"}
	case ".yaml", ".yml":
		return []string{"application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"}
	case ".xml":
		return []string{"application/xml", "text/xml"}
	case ".py":
		return []string{"text/x-python", "application/x-python", "text/x-script.python"}
	case ".go":
		return []string{"text/x-go"}
	case ".java":
		return []string{"text/x-java-source", "text/x-java"}
	case ".js":
		return []string{"text/javascript", "application/javascript", "application/x-javascript"}
	case ".ts":
		return []string{"text/typescript", "application/typescript", "application/x-typescript"}
	case ".sql":
		return []string{"application/sql", "text/x-sql", "text/sql"}
	case ".sh":
		return []string{"application/x-sh", "application/x-shellscript", "text/x-shellscript", "text/x-sh"}
	case ".html":
		return []string{"text/html"}
	case ".css":
		return []string{"text/css"}
	default:
		return nil
	}
}

func IsTextUploadName(name string) bool {
	return len(textUploadTypes(name)) > 0
}

// TextUploadMIME accepts generic binary/plain-text browser MIME declarations
// only for explicitly whitelisted extensions, and stores a canonical MIME.
func TextUploadMIME(name, mimeType string) (string, bool) {
	types := textUploadTypes(name)
	if len(types) == 0 {
		return "", false
	}
	mimeType = strings.ToLower(strings.TrimSpace(mimeType))
	if mimeType != "" {
		parsed, _, err := mime.ParseMediaType(mimeType)
		if err != nil {
			return "", false
		}
		mimeType = parsed
	}
	if mimeType == "" || mimeType == "text/plain" || mimeType == "application/octet-stream" {
		return types[0], true
	}
	for _, allowed := range types {
		if mimeType == allowed {
			return types[0], true
		}
	}
	return "", false
}

func ValidTextUpload(body []byte) bool {
	return int64(len(body)) <= TextUploadMaxBytes && utf8.Valid(body) && !bytes.ContainsRune(body, 0)
}

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
