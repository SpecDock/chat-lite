package chat

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

const fetchBodyLimit = 2 << 20

func fetchPage(ctx context.Context, rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("只接受 http 或 https 网址")
	}
	reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "chat-lite")
	req.Header.Set("Accept", "text/html, text/plain;q=0.9, */*;q=0.1")
	client := &http.Client{CheckRedirect: func(redirect *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return fmt.Errorf("重定向过多")
		}
		if redirect.URL.Scheme != "http" && redirect.URL.Scheme != "https" {
			return fmt.Errorf("只接受 http 或 https 网址")
		}
		return nil
	}}
	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("无法连接：%s", err.Error())
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, fetchBodyLimit+1))
	if err != nil {
		return "", fmt.Errorf("无法连接：%s", err.Error())
	}
	truncated := len(body) > fetchBodyLimit
	if truncated {
		body = body[:fetchBodyLimit]
	}
	if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone {
		return "", fmt.Errorf("页面不存在")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	decoded, err := decodePage(body, res.Header.Get("Content-Type"))
	if err != nil {
		return "", err
	}
	text := decoded
	contentType := strings.ToLower(res.Header.Get("Content-Type"))
	if strings.Contains(contentType, "html") || looksLikeHTML(decoded) {
		text = readableHTML(decoded, res.Request.URL)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("页面没有可读正文")
	}
	if truncated {
		text += "\n页面过大，已截断。"
	}
	return "抓取结果：" + res.Request.URL.String() + "\n" + text, nil
}

func decodePage(body []byte, contentType string) (string, error) {
	reader, err := charset.NewReader(strings.NewReader(string(body)), contentType)
	if err != nil {
		if !utf8.Valid(body) {
			return "", fmt.Errorf("页面编码无法识别")
		}
		return string(body), nil
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func looksLikeHTML(text string) bool {
	sample := strings.ToLower(text)
	return strings.Contains(sample, "<html") || strings.Contains(sample, "<body") || strings.Contains(sample, "<article")
}

func readableHTML(source string, base *url.URL) string {
	root, err := html.Parse(strings.NewReader(source))
	if err != nil {
		return ""
	}
	title := textOf(findTag(root, "title"))
	target := findTag(root, "article")
	if target == nil {
		target = findTag(root, "main")
	}
	if target == nil {
		target = findTag(root, "body")
	}
	if target == nil {
		target = root
	}
	var b strings.Builder
	writeNode(&b, target, base)
	body := collapseText(b.String())
	if title != "" {
		return "标题：" + title + "\n\n" + body
	}
	return body
}

func writeNode(b *strings.Builder, n *html.Node, base *url.URL) {
	if n == nil {
		return
	}
	if n.Type == html.ElementNode {
		switch n.Data {
		case "script", "style", "noscript", "template", "svg":
			return
		case "a":
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				writeNode(b, c, base)
			}
			if href := strings.TrimSpace(attr(n, "href")); href != "" && base != nil {
				if resolved, err := base.Parse(href); err == nil && (resolved.Scheme == "http" || resolved.Scheme == "https") {
					b.WriteString(" (")
					b.WriteString(resolved.String())
					b.WriteString(")")
				}
			}
			return
		}
	}
	if n.Type == html.TextNode {
		b.WriteString(n.Data)
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		writeNode(b, c, base)
	}
	if n.Type == html.ElementNode && isBlock(n.Data) {
		b.WriteByte('\n')
	}
}

func findTag(n *html.Node, tag string) *html.Node {
	if n == nil {
		return nil
	}
	if n.Type == html.ElementNode && n.Data == tag {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if found := findTag(c, tag); found != nil {
			return found
		}
	}
	return nil
}

func textOf(n *html.Node) string {
	if n == nil {
		return ""
	}
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.TextNode {
			b.WriteString(node.Data)
		}
		for c := node.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return strings.Join(strings.Fields(b.String()), " ")
}

func attr(n *html.Node, key string) string {
	for _, item := range n.Attr {
		if item.Key == key {
			return item.Val
		}
	}
	return ""
}

func isBlock(tag string) bool {
	switch tag {
	case "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "br", "section", "article", "main", "blockquote":
		return true
	default:
		return false
	}
}

func collapseText(value string) string {
	var lines []string
	blank := false
	for _, line := range strings.Split(value, "\n") {
		line = strings.Join(strings.Fields(line), " ")
		if line == "" {
			if len(lines) > 0 && !blank {
				lines = append(lines, "")
				blank = true
			}
			continue
		}
		blank = false
		lines = append(lines, line)
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}
