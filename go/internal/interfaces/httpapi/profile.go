package httpapi

import (
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"chatlite/internal/application/uploads"
	"chatlite/internal/infrastructure/authsec"
	"chatlite/internal/platform/httpx"
	"chatlite/internal/platform/idgen"
)

func (a *App) registerProfile(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/profile/avatar", a.withAuth(a.profileAvatar))
	mux.HandleFunc("POST /api/profile/password/send-code", a.withAuth(a.profileSendCode))
	mux.HandleFunc("POST /api/profile/password", a.withAuth(a.profilePassword))
}

func (a *App) profileAvatar(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	file, err := readAvatar(r)
	if err != nil {
		status := 400
		if se, ok := err.(*uploads.StatusError); ok {
			status = se.Status
		}
		httpx.Error(w, status, err.Error())
		return
	}
	if len(file.Buffer) > 2*1024*1024 {
		httpx.Error(w, 400, "头像不能超过 2MB")
		return
	}
	att, err := uploads.SaveImageBuffer(r.Context(), a.Pool, user.UserID, file, "", 2*1024*1024, "2MB", "input")
	if err != nil {
		status := 400
		msg := err.Error()
		if se, ok := err.(*uploads.StatusError); ok {
			status = se.Status
			msg = se.Message
		}
		httpx.Error(w, status, msg)
		return
	}
	if _, err = a.Pool.Exec(r.Context(), `UPDATE users SET avatar_attachment_id=$1 WHERE id=$2`, att.ID, user.UserID); err != nil {
		httpx.Error(w, 500, "头像上传失败")
		return
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true, "user": map[string]any{"id": user.UserID, "email": user.Email, "avatar_url": att.PublicPath}})
}

func readAvatar(r *http.Request) (uploads.FileBytes, error) {
	ct := r.Header.Get("Content-Type")
	if !strings.Contains(ct, "multipart/form-data") {
		return uploads.FileBytes{}, &uploads.StatusError{Status: 400, Message: "请使用 multipart/form-data 上传"}
	}
	_, params, err := mime.ParseMediaType(ct)
	if err != nil {
		return uploads.FileBytes{}, &uploads.StatusError{Status: 400, Message: "请使用 multipart/form-data 上传"}
	}
	mr := multipart.NewReader(http.MaxBytesReader(nil, r.Body, 2*1024*1024+4096), params["boundary"])
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			if strings.Contains(err.Error(), "request body too large") || strings.Contains(strings.ToLower(err.Error()), "too large") {
				return uploads.FileBytes{}, &uploads.StatusError{Status: 400, Message: "头像不能超过 2MB"}
			}
			return uploads.FileBytes{}, &uploads.StatusError{Status: 400, Message: "头像上传失败"}
		}
		if part.FormName() != "avatar" {
			continue
		}
		buf, err := io.ReadAll(io.LimitReader(part, 2*1024*1024+1))
		if err != nil {
			return uploads.FileBytes{}, &uploads.StatusError{Status: 400, Message: "头像上传失败"}
		}
		if int64(len(buf)) > 2*1024*1024 {
			return uploads.FileBytes{}, &uploads.StatusError{Status: 400, Message: "头像不能超过 2MB"}
		}
		name := part.FileName()
		if name == "" {
			name = "avatar"
		}
		return uploads.FileBytes{Buffer: buf, Filename: name, MimeType: strings.ToLower(part.Header.Get("Content-Type"))}, nil
	}
	return uploads.FileBytes{}, &uploads.StatusError{Status: 400, Message: "请选择头像图片"}
}

func (a *App) profileSendCode(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	if !authsec.ReserveEmailCode(user.Email, httpx.ClientIP(r), time.Minute) {
		httpx.Error(w, 429, "请求过于频繁，请稍后再试")
		return
	}
	code := emailCode()
	if err := authsec.SendEmailCode(user.Email, code, "password_change"); err != nil {
		httpx.Error(w, 502, err.Error())
		return
	}
	if err := a.insertEmailCode(r, user.Email, emailCodeHash(user.Email, code), "password_change"); err != nil {
		httpx.Error(w, 500, "验证码发送失败")
		return
	}
	httpx.WriteJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) profilePassword(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	body := httpx.ReadJSON(r, 1<<20)
	code := strings.TrimSpace(httpx.AsString(body["code"]))
	newPassword := httpx.AsString(body["newPassword"])
	confirm := httpx.AsString(body["confirmPassword"])
	if len(newPassword) < 8 {
		httpx.Error(w, 400, "新密码至少 8 位")
		return
	}
	if newPassword != confirm {
		httpx.Error(w, 400, "两次新密码不一致")
		return
	}
	rec, err := a.verifyPasswordCode(r, user.Email, "password_change", code, 3)
	if err != nil {
		writeAuthErr(w, err)
		return
	}
	hash, err := authsec.HashPassword(newPassword)
	if err != nil {
		httpx.Error(w, 400, "密码修改失败")
		return
	}
	if _, err = a.Pool.Exec(r.Context(), `UPDATE users SET password_hash=$1 WHERE id=$2`, hash, user.UserID); err != nil {
		httpx.Error(w, 500, "密码修改失败")
		return
	}
	_, _ = a.Pool.Exec(r.Context(), `DELETE FROM sessions WHERE user_id=$1`, user.UserID)
	_, _ = a.Pool.Exec(r.Context(), `UPDATE email_codes SET used_at=$1 WHERE id=$2`, idgen.NowISO(), rec)
	httpx.DeleteCookie(w, httpx.CookieName(), "/")
	httpx.WriteJSON(w, 200, map[string]bool{"ok": true})
}
