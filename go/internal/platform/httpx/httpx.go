package httpx

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
)

func WriteJSON(w http.ResponseWriter, status int, data any) {
	body, err := json.Marshal(data)
	if err != nil {
		http.Error(w, `{"error":"服务器错误"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func Error(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, map[string]string{"error": message})
}

func ReadJSON(r *http.Request, limit int64) map[string]any {
	if limit <= 0 {
		limit = 1 << 20
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, limit))
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil || body == nil {
		return map[string]any{}
	}
	return body
}

func AsString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

func CookieName() string {
	if name := os.Getenv("SESSION_COOKIE_NAME"); name != "" {
		return name
	}
	return "chat_lite_session"
}

func ParseCookies(header string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(header, ";") {
		idx := strings.Index(part, "=")
		if idx > -1 {
			out[strings.TrimSpace(part[:idx])] = decodeCookie(strings.TrimSpace(part[idx+1:]))
		}
	}
	return out
}

func decodeCookie(value string) string {
	decoded, err := url.QueryUnescape(value)
	if err != nil {
		return value
	}
	return decoded
}

func SetCookie(w http.ResponseWriter, name, value string, httpOnly bool, sameSite, path string, secure bool, maxAge *int) {
	if path == "" {
		path = "/"
	}
	parts := []string{name + "=" + url.QueryEscape(value), "Path=" + path}
	if httpOnly {
		parts = append(parts, "HttpOnly")
	}
	if sameSite != "" {
		parts = append(parts, "SameSite="+sameSite)
	}
	if secure {
		parts = append(parts, "Secure")
	}
	if maxAge != nil {
		parts = append(parts, "Max-Age="+strconv.Itoa(*maxAge))
	}
	w.Header().Add("Set-Cookie", strings.Join(parts, "; "))
}

func DeleteCookie(w http.ResponseWriter, name, path string) {
	zero := 0
	SetCookie(w, name, "", false, "", path, false, &zero)
}

func SecureCookie() bool {
	return os.Getenv("NODE_ENV") == "production"
}

func ClientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return strings.TrimSpace(strings.Split(fwd, ",")[0])
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > -1 {
		return host[:i]
	}
	if host == "" {
		return "local"
	}
	return host
}

func CORS(next http.Handler) http.Handler {
	origin := os.Getenv("APP_ORIGIN")
	if origin == "" {
		origin = "http://localhost:5173"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api") {
			if r.Header.Get("Origin") == origin {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Vary", "Origin")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "content-type")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
