package pdftext

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"chatlite/config"
)

const ocrPageLimit = 20
const ocrBudget = 60 * time.Second

func Recognize(path string) (string, error) {
	cfg := config.Current().OCR
	if strings.TrimSpace(cfg.APIURL) == "" || strings.TrimSpace(cfg.APIKey) == "" || strings.TrimSpace(cfg.Model) == "" {
		return "", errors.New("未配置 OCR_BASE_URL、OCR_API_KEY 或 OCR_MODEL")
	}
	dir, err := os.MkdirTemp("", "chatlite-ocr-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	renderCtx, renderCancel := context.WithTimeout(context.Background(), ocrBudget)
	defer renderCancel()
	cmd := exec.CommandContext(renderCtx, "pdftoppm", "-jpeg", "-r", "144", "-f", "1", "-l", fmt.Sprint(ocrPageLimit), path, filepath.Join(dir, "page"))
	if out, err := cmd.CombinedOutput(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			log.Printf("[pdf] stage=pdftoppm outcome=missing")
			return "", errors.New("未找到 pdftoppm")
		}
		detail := strings.Join(strings.Fields(string(out)), " ")
		log.Printf("[pdf] stage=pdftoppm outcome=failed err=%s", Clip(detail, 200))
		if detail == "" {
			return "", errors.New("PDF 转图片失败")
		}
		return "", errors.New("PDF 转图片失败：" + Clip(detail, 200))
	}
	pages, err := filepath.Glob(filepath.Join(dir, "page*.jpg"))
	if err != nil {
		return "", err
	}
	sort.Strings(pages)
	if len(pages) == 0 {
		log.Printf("[pdf] stage=pdftoppm outcome=no-pages")
		return "", errors.New("PDF 没有可识别的页面")
	}
	log.Printf("[pdf] stage=pdftoppm pages=%d", len(pages))
	started := time.Now()
	var parts []string
	for i, page := range pages {
		if message, stop := ocrStop(i, len(pages), started, time.Now()); stop {
			log.Printf("[pdf] stage=ocr outcome=timeout %s", message)
			return "", ocrTimeoutError{message: message}
		}
		text, err := recognizePage(cfg, page, started.Add(ocrBudget))
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				message, _ := ocrStop(i, len(pages), started, started.Add(ocrBudget))
				log.Printf("[pdf] stage=ocr outcome=timeout %s", message)
				return "", ocrTimeoutError{message: message}
			}
			log.Printf("[pdf] stage=ocr-page page=%d outcome=failed err=%s", i+1, errText(err))
			return "", err
		}
		text = strings.TrimSpace(text)
		log.Printf("[pdf] stage=ocr-page page=%d chars=%d", i+1, runeLen(text))
		if text == "" {
			continue
		}
		parts = append(parts, fmt.Sprintf("--- page %d ---\n%s", i+1, text))
		if runeLen(strings.Join(parts, "\n\n")) >= IndexRunes {
			break
		}
	}
	return strings.Join(parts, "\n\n"), nil
}

type ocrTimeoutError struct {
	message string
}

func (e ocrTimeoutError) Error() string { return e.message }

func ocrTimeoutMessage(done, left int, elapsed time.Duration) string {
	eta := left * int(ocrBudget.Seconds())
	if done > 0 && elapsed > 0 {
		eta = int((elapsed * time.Duration(left) / time.Duration(done)).Seconds())
		if left > 0 && eta < 1 {
			eta = 1
		}
	}
	return fmt.Sprintf("正在 OCR 解析 PDF：已完成 %d 页，还剩 %d 页，大约还需要 %d 秒", done, left, eta)
}

func ocrStop(done, total int, started, now time.Time) (string, bool) {
	if now.Before(started.Add(ocrBudget)) {
		return "", false
	}
	left := total - done
	if left < 0 {
		left = 0
	}
	return ocrTimeoutMessage(done, left, now.Sub(started)), true
}

func recognizePage(cfg config.Vendor, path string, deadline time.Time) (string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	payload := map[string]any{
		"model": cfg.Model,
		"messages": []any{map[string]any{
			"role": "user",
			"content": []any{
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(body)}},
				map[string]any{"type": "text", "text": "<image>\nFree OCR."},
			},
		}},
		"temperature": 0,
		"max_tokens":  4096,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, chatURL(cfg.APIURL), bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	timeout := time.Until(deadline)
	if timeout <= 0 {
		return "", context.DeadlineExceeded
	}
	res, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	resp, _ := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP %d %s", res.StatusCode, apiError(resp))
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(resp, &parsed) != nil || len(parsed.Choices) == 0 {
		return "", errors.New("OCR 响应无法解析")
	}
	return parsed.Choices[0].Message.Content, nil
}

func chatURL(base string) string {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if strings.HasSuffix(base, "/chat/completions") {
		return base
	}
	return base + "/chat/completions"
}

func apiError(raw []byte) string {
	var parsed struct {
		Message string `json:"message"`
		Error   struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &parsed) == nil {
		if parsed.Error.Message != "" {
			return Clip(strings.Join(strings.Fields(parsed.Error.Message), " "), 200)
		}
		if parsed.Message != "" {
			return Clip(strings.Join(strings.Fields(parsed.Message), " "), 200)
		}
	}
	return Clip(strings.Join(strings.Fields(string(raw)), " "), 200)
}
