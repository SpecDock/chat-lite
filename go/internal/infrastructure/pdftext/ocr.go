package pdftext

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	cmd := exec.Command("pdftoppm", "-jpeg", "-r", "144", "-f", "1", "-l", fmt.Sprint(ocrPageLimit), path, filepath.Join(dir, "page"))
	if out, err := cmd.CombinedOutput(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return "", errors.New("未找到 pdftoppm")
		}
		detail := strings.Join(strings.Fields(string(out)), " ")
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
		return "", errors.New("PDF 没有可识别的页面")
	}
	var parts []string
	for i, page := range pages {
		text, err := recognizePage(cfg, page)
		if err != nil {
			return "", err
		}
		text = strings.TrimSpace(text)
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

func recognizePage(cfg config.Vendor, path string) (string, error) {
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
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, chatURL(cfg.APIURL), bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
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
