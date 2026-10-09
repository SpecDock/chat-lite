package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/infrastructure/authsec"
	"chatlite/internal/platform/httpx"
	"chatlite/internal/platform/idgen"
)

type ctxKey int

const authKey ctxKey = 1

type Authed struct {
	UserID    string
	Email     string
	SessionID string
}

type App struct {
	Pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *App {
	return &App{Pool: pool}
}

func (a *App) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, 200, map[string]bool{"ok": true})
	})
	a.registerAuth(mux)
	a.registerProfile(mux)
	a.registerConversations(mux)
	a.registerSearch(mux)
	a.registerChat(mux)
	a.registerUploads(mux)
	a.registerFiles(mux)
	a.registerWorkspace(mux)
	a.registerStudio(mux)
	a.registerUsage(mux)
	a.registerImages(mux)
	a.registerEvents(mux)
}

func (a *App) requirePool(w http.ResponseWriter) (*pgxpool.Pool, bool) {
	if a.Pool == nil {
		httpx.Error(w, 500, "数据库未配置")
		return nil, false
	}
	return a.Pool, true
}

func (a *App) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := a.requirePool(w); !ok {
			return
		}
		user, ok := a.authenticate(w, r)
		if !ok {
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), authKey, user)))
	}
}

func (a *App) rateLimit(max int, window time.Duration, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := httpx.ClientIP(r) + ":" + r.URL.Path
		if !authsec.Allow(key, max, window) {
			httpx.Error(w, 429, "请求过于频繁，请稍后再试")
			return
		}
		next(w, r)
	}
}

func authFrom(r *http.Request) Authed {
	v, _ := r.Context().Value(authKey).(Authed)
	return v
}

func (a *App) authenticate(w http.ResponseWriter, r *http.Request) (Authed, bool) {
	token := httpx.ParseCookies(r.Header.Get("Cookie"))[httpx.CookieName()]
	if token == "" {
		httpx.Error(w, 401, "未登录")
		return Authed{}, false
	}
	var session struct {
		ID        string
		UserID    string
		ExpiresAt string
		Email     string
	}
	err := a.Pool.QueryRow(r.Context(), `SELECT sessions.id, sessions.user_id, sessions.expires_at, users.email
		FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash=$1`, idgen.SHA256(token)).
		Scan(&session.ID, &session.UserID, &session.ExpiresAt, &session.Email)
	if err != nil {
		httpx.Error(w, 401, "登录已过期")
		return Authed{}, false
	}
	expires, parseErr := time.Parse(time.RFC3339, normalizeISO(session.ExpiresAt))
	if parseErr != nil {
		expires, parseErr = time.Parse("2006-01-02T15:04:05.000Z", session.ExpiresAt)
	}
	if parseErr != nil || expires.Before(time.Now()) {
		_, _ = a.Pool.Exec(r.Context(), `DELETE FROM sessions WHERE id=$1`, session.ID)
		httpx.Error(w, 401, "登录已过期")
		return Authed{}, false
	}
	return Authed{UserID: session.UserID, Email: session.Email, SessionID: session.ID}, true
}

func normalizeISO(value string) string {
	if len(value) == 20 && value[19] == 'Z' {
		return value[:19] + ".000Z"
	}
	return value
}
