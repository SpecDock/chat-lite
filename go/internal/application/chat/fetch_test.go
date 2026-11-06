package chat

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchKeepsArticleAndLink(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head><title>示例</title><script>secret()</script><style>body{}</style></head><body><nav>导航</nav><article><h1>正文标题</h1><p>你好 <a href="/docs">文档</a></p></article></body></html>`))
	}))
	defer server.Close()
	text, err := fetchPage(context.Background(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "标题：示例") || !strings.Contains(text, "正文标题") || !strings.Contains(text, "你好") {
		t.Fatalf("readable text missing: %s", text)
	}
	if !strings.Contains(text, server.URL+"/docs") {
		t.Fatalf("link missing: %s", text)
	}
	if strings.Contains(text, "secret") || strings.Contains(text, "导航") {
		t.Fatalf("non-article content leaked: %s", text)
	}
}

func TestFetchMissingPage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer server.Close()
	_, err := fetchPage(context.Background(), server.URL)
	if err == nil || !strings.Contains(err.Error(), "页面不存在") {
		t.Fatalf("err = %v", err)
	}
}

func TestFetchLiveExample(t *testing.T) {
	text, err := fetchPage(context.Background(), "https://example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Example Domain") {
		t.Fatalf("live page text = %s", text)
	}
}
