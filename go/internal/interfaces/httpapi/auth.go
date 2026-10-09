package httpapi

import (
	"crypto/rand"
	"errors"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"chatlite/internal/infrastructure/authsec"
	"chatlite/internal/platform/httpx"
	"chatlite/internal/platform/idgen"
)

var emailRE = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

type authError struct {
	status int
	msg    string
}

func (e *authError) Error() string { return e.msg }

type userDTO struct {
	ID        string  `json:"id"`
	Email     string  `json:"email"`
	CreatedAt string  `json:"created_at,omitempty"`
	AvatarURL *string `json:"avatar_url"`
}

type captcha struct {
	hash    string
	expires time.Time
}

var (
	captchaMu sync.Mutex
	captchas  = map[string]captcha{}
)

func (a *App) registerAuth(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/password-captcha", a.passwordCaptcha)
	mux.HandleFunc("POST /api/auth/password/send-code", a.passwordSendCode)
	mux.HandleFunc("POST /api/auth/password/reset", a.passwordReset)
	mux.HandleFunc("POST /api/auth/send-code", a.rateLimit(5, 10*time.Minute, a.sendRegisterCode))
	mux.HandleFunc("POST /api/auth/register", a.rateLimit(10, 10*time.Minute, a.register))
	mux.HandleFunc("POST /api/auth/login", a.rateLimit(20, 10*time.Minute, a.login))
	mux.HandleFunc("POST /api/auth/logout", a.withAuth(a.logout))
	mux.HandleFunc("GET /api/auth/me", a.withAuth(a.me))
}

func normalizeEmail(v any) string {
	return strings.ToLower(strings.TrimSpace(httpx.AsString(v)))
}

func (a *App) passwordCaptcha(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, 200, createPasswordCaptcha())
}

func createPasswordCaptcha() map[string]string {
	pruneCaptchas()
	opN, _ := rand.Int(rand.Reader, big.NewInt(2))
	operator := "+"
	if opN.Int64() == 1 {
		operator = "-"
	}
	var left, right, answer int
	if operator == "+" {
		left = randRange(10, 90)
		right = randRange(10, 100-left)
		answer = left + right
	} else {
		left = randRange(10, 100)
		right = randRange(10, left+1)
		answer = left - right
	}
	id := idgen.NewID("captcha")
	captchaMu.Lock()
	captchas[id] = captcha{hash: idgen.SHA256(strconv.Itoa(answer)), expires: time.Now().Add(5 * time.Minute)}
	captchaMu.Unlock()
	return map[string]string{"challengeId": id, "expression": strconv.Itoa(left) + " " + operator + " " + strconv.Itoa(right)}
}

func randRange(min, maxExclusive int) int {
	if maxExclusive <= min {
		return min
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(maxExclusive-min)))
	if err != nil {
		return min
	}
	return min + int(n.Int64())
}

func pruneCaptchas() {
	captchaMu.Lock()
	defer captchaMu.Unlock()
	now := time.Now()
	for id, item := range captchas {
		if !item.expires.After(now) {
			delete(captchas, id)
		}
	}
}

func assertPasswordCaptcha(challengeID string, answer any) error {
	captchaMu.Lock()
	item, ok := captchas[challengeID]
	delete(captchas, challengeID)
	captchaMu.Unlock()
	if !ok || !item.expires.After(time.Now()) || captchaAnswerHash(answer) != item.hash {
		return &authError{400, "算术验证码无效或已过期"}
	}
	return nil
}

func captchaAnswerHash(value any) string {
	answer := strings.TrimSpace(httpx.AsString(value))
	if answer == "" || strings.IndexFunc(answer, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return ""
	}
	n, err := strconv.Atoi(answer)
	if err != nil || n < 0 || n > 99 {
		return ""
	}
	return idgen.SHA256(strconv.Itoa(n))
}

func (a *App) passwordSendCode(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requirePool(w); !ok {
		return
	}
	body := httpx.ReadJSON(r, 1<<20)
	email := normalizeEmail(body["email"])
	if err := a.sendPasswordResetCode(r, email, strings.TrimSpace(httpx.AsString(body["challengeId"])), body["captchaAnswer"]); err != nil {
		writeAuthErr(w, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) passwordReset(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requirePool(w); !ok {
		return
	}
	body := httpx.ReadJSON(r, 1<<20)
	email := normalizeEmail(body["email"])
	if err := a.resetPassword(r, email, strings.TrimSpace(httpx.AsString(body["code"])), httpx.AsString(body["newPassword"]), httpx.AsString(body["confirmPassword"])); err != nil {
		writeAuthErr(w, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) sendRegisterCode(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requirePool(w); !ok {
		return
	}
	body := httpx.ReadJSON(r, 1<<20)
	email := normalizeEmail(body["email"])
	if err := a.dispatchRegisterCode(r, email, strings.TrimSpace(httpx.AsString(body["inviteCode"]))); err != nil {
		writeAuthErr(w, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) register(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requirePool(w); !ok {
		return
	}
	body := httpx.ReadJSON(r, 1<<20)
	email := normalizeEmail(body["email"])
	result, err := a.registerUser(r, email, httpx.AsString(body["password"]), strings.TrimSpace(httpx.AsString(body["code"])), strings.TrimSpace(httpx.AsString(body["inviteCode"])))
	if err != nil {
		writeAuthErr(w, err)
		return
	}
	sendAuthSession(w, result)
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requirePool(w); !ok {
		return
	}
	body := httpx.ReadJSON(r, 1<<20)
	result, err := a.loginUser(r, normalizeEmail(body["email"]), httpx.AsString(body["password"]))
	if err != nil {
		writeAuthErr(w, err)
		return
	}
	sendAuthSession(w, result)
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	_, _ = a.Pool.Exec(r.Context(), `DELETE FROM sessions WHERE id=$1`, user.SessionID)
	httpx.DeleteCookie(w, httpx.CookieName(), "/")
	httpx.WriteJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) me(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	dto, err := a.userDTO(r, user.UserID, user.Email)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	httpx.WriteJSON(w, 200, map[string]any{"user": dto})
}

type sessionResult struct {
	token string
	user  userDTO
	ttl   int
}

func sendAuthSession(w http.ResponseWriter, result sessionResult) {
	maxAge := result.ttl * 86400
	httpx.SetCookie(w, httpx.CookieName(), result.token, true, "Lax", "/", httpx.SecureCookie(), &maxAge)
	httpx.WriteJSON(w, 200, map[string]any{"user": result.user})
}

func writeAuthErr(w http.ResponseWriter, err error) {
	var ae *authError
	if errors.As(err, &ae) {
		httpx.Error(w, ae.status, ae.msg)
		return
	}
	msg := "请求失败"
	if err != nil {
		msg = err.Error()
	}
	httpx.Error(w, 400, msg)
}

func assertEmail(email string) error {
	if !emailRE.MatchString(email) {
		return &authError{400, "邮箱格式不正确"}
	}
	return nil
}

func assertInvite(code string) error {
	invite := osGetenv("INVITE_CODE")
	if invite == "" || code != invite {
		return &authError{400, "邀请码无效"}
	}
	return nil
}

func (a *App) userDTO(r *http.Request, userID, email string) (userDTO, error) {
	var created string
	var avatar *string
	err := a.Pool.QueryRow(r.Context(), `SELECT created_at, avatar_attachment_id FROM users WHERE id=$1`, userID).Scan(&created, &avatar)
	dto := userDTO{ID: userID, Email: email}
	if err == nil {
		dto.CreatedAt = created
		if avatar != nil && *avatar != "" {
			url := "/api/files/" + *avatar
			dto.AvatarURL = &url
		}
	}
	return dto, nil
}

func (a *App) issueSession(r *http.Request, userID, email string) (sessionResult, error) {
	token := idgen.NewToken()
	ttl := authsec.SessionTTLDays()
	expires := time.Now().Add(time.Duration(ttl) * 24 * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
	_, err := a.Pool.Exec(r.Context(), `INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES ($1,$2,$3,$4,$5)`,
		idgen.NewID("sess"), userID, idgen.SHA256(token), expires, idgen.NowISO())
	if err != nil {
		return sessionResult{}, err
	}
	dto, err := a.userDTO(r, userID, email)
	if err != nil {
		return sessionResult{}, err
	}
	return sessionResult{token: token, user: dto, ttl: ttl}, nil
}

func (a *App) dispatchRegisterCode(r *http.Request, email, invite string) error {
	if err := assertEmail(email); err != nil {
		return err
	}
	if err := assertInvite(invite); err != nil {
		return err
	}
	code := emailCode()
	if err := authsec.SendEmailCode(email, code, "register"); err != nil {
		return &authError{502, err.Error()}
	}
	return a.insertEmailCode(r, email, emailCodeHash(email, code), "register")
}

func (a *App) sendPasswordResetCode(r *http.Request, email, challengeID string, answer any) error {
	if err := assertEmail(email); err != nil {
		return err
	}
	if err := assertPasswordCaptcha(challengeID, answer); err != nil {
		return err
	}
	var id string
	err := a.Pool.QueryRow(r.Context(), `SELECT id FROM users WHERE email=$1`, email).Scan(&id)
	if err != nil || id == "" {
		return &authError{404, "该邮箱未注册"}
	}
	if !authsec.ReserveEmailCode(email, httpx.ClientIP(r), time.Minute) {
		return &authError{429, "请求过于频繁，请稍后再试"}
	}
	code := emailCode()
	if err := authsec.SendEmailCode(email, code, "password_reset"); err != nil {
		return &authError{502, err.Error()}
	}
	return a.insertEmailCode(r, email, emailCodeHash(email, code), "password_reset")
}

func (a *App) resetPassword(r *http.Request, email, code, newPassword, confirm string) error {
	if err := assertEmail(email); err != nil {
		return err
	}
	if err := assertNewPassword(newPassword, confirm); err != nil {
		return err
	}
	var userID string
	if err := a.Pool.QueryRow(r.Context(), `SELECT id FROM users WHERE email=$1`, email).Scan(&userID); err != nil || userID == "" {
		return &authError{404, "该邮箱未注册"}
	}
	rec, err := a.verifyPasswordCode(r, email, "password_reset", code, 3)
	if err != nil {
		return err
	}
	hash, err := authsec.HashPassword(newPassword)
	if err != nil {
		return err
	}
	if _, err = a.Pool.Exec(r.Context(), `UPDATE users SET password_hash=$1 WHERE id=$2`, hash, userID); err != nil {
		return err
	}
	if _, err = a.Pool.Exec(r.Context(), `DELETE FROM sessions WHERE user_id=$1`, userID); err != nil {
		return err
	}
	_, err = a.Pool.Exec(r.Context(), `UPDATE email_codes SET used_at=$1 WHERE id=$2`, idgen.NowISO(), rec)
	return err
}

func (a *App) registerUser(r *http.Request, email, password, code, invite string) (sessionResult, error) {
	if err := assertEmail(email); err != nil {
		return sessionResult{}, err
	}
	if len(password) < 8 {
		return sessionResult{}, &authError{400, "密码至少 8 位"}
	}
	if err := assertInvite(invite); err != nil {
		return sessionResult{}, err
	}
	rec, err := a.latestCode(r, email, "register")
	if err != nil {
		return sessionResult{}, err
	}
	if rec == nil || rec.UsedAt != nil || parseTime(rec.ExpiresAt).Before(time.Now()) {
		return sessionResult{}, &authError{400, "验证码无效或已过期"}
	}
	if rec.Attempts >= 5 {
		return sessionResult{}, &authError{400, "验证码尝试次数过多"}
	}
	if _, err = a.Pool.Exec(r.Context(), `UPDATE email_codes SET attempts=attempts+1 WHERE id=$1`, rec.ID); err != nil {
		return sessionResult{}, err
	}
	if rec.CodeHash != emailCodeHash(email, code) {
		return sessionResult{}, &authError{400, "验证码错误"}
	}
	hash, err := authsec.HashPassword(password)
	if err != nil {
		return sessionResult{}, err
	}
	id := idgen.NewID("user")
	now := idgen.NowISO()
	_, err = a.Pool.Exec(r.Context(), `INSERT INTO users (id,email,password_hash,email_verified_at,created_at) VALUES ($1,$2,$3,$4,$5)`, id, email, hash, now, now)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return sessionResult{}, &authError{409, "该邮箱已注册"}
		}
		return sessionResult{}, &authError{409, "该邮箱已注册"}
	}
	_, _ = a.Pool.Exec(r.Context(), `UPDATE email_codes SET used_at=$1 WHERE id=$2`, idgen.NowISO(), rec.ID)
	return a.issueSession(r, id, email)
}

func (a *App) loginUser(r *http.Request, email, password string) (sessionResult, error) {
	var id, hash, storedEmail string
	err := a.Pool.QueryRow(r.Context(), `SELECT id, password_hash, email FROM users WHERE email=$1`, email).Scan(&id, &hash, &storedEmail)
	if err != nil || !authsec.VerifyPassword(hash, password) {
		return sessionResult{}, &authError{401, "邮箱或密码错误"}
	}
	return a.issueSession(r, id, storedEmail)
}

type emailCodeRow struct {
	ID        string
	CodeHash  string
	ExpiresAt string
	Attempts  int
	UsedAt    *string
}

func (a *App) latestCode(r *http.Request, email, purpose string) (*emailCodeRow, error) {
	var row emailCodeRow
	err := a.Pool.QueryRow(r.Context(), `SELECT id, code_hash, expires_at, attempts, used_at FROM email_codes WHERE email=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, email, purpose).
		Scan(&row.ID, &row.CodeHash, &row.ExpiresAt, &row.Attempts, &row.UsedAt)
	if err != nil {
		return nil, nil
	}
	return &row, nil
}

func (a *App) verifyPasswordCode(r *http.Request, email, purpose, code string, maxAttempts int) (string, error) {
	rec, err := a.latestCode(r, email, purpose)
	if err != nil {
		return "", err
	}
	if rec == nil || rec.UsedAt != nil || !parseTime(rec.ExpiresAt).After(time.Now()) {
		return "", &authError{400, "验证码无效或已过期"}
	}
	if rec.Attempts >= maxAttempts {
		return "", &authError{400, "验证码尝试次数过多"}
	}
	if _, err = a.Pool.Exec(r.Context(), `UPDATE email_codes SET attempts=attempts+1 WHERE id=$1`, rec.ID); err != nil {
		return "", err
	}
	if rec.CodeHash != emailCodeHash(email, code) {
		return "", &authError{400, "验证码错误"}
	}
	return rec.ID, nil
}

func (a *App) insertEmailCode(r *http.Request, email, hash, purpose string) error {
	expires := time.Now().Add(10 * time.Minute).UTC().Format("2006-01-02T15:04:05.000Z")
	_, err := a.Pool.Exec(r.Context(), `INSERT INTO email_codes (id,email,code_hash,purpose,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		idgen.NewID("code"), email, hash, purpose, expires, idgen.NowISO())
	return err
}

func emailCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(900000))
	if err != nil {
		return "100000"
	}
	return strconv.Itoa(100000 + int(n.Int64()))
}

func emailCodeHash(email, code string) string {
	return idgen.SHA256(email + ":" + code)
}

func assertNewPassword(newPassword, confirm string) error {
	if len(newPassword) < 8 {
		return &authError{400, "新密码至少 8 位"}
	}
	if newPassword != confirm {
		return &authError{400, "两次新密码不一致"}
	}
	return nil
}

func parseTime(value string) time.Time {
	t, err := time.Parse("2006-01-02T15:04:05.000Z", value)
	if err != nil {
		t, err = time.Parse(time.RFC3339Nano, value)
	}
	if err != nil {
		return time.Time{}
	}
	return t
}

func osGetenv(key string) string {
	return strings.TrimSpace(os.Getenv(key))
}
