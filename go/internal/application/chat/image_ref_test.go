package chat

import (
	"strings"
	"testing"
)

func TestStoredImageRefIsNotBase64(t *testing.T) {
	stored := []any{map[string]any{"role": "user", "content": []any{
		map[string]any{"type": "text", "text": "看这张图"},
		imageRef("att_1"),
	}}}
	out := expandImageRefs(stored, func(id string) map[string]any {
		return map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64," + id}}
	})
	sent := out[0].(map[string]any)["content"].([]any)
	url := sent[1].(map[string]any)["image_url"].(map[string]any)["url"].(string)
	if !strings.Contains(url, "base64,att_1") {
		t.Fatalf("model payload=%s", url)
	}
	kept := stored[0].(map[string]any)["content"].([]any)
	if kept[1].(map[string]any)["type"] != "image_ref" {
		t.Fatal("hydrate changed the stored message")
	}
	if _, ok := kept[1].(map[string]any)["image_url"]; ok {
		t.Fatal("stored message contains image bytes")
	}
}
