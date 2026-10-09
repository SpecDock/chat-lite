package rag

import (
	"strings"
	"unicode/utf8"
)

type Chunk struct {
	Text       string
	ParentText string
	Type       string
	Importance float64
}

const (
	childSize     = 200
	childOverlap  = 50
	parentSize    = 800
	parentOverlap = 100
)

var separators = []string{"\n## ", "\n### ", "\n#### ", "\n# ", "\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", "；", "; ", "，", ", ", " ", ""}

func runeLen(text string) int { return utf8.RuneCountInString(text) }

func runes(text string) []rune { return []rune(text) }

func tailRunes(text string, count int) string {
	rs := runes(text)
	if len(rs) <= count {
		return text
	}
	return string(rs[len(rs)-count:])
}

func hardSplit(text string, size int) []string {
	rs := runes(text)
	var out []string
	for i := 0; i < len(rs); i += size {
		end := i + size
		if end > len(rs) {
			end = len(rs)
		}
		out = append(out, string(rs[i:end]))
	}
	return out
}

func splitKeepingSep(text, separator string) []string {
	parts := strings.Split(text, separator)
	if len(parts) <= 1 {
		return parts
	}
	out := []string{parts[0]}
	for _, part := range parts[1:] {
		out = append(out, separator+part)
	}
	return out
}

func recursiveSplit(text string, size int, seps []string) []string {
	if runeLen(text) <= size {
		if strings.TrimSpace(text) != "" {
			return []string{text}
		}
		return nil
	}
	if len(seps) == 0 || seps[0] == "" {
		return hardSplit(text, size)
	}
	var out []string
	for _, part := range splitKeepingSep(text, seps[0]) {
		if runeLen(part) <= size {
			if strings.TrimSpace(part) != "" {
				out = append(out, part)
			}
			continue
		}
		out = append(out, recursiveSplit(part, size, seps[1:])...)
	}
	return out
}

func mergePieces(pieces []string, size, overlap int) []string {
	var merged []string
	buffer := ""
	for _, piece := range pieces {
		if buffer == "" {
			buffer = piece
			continue
		}
		if runeLen(buffer)+runeLen(piece) <= size {
			buffer += piece
			continue
		}
		merged = append(merged, buffer)
		buffer = piece
	}
	if buffer != "" {
		merged = append(merged, buffer)
	}
	if overlap <= 0 || len(merged) < 2 {
		return merged
	}
	out := make([]string, len(merged))
	for i, piece := range merged {
		if i == 0 {
			out[i] = piece
			continue
		}
		out[i] = tailRunes(merged[i-1], overlap) + piece
	}
	return out
}

func splitText(text string, size, overlap int) []string {
	var out []string
	for _, piece := range mergePieces(recursiveSplit(text, size, separators), size, overlap) {
		piece = strings.TrimSpace(piece)
		if piece != "" {
			out = append(out, piece)
		}
	}
	return out
}

func CleanForIndexing(text string, maxChars int) string {
	if text == "" {
		return ""
	}
	cleaned := thinkOpenRE.ReplaceAllString(text, "")
	cleaned = imageMDRE.ReplaceAllString(cleaned, "")
	cleaned = fenceBlockRE.ReplaceAllString(cleaned, " ")
	cleaned = tagRE.ReplaceAllString(cleaned, " ")
	cleaned = trailingSpaceRE.ReplaceAllString(cleaned, "\n")
	cleaned = leadingSpaceRE.ReplaceAllString(cleaned, "\n")
	cleaned = multiSpaceRE.ReplaceAllString(cleaned, " ")
	cleaned = multiNLRE.ReplaceAllString(cleaned, "\n\n")
	cleaned = strings.TrimSpace(cleaned)
	if runeLen(cleaned) > maxChars {
		cleaned = string(runes(cleaned)[:maxChars])
	}
	return cleaned
}

func SplitIndexedChunks(text string) []Chunk {
	cleaned := strings.TrimSpace(text)
	if cleaned == "" {
		return nil
	}
	var chunks []Chunk
	for _, parent := range splitText(cleaned, parentSize, parentOverlap) {
		for _, child := range splitText(parent, childSize, childOverlap) {
			chunks = append(chunks, Chunk{Text: child, ParentText: parent, Type: "text", Importance: 0.5})
		}
	}
	return chunks
}
