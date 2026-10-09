package visibility

import "regexp"

var (
	thinkRE         = regexp.MustCompile(`(?s)<think>[\s\S]*?</think>`)
	executionRE     = regexp.MustCompile(`(?s)<chat-lite-execution v="1">[\s\S]*?</chat-lite-execution>`)
	imageMarkdownRE = regexp.MustCompile(`!\[[^\]]*\]\([^\s)]+\)`)
)

var failedPlaceholders = map[string]struct{}{
	"当前主模型额度不足或认证失败，请更换可用的模型 API Key 后再试。": {},
	"当前主模型连接被中断（上游服务不稳定或请求超时）。已自动尝试 2 次仍失败，请稍后重试。": {},
	"当前主模型调用失败，请稍后重试。": {},
	"主模型未返回正文，请尝试重新提问或调整描述。": {},
}

func StripThinkBlocks(text string) string {
	return trim(executionRE.ReplaceAllString(thinkRE.ReplaceAllString(text, ""), ""))
}

func trim(s string) string {
	i, j := 0, len(s)
	for i < j && (s[i] == ' ' || s[i] == '\n' || s[i] == '\t' || s[i] == '\r') {
		i++
	}
	for j > i && (s[j-1] == ' ' || s[j-1] == '\n' || s[j-1] == '\t' || s[j-1] == '\r') {
		j--
	}
	return s[i:j]
}

func IsModelVisible(role, content, status string) bool {
	if role == "user" {
		return true
	}
	if role != "assistant" || status == "error" || status == "streaming" {
		return false
	}
	visible := StripThinkBlocks(content)
	if visible == "" || isFailed(content) {
		return false
	}
	if status == "interrupted" && visible == "已取消" {
		return false
	}
	return len(visible) > 0 || imageMarkdownRE.MatchString(content)
}

func isFailed(content string) bool {
	_, ok := failedPlaceholders[StripThinkBlocks(content)]
	return ok
}
