package chat

import (
	"context"
	"strings"
	"testing"
)

func TestToolStateTextKeepsResultAndRefsNotBase64(t *testing.T) {
	text := ToolStateText([]any{
		map[string]any{"role": "assistant", "tool_calls": []any{
			map[string]any{"function": map[string]any{"name": "view_image", "arguments": `{"attachmentId":"att_1"}`}},
		}},
		map[string]any{"role": "tool", "content": "已加载历史图片 att_1。图片本体已加入上下文"},
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "看图"},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,aaaa"}},
		}},
		map[string]any{"role": "user", "content": "请看 ![image](/api/files/att_9)"},
	})
	if strings.Contains(text, "aaaa") || strings.Contains(text, "base64") {
		t.Fatalf("base64 leaked: %s", text)
	}
	if !strings.Contains(text, "view_image →") || !strings.Contains(text, "att_1") {
		t.Fatalf("missing tool state: %s", text)
	}
	if !strings.Contains(text, "/api/files/att_9") || !strings.Contains(text, "attachmentId=att_1") {
		t.Fatalf("missing refs: %s", text)
	}
}

func TestReadbackRefsKeepCompletePathsAndDedupe(t *testing.T) {
	refs := uniqueReadbackRefs("attachmentId=att_1 attachmentId:att_1 attachmentId=\"att_1\" input/销售表.csv input/销售表.csv")
	if len(refs) != 2 || refs[0] != "attachmentId=att_1" || refs[1] != "input/销售表.csv" {
		t.Fatalf("refs=%v", refs)
	}
	messages := []any{
		map[string]any{"role": "system", "content": "s"},
		map[string]any{"role": "assistant", "tool_calls": []any{
			map[string]any{"id": "call_1", "function": map[string]any{"name": "download_file", "arguments": `{"attachmentId":"att_9"}`}},
		}, "content": ""},
		map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "已在 input/销售表.csv"},
		map[string]any{"role": "user", "content": "继续"},
	}
	out, at := stripStructured(messages, 3)
	if at != 2 {
		t.Fatalf("at=%d", at)
	}
	for _, raw := range out {
		msg := raw.(map[string]any)
		if msg["role"] == "tool" || msg["tool_calls"] != nil {
			t.Fatalf("structure kept: %#v", msg)
		}
	}
	if !strings.Contains(out[1].(map[string]any)["content"].(string), "input/销售表.csv") {
		t.Fatalf("tool text dropped: %#v", out)
	}
	out, at = withReadbackRefs(out, at, collectReadbackRefs(messages))
	blob := renderMessages(out)
	if !strings.Contains(blob, "attachmentId=att_9") || strings.Count(blob, "input/销售表.csv") != 1 {
		t.Fatalf("refs=%s at=%d", blob, at)
	}
}

func TestSplitTokenChunksStayUnderLimit(t *testing.T) {
	text := strings.Repeat("汉", 100)
	chunks := splitTokenChunks(text, 30)
	if len(chunks) != 4 {
		t.Fatalf("chunks=%d", len(chunks))
	}
	if strings.Join(chunks, "") != text {
		t.Fatal("chunks dropped text")
	}
	for _, chunk := range chunks {
		if estimateTokens(chunk) > 30 {
			t.Fatalf("chunk tokens=%d", estimateTokens(chunk))
		}
	}
	ascii := strings.Repeat("a", 40)
	parts := splitTokenChunks(ascii, 5)
	if strings.Join(parts, "") != ascii {
		t.Fatal("ascii chunks dropped text")
	}
	for _, part := range parts {
		if estimateTokens(part) > 5 {
			t.Fatalf("ascii tokens=%d", estimateTokens(part))
		}
	}
}

func TestFitBeforeSendLeavesSmallContext(t *testing.T) {
	messages := []any{
		map[string]any{"role": "system", "content": "s"},
		map[string]any{"role": "user", "content": "你好"},
	}
	out, at, err := fitBeforeSend(context.Background(), messages, 1)
	if err != nil {
		t.Fatal(err)
	}
	if at != 1 || len(out) != 2 {
		t.Fatalf("at=%d len=%d", at, len(out))
	}
	if out[1].(map[string]any)["content"] != "你好" {
		t.Fatalf("content=%v", out[1])
	}
}

func TestPrefixDropsToolProtocolAndKeepsRequestRef(t *testing.T) {
	messages := PrefixMessages("已写入 output/a.py", []HistoryItem{
		{Role: "user", Content: "继续\n\n![image](/api/files/att_2)", Status: "completed"},
		{Role: "assistant", Content: "<think>secret</think>好的", Status: "completed"},
	})
	if len(messages) != 4 {
		t.Fatalf("len=%d", len(messages))
	}
	summary := messages[1].(map[string]any)["content"].(string)
	if !strings.Contains(summary, "output/a.py") || !strings.Contains(summary, "<conversation_history_summary>") {
		t.Fatalf("summary missing: %s", summary)
	}
	user := messages[2].(map[string]any)
	if user["role"] != "user" || !strings.Contains(user["content"].(string), "/api/files/att_2") {
		t.Fatalf("user ref dropped: %#v", user)
	}
	assistant := messages[3].(map[string]any)
	if assistant["role"] != "assistant" || strings.Contains(assistant["content"].(string), "secret") || assistant["content"] != "好的" {
		t.Fatalf("assistant=%#v", assistant)
	}
	for _, message := range messages {
		if _, ok := message.(map[string]any)["tool_calls"]; ok {
			t.Fatal("tool protocol kept")
		}
	}
}
