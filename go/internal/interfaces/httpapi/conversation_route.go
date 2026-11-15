package httpapi

import (
	"net/http"
	"regexp"
	"strings"

	"chatlite/internal/platform/httpx"
)

// Keep this format in sync with idgen.NewID("conv") and the nginx route maps.
var canonicalConversationID = regexp.MustCompile(`^conv_[A-Za-z0-9_-]{24}$`)

// Routing is not authorization: callers must retain their DB ownership checks.
func validateConversationRoute(w http.ResponseWriter, r *http.Request, id string, requireHeader bool) bool {
	if !canonicalConversationID.MatchString(id) {
		httpx.Error(w, http.StatusBadRequest, "会话 ID 格式不正确")
		return false
	}
	values := r.Header.Values("X-Conversation-ID")
	if len(values) > 1 || (len(values) == 0 && requireHeader) || (len(values) == 1 && values[0] != id) {
		httpx.Error(w, http.StatusBadRequest, "X-Conversation-ID 必须与会话 ID 一致")
		return false
	}
	if strings.HasPrefix(r.URL.Path, "/api/conversations/") {
		// Check the original spelling, not the unescaped/cleaned ServeMux path.
		rawPath, _, _ := strings.Cut(r.RequestURI, "?")
		const prefix = "/api/conversations/"
		rawID, _, _ := strings.Cut(strings.TrimPrefix(rawPath, prefix), "/")
		if !strings.HasPrefix(rawPath, prefix) || rawID != id {
			httpx.Error(w, http.StatusBadRequest, "会话 URI 必须使用规范 ID")
			return false
		}
	}
	return true
}

func requireConversationRoute(w http.ResponseWriter, r *http.Request, id string) bool {
	return validateConversationRoute(w, r, id, true)
}
