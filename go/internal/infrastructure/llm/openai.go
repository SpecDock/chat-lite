package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type Usage struct {
	Model                     string
	PromptTokens              int
	CompletionTokens          int
	TotalTokens               int
	CacheMeasuredPromptTokens *int
	CachedTokens              *int
}

type ToolCall struct {
	ID        string
	Name      string
	Arguments string
}

type Delta struct {
	Text             string
	ToolCalls        []ToolCall
	Usage            *Usage
	ReasoningContent string
	Finish           string
}

func APIKey() string {
	if v := os.Getenv("MODEL_API_KEY"); v != "" {
		return v
	}
	return os.Getenv("OPENAI_API_KEY")
}

func BaseURL() string {
	if v := os.Getenv("MODEL_BASE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	if v := os.Getenv("OPENAI_BASE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "https://api.openai.com/v1"
}

func ModelName() string {
	if v := os.Getenv("MODEL_NAME"); v != "" {
		return v
	}
	if v := os.Getenv("OPENAI_MODEL"); v != "" {
		return v
	}
	return "gpt-4o-mini"
}

func Temperature() float64 {
	raw := os.Getenv("MODEL_TEMPERATURE")
	if raw == "" {
		return 0.3
	}
	n, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0.3
	}
	return n
}

func MaxAttempts() int {
	raw := strings.TrimSpace(os.Getenv("MODEL_MAX_ATTEMPTS"))
	n := 2
	if raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			n = parsed
		}
	}
	if n < 1 {
		n = 1
	}
	if n > 3 {
		n = 3
	}
	return n
}

func Stream(ctx context.Context, body map[string]any, replay map[string]string) (*bufio.Reader, func(), error) {
	res, err := post(ctx, body, replay, true)
	if err != nil {
		return nil, nil, err
	}
	return bufio.NewReader(res.Body), func() { res.Body.Close() }, nil
}

func Complete(ctx context.Context, body map[string]any) (map[string]any, error) {
	res, err := post(ctx, body, nil, false)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func post(ctx context.Context, body map[string]any, replay map[string]string, stream bool) (*http.Response, error) {
	if APIKey() == "" {
		return nil, fmt.Errorf("未配置模型 API Key：请设置 MODEL_API_KEY 或 OPENAI_API_KEY")
	}
	cloned := cloneMap(body)
	applyReplay(cloned, replay)
	payload := cloned
	cacheUnsupported := false
	if transformed, err := TransformPromptCacheBody(cloned); err == nil {
		payload = transformed
	} else {
		cacheUnsupported = true
	}
	res, err := do(ctx, payload)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return res, nil
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !cacheUnsupported && ExplicitCacheUnsupported(res.StatusCode, string(raw)) {
		res, err = do(ctx, cloned)
		if err != nil {
			return nil, err
		}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return res, nil
		}
		raw, _ = io.ReadAll(res.Body)
		res.Body.Close()
	}
	return nil, &HTTPError{Status: res.StatusCode, Body: string(raw)}
}

func do(ctx context.Context, body map[string]any) (*http.Response, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, BaseURL()+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+APIKey())
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 0}
	return client.Do(req)
}

type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("模型调用失败 HTTP %d", e.Status)
}

func cloneMap(body map[string]any) map[string]any {
	raw, _ := json.Marshal(body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}

func applyReplay(body map[string]any, replay map[string]string) {
	if len(replay) == 0 {
		return
	}
	messages, _ := body["messages"].([]any)
	for _, item := range messages {
		message, _ := item.(map[string]any)
		if message["role"] != "assistant" {
			continue
		}
		key := replayKey(message["content"], message["tool_calls"])
		if reasoning, ok := replay[key]; ok {
			message["reasoning_content"] = reasoning
		}
	}
}

func ReplayKey(content, toolCalls any) string {
	return replayKey(content, toolCalls)
}

func replayKey(content, toolCalls any) string {
	raw, _ := json.Marshal(map[string]any{"content": content, "tool_calls": toolCalls})
	return string(raw)
}

func ReadDeltas(reader *bufio.Reader) ([]Delta, error) {
	var calls = map[int]*ToolCall{}
	var order []int
	var text strings.Builder
	var reasoning strings.Builder
	var usage *Usage
	var finish string
	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "data:") {
				data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				if data == "[DONE]" {
					break
				}
				var chunk map[string]any
				if json.Unmarshal([]byte(data), &chunk) == nil {
					if u := usageFrom(chunk); u != nil {
						usage = u
					}
					choices, _ := chunk["choices"].([]any)
					if len(choices) > 0 {
						choice, _ := choices[0].(map[string]any)
						if fr, _ := choice["finish_reason"].(string); fr != "" {
							finish = fr
						}
						delta, _ := choice["delta"].(map[string]any)
						if delta != nil {
							if content, _ := delta["content"].(string); content != "" {
								text.WriteString(content)
							}
							if rc, _ := delta["reasoning_content"].(string); rc != "" {
								reasoning.WriteString(rc)
							}
							if tcs, ok := delta["tool_calls"].([]any); ok {
								for _, item := range tcs {
									call, _ := item.(map[string]any)
									index := 0
									switch n := call["index"].(type) {
									case float64:
										index = int(n)
									case json.Number:
										v, _ := n.Int64()
										index = int(v)
									}
									current := calls[index]
									if current == nil {
										current = &ToolCall{}
										calls[index] = current
										order = append(order, index)
									}
									if id, _ := call["id"].(string); id != "" {
										current.ID = id
									}
									fn, _ := call["function"].(map[string]any)
									if name, _ := fn["name"].(string); name != "" {
										current.Name += name
									}
									if args, _ := fn["arguments"].(string); args != "" {
										current.Arguments += args
									}
								}
							}
						}
					}
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			if text.Len() > 0 || len(calls) > 0 {
				return []Delta{{Text: text.String(), ToolCalls: ordered(calls, order), Usage: usage, ReasoningContent: reasoning.String(), Finish: finish}}, err
			}
			return nil, err
		}
	}
	return []Delta{{Text: text.String(), ToolCalls: ordered(calls, order), Usage: usage, ReasoningContent: reasoning.String(), Finish: finish}}, nil
}

func ordered(calls map[int]*ToolCall, order []int) []ToolCall {
	out := make([]ToolCall, 0, len(order))
	for _, index := range order {
		if call := calls[index]; call != nil {
			out = append(out, *call)
		}
	}
	return out
}

func usageFrom(chunk map[string]any) *Usage {
	raw, _ := chunk["usage"].(map[string]any)
	if raw == nil {
		return nil
	}
	prompt := num(raw["prompt_tokens"])
	completion := num(raw["completion_tokens"])
	total := num(raw["total_tokens"])
	if total == 0 {
		total = prompt + completion
	}
	usage := &Usage{Model: stringOf(chunk["model"]), PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total}
	if details, ok := raw["prompt_tokens_details"].(map[string]any); ok {
		cached := num(details["cached_tokens"])
		usage.CacheMeasuredPromptTokens = &prompt
		usage.CachedTokens = &cached
	} else if prompt > 0 || raw["prompt_tokens"] != nil {
		zero := 0
		usage.CacheMeasuredPromptTokens = &prompt
		usage.CachedTokens = &zero
	}
	if usage.Model == "" {
		usage.Model = ModelName()
	}
	return usage
}

func num(v any) int {
	switch t := v.(type) {
	case float64:
		if t < 0 {
			return 0
		}
		return int(t + 0.5)
	case json.Number:
		n, _ := t.Float64()
		if n < 0 {
			return 0
		}
		return int(n + 0.5)
	default:
		return 0
	}
}

func stringOf(v any) string {
	s, _ := v.(string)
	return s
}

func RetryDelay(kind string) time.Duration {
	if kind == "rate_limit" {
		return 500 * time.Millisecond
	}
	return 300*time.Millisecond + time.Duration(time.Now().UnixNano()%500)*time.Millisecond
}
