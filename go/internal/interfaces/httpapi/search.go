package httpapi

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"chatlite/internal/domain/visibility"
	"chatlite/internal/platform/httpx"
)

const searchPageSize = 30

var (
	mdImageRE = regexp.MustCompile(`!\[([^\]]*)\]\(\s*(?:<[^>]*>|(?:\\.|[^)])*)\s*\)`)
	mdLinkRE  = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
	htmlRE    = regexp.MustCompile(`<[^>]*>`)
	mdLeadRE  = regexp.MustCompile(`(?m)^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+`)
	fenceRE   = regexp.MustCompile("```[^\\n]*\\n?|`")
	markRE    = regexp.MustCompile(`[*_~]`)
	spaceRE   = regexp.MustCompile(`\s+`)
)

type searchItem struct {
	MessageID         string `json:"messageId"`
	ConversationID    string `json:"conversationId"`
	ConversationTitle string `json:"conversationTitle"`
	Role              string `json:"role"`
	Snippet           string `json:"snippet"`
	CreatedAt         string `json:"createdAt"`
}

func (a *App) registerSearch(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/search/messages", a.withAuth(a.searchMessages))
}

func (a *App) searchMessages(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(query) > 200 {
		httpx.Error(w, 400, "搜索内容不能超过 200 个字符")
		return
	}
	rawOffset := r.URL.Query().Get("offset")
	offset := 0
	if rawOffset != "" {
		n, ok := parseNonNeg(rawOffset)
		if !ok {
			httpx.Error(w, 400, "offset 必须是非负整数")
			return
		}
		offset = n
	}
	if query == "" {
		httpx.WriteJSON(w, 200, map[string]any{"items": []any{}, "hasMore": false, "nextOffset": nil})
		return
	}
	user := authFrom(r)
	limit := searchPageSize + 1
	like := "%" + escapeLike(query) + "%"
	prefix := escapeLike(query) + "%"
	rows, err := a.Pool.Query(r.Context(), `SELECT d.message_id, d.conversation_id, c.title, d.role, d.search_text, d.created_at
		FROM message_search_documents d
		JOIN conversations c ON c.id=d.conversation_id
		WHERE d.user_id=$1 AND (
			d.search_text ILIKE $2 ESCAPE '\'
			OR ($3::int >= 3 AND word_similarity($4, d.search_text) > 0.3)
		)
		ORDER BY CASE WHEN d.search_text=$4 THEN 0 WHEN d.search_text ILIKE $5 ESCAPE '\' THEN 1 ELSE 2 END ASC,
			word_similarity($4, d.search_text) DESC, d.created_at DESC, d.message_id DESC
		LIMIT $6 OFFSET $7`, user.UserID, like, utf8.RuneCountInString(query), query, prefix, limit, offset)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	defer rows.Close()
	var items []searchItem
	for rows.Next() {
		var item searchItem
		var text string
		if err := rows.Scan(&item.MessageID, &item.ConversationID, &item.ConversationTitle, &item.Role, &text, &item.CreatedAt); err != nil {
			httpx.Error(w, 500, "服务器错误")
			return
		}
		item.Snippet = makeSnippet(text, query)
		items = append(items, item)
	}
	if items == nil {
		items = []searchItem{}
	}
	hasMore := len(items) > searchPageSize
	if hasMore {
		items = items[:searchPageSize]
	}
	var next any
	if hasMore {
		next = offset + searchPageSize
	}
	httpx.WriteJSON(w, 200, map[string]any{"items": items, "hasMore": hasMore, "nextOffset": next})
}

func parseNonNeg(raw string) (int, bool) {
	if raw == "" {
		return 0, false
	}
	n := 0
	for _, c := range raw {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
	}
	return n, true
}

func escapeLike(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(value)
}

func cleanSearchText(content string) string {
	return strings.TrimSpace(mdImageRE.ReplaceAllString(visibility.StripThinkBlocks(content), "$1"))
}

func plainText(value string) string {
	text := mdImageRE.ReplaceAllString(value, "$1")
	text = mdLinkRE.ReplaceAllString(text, "$1")
	text = htmlRE.ReplaceAllString(text, "")
	text = mdLeadRE.ReplaceAllString(text, "")
	text = fenceRE.ReplaceAllString(text, "")
	text = markRE.ReplaceAllString(text, "")
	text = spaceRE.ReplaceAllString(text, " ")
	return strings.TrimSpace(text)
}

func makeSnippet(searchText, query string) string {
	text := plainText(searchText)
	lower := strings.ToLower(text)
	match := strings.Index(lower, strings.ToLower(query))
	runes := []rune(text)
	matchChar := 0
	if match >= 0 {
		matchChar = utf8.RuneCountInString(text[:match])
	}
	start := matchChar - 60
	if start < 0 {
		start = 0
	}
	end := start + 160
	if end > len(runes) {
		end = len(runes)
	}
	if end == len(runes) {
		start = end - 160
		if start < 0 {
			start = 0
		}
	}
	prefix, suffix := "", ""
	if start > 0 {
		prefix = "..."
	}
	if end < len(runes) {
		suffix = "..."
	}
	return prefix + string(runes[start:end]) + suffix
}

func (a *App) syncSearchDocument(ctx context.Context, messageID string) {
	if a.Pool == nil {
		return
	}
	var role, content, status, userID, conversationID, createdAt string
	err := a.Pool.QueryRow(ctx, `SELECT user_id, conversation_id, role, content, status, created_at FROM messages WHERE id=$1`, messageID).
		Scan(&userID, &conversationID, &role, &content, &status, &createdAt)
	if err != nil || !visibility.IsModelVisible(role, content, status) || (role != "user" && role != "assistant") {
		_, _ = a.Pool.Exec(ctx, `DELETE FROM message_search_documents WHERE message_id=$1`, messageID)
		return
	}
	_, _ = a.Pool.Exec(ctx, `INSERT INTO message_search_documents (message_id,user_id,conversation_id,role,search_text,created_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (message_id) DO UPDATE SET user_id=EXCLUDED.user_id, conversation_id=EXCLUDED.conversation_id, role=EXCLUDED.role, search_text=EXCLUDED.search_text, created_at=EXCLUDED.created_at`,
		messageID, userID, conversationID, role, cleanSearchText(content), createdAt)
}
