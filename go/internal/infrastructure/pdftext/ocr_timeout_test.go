package pdftext

import (
	"strings"
	"testing"
	"time"
)

func TestOCRProgressDoesNotStopLaterPages(t *testing.T) {
	started := time.Now().Add(-ocrBudget)
	if !ocrProgressDue(started, time.Now()) {
		t.Fatal("60 seconds should be due for a progress update")
	}
	if ocrProgressDue(time.Now(), time.Now()) {
		t.Fatal("a new interval should still continue")
	}
	message := ocrTimeoutMessage(2, 3, ocrBudget)
	if !strings.Contains(message, "已完成 2 页") || !strings.Contains(message, "还剩 3 页") || !strings.Contains(message, "大约还需要") {
		t.Fatalf("message=%s", message)
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
