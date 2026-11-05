package pdftext

import (
	"strings"
	"testing"
	"time"
)

func TestOCRStopsBeforeNextRequest(t *testing.T) {
	started := time.Now().Add(-ocrBudget)
	message, stop := ocrStop(2, 5, started, time.Now())
	if !stop {
		t.Fatal("budget should stop the next request")
	}
	if !strings.Contains(message, "已完成 2 页") || !strings.Contains(message, "还剩 3 页") || !strings.Contains(message, "大约还需要") {
		t.Fatalf("message=%s", message)
	}
	if _, stop := ocrStop(0, 4, time.Now(), time.Now()); stop {
		t.Fatal("a new budget should still send")
	}
}

func TestOCRTimeoutEstimateUsesCompletedPages(t *testing.T) {
	message := ocrTimeoutMessage(2, 3, 40*time.Second)
	if !strings.Contains(message, "大约还需要 60 秒") {
		t.Fatalf("message=%s", message)
	}
	message = ocrTimeoutMessage(0, 4, ocrBudget)
	if !strings.Contains(message, "大约还需要 240 秒") {
		t.Fatalf("message=%s", message)
	}
}
