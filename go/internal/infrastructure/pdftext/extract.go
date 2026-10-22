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

func Extract(path string) (string, error) {
	text, err := run(30*time.Second, "pdftotext", "-layout", "-enc", "UTF-8", path, "-")
	if err != nil {
		text = ""
	}
	if runeLen(text) >= MinRunes {
		return strings.TrimSpace(text), nil
	}
	alt, altErr := plumber(path)
	if runeLen(alt) > runeLen(text) {
		text = alt
	}
	text = strings.TrimSpace(text)
	if text == "" && err != nil && altErr != nil {
		return "", err
	}
	return text, nil
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
