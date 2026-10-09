package llm

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
)

var (
	cacheFieldRE = regexp.MustCompile(`(?i)prompt_cache_(?:key|options|breakpoint)`)
	unsupportedRE = regexp.MustCompile(`(?i)\b(?:unknown|unrecognized|unsupported|unexpected)\b|not\s+(?:recognized|supported)|extra inputs are not permitted`)
)

func TransformPromptCacheBody(body map[string]any) (map[string]any, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	var transformed map[string]any
	if err := json.Unmarshal(raw, &transformed); err != nil {
		return nil, err
	}
	clearBreakpoints(transformed)
	messages, _ := transformed["messages"].([]any)
	if messages == nil {
		return nil, errString("Prompt cache requires a messages array")
	}
	var stable map[string]any
	var stableText map[string]any
	for _, item := range messages {
		message, _ := item.(map[string]any)
		role, _ := message["role"].(string)
		if role != "system" && role != "developer" {
			continue
		}
		content, ok := message["content"].([]any)
		if !ok {
			return nil, errString("Prompt cache requires system/developer content blocks")
		}
		for _, block := range content {
			obj, _ := block.(map[string]any)
			if obj["type"] == "text" {
				if _, ok := obj["text"].(string); ok {
					stable = message
					stableText = obj
					break
				}
			}
		}
		if stableText != nil {
			break
		}
	}
	if stable == nil || stableText == nil {
		return nil, errString("Prompt cache requires a stable system text block")
	}
	stableText["prompt_cache_breakpoint"] = map[string]any{"mode": "explicit"}
	stableText["__stable"] = true
	var dynamic map[string]any
	for i := len(messages) - 1; i >= 0 && dynamic == nil; i-- {
		message, _ := messages[i].(map[string]any)
		if message == nil {
			continue
		}
		role, _ := message["role"].(string)
		if role != "user" && role != "assistant" && role != "tool" && role != "system" && role != "developer" {
			continue
		}
		if text, ok := message["content"].(string); ok {
			message["content"] = []any{map[string]any{"type": "text", "text": text}}
		}
		content, ok := message["content"].([]any)
		if !ok {
			continue
		}
		for j := len(content) - 1; j >= 0; j-- {
			block, _ := content[j].(map[string]any)
			if block == nil || block["__stable"] == true {
				continue
			}
			typ, _ := block["type"].(string)
			if typ == "text" || typ == "image_url" || typ == "input_audio" || typ == "file" || typ == "refusal" {
				dynamic = block
				break
			}
		}
	}
	if dynamic == nil {
		return nil, errString("Prompt cache messages have no dynamic cacheable block")
	}
	delete(stableText, "__stable")
	dynamic["prompt_cache_breakpoint"] = map[string]any{"mode": "explicit"}
	transformed["prompt_cache_options"] = map[string]any{"mode": "explicit", "ttl": "30m"}
	text, _ := stableText["text"].(string)
	transformed["prompt_cache_key"] = promptCacheKey(transformed, text)
	return transformed, nil
}

func promptCacheKey(body map[string]any, stable string) string {
	payload := canonicalize(map[string]any{"version": 1, "model": body["model"], "stableSystemText": stable, "tools": body["tools"]})
	raw, _ := json.Marshal(payload)
	sum := sha256.Sum256(raw)
	return "chat-lite-" + hex.EncodeToString(sum[:])[:24]
}

func canonicalize(value any) any {
	switch typed := value.(type) {
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = canonicalize(item)
		}
		return out
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out := map[string]any{}
		for _, key := range keys {
			out[key] = canonicalize(typed[key])
		}
		return out
	default:
		return value
	}
}

func clearBreakpoints(value any) {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			clearBreakpoints(item)
		}
	case map[string]any:
		delete(typed, "prompt_cache_breakpoint")
		for _, child := range typed {
			clearBreakpoints(child)
		}
	}
}

func ExplicitCacheUnsupported(status int, body string) bool {
	if status != 400 && status != 422 {
		return false
	}
	return cacheFieldRE.MatchString(body) && unsupportedRE.MatchString(body)
}

type errString string

func (e errString) Error() string { return string(e) }
