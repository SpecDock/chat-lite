package pdftext

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"
)

const MinRunes = 80
const InlineRunes = 8000
const IndexRunes = 40000

type Result struct {
	Text    string
	Failure string
}

func Extract(path string) Result {
	text, plumberErr := plumber(path)
	log.Printf("[pdf] stage=pdfplumber chars=%d err=%s", runeLen(text), errText(plumberErr))
	if runeLen(text) < MinRunes {
		alt, err := run(30*time.Second, "pdftotext", "-layout", "-enc", "UTF-8", path, "-")
		use := err == nil && runeLen(alt) > runeLen(text)
		log.Printf("[pdf] stage=pdftotext chars=%d used=%t err=%s", runeLen(alt), use, errText(err))
		if use {
			text = alt
		}
	}
	text = strings.TrimSpace(text)
	if runeLen(text) >= MinRunes {
		log.Printf("[pdf] stage=text-layer chars=%d outcome=enough", runeLen(text))
		return Result{Text: text}
	}
	log.Printf("[pdf] stage=text-layer chars=%d outcome=short", runeLen(text))
	ocrText, err := Recognize(path)
	if err != nil {
		var timeout ocrTimeoutError
		if errors.As(err, &timeout) {
			log.Printf("[pdf] stage=ocr chars=%d outcome=timeout", runeLen(ocrText))
			return Result{Text: text, Failure: timeout.Error()}
		}
		log.Printf("[pdf] stage=ocr chars=%d outcome=failed err=%s", runeLen(ocrText), errText(err))
		return Result{Text: text, Failure: ocrFailure(err)}
	}
	ocrText = strings.TrimSpace(ocrText)
	if ocrText == "" {
		log.Printf("[pdf] stage=ocr chars=0 outcome=empty")
		return Result{Text: text, Failure: "OCR 没有识别出文字"}
	}
	if runeLen(ocrText) > runeLen(text) {
		text = ocrText
	}
	log.Printf("[pdf] stage=ocr chars=%d outcome=ok", runeLen(text))
	return Result{Text: strings.TrimSpace(text)}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return Clip(strings.Join(strings.Fields(err.Error()), " "), 200)
}

func ocrFailure(err error) string {
	msg := strings.Join(strings.Fields(err.Error()), " ")
	if msg == "" {
		msg = "OCR 调用失败"
	}
	return "OCR 调用失败：" + Clip(msg, 300)
}

func run(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func plumber(path string) (string, error) {
	script := `import json, sys
import pdfplumber
path = sys.argv[1]
texts = []
with pdfplumber.open(path) as pdf:
    for i, page in enumerate(pdf.pages, 1):
        text = page.extract_text(x_tolerance=1, y_tolerance=3) or ""
        if text.strip():
            texts.append("--- page %d ---\n%s" % (i, text))
print(json.dumps({"text": "\n\n".join(texts)}, ensure_ascii=False))
`
	for _, python := range []string{"python3", "python"} {
		out, err := run(30*time.Second, python, "-c", script, path)
		if err != nil || strings.TrimSpace(out) == "" {
			continue
		}
		var result struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(out), &result) != nil {
			continue
		}
		if strings.TrimSpace(result.Text) != "" {
			return result.Text, nil
		}
	}
	return "", exec.ErrNotFound
}

func runeLen(text string) int {
	return utf8.RuneCountInString(strings.TrimSpace(text))
}

func Clip(text string, limit int) string {
	runes := []rune(strings.TrimSpace(text))
	if limit <= 0 || len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit])
}
