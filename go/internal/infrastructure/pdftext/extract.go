package pdftext

import (
	"context"
	"encoding/json"
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
	text, _ := plumber(path)
	if runeLen(text) < MinRunes {
		if alt, err := run(30*time.Second, "pdftotext", "-layout", "-enc", "UTF-8", path, "-"); err == nil && runeLen(alt) > runeLen(text) {
			text = alt
		}
	}
	text = strings.TrimSpace(text)
	if runeLen(text) >= MinRunes {
		return Result{Text: text}
	}
	ocrText, err := Recognize(path)
	if err != nil {
		return Result{Text: text, Failure: ocrFailure(err)}
	}
	ocrText = strings.TrimSpace(ocrText)
	if ocrText == "" {
		return Result{Text: text, Failure: "OCR 没有识别出文字"}
	}
	if runeLen(ocrText) > runeLen(text) {
		text = ocrText
	}
	return Result{Text: strings.TrimSpace(text)}
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
