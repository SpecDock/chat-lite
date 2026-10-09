package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"chatlite/internal/application/uploads"
	"chatlite/internal/infrastructure/authsec"
	"chatlite/internal/platform/httpx"
	"chatlite/internal/platform/idgen"
	"chatlite/internal/platform/paths"
)

func (a *App) registerUploads(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/upload", a.withAuth(a.upload))
}

func (a *App) registerFiles(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/files/{attachmentId}", a.withAuth(a.file))
}

func (a *App) registerWorkspace(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/conversations/{id}/workspace", a.withAuth(a.workspace))
	mux.HandleFunc("GET /api/conversations/{id}/workspace/files/{bucket}/{name}", a.withAuth(a.workspaceFile))
}

func (a *App) registerUsage(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/usage", a.withAuth(a.usage))
}

func (a *App) registerImages(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/images/generate", a.withAuth(a.generateImage))
}

func (a *App) upload(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	file, fields, err := readUpload(r, user.UserID)
	if err != nil {
		httpx.Error(w, statusOfUpload(err), err.Error())
		return
	}
	conversationID := strings.TrimSpace(fields["conversationId"])
	if file.image != nil {
		if conversationID != "" {
			exists, err := uploads.UserConversationExists(r.Context(), a.Pool, conversationID, user.UserID)
			if err != nil {
				httpx.Error(w, 500, "服务器错误")
				return
			}
			if !exists {
				httpx.Error(w, 404, "会话不存在")
				return
			}
		}
		att, err := uploads.SaveImageBuffer(r.Context(), a.Pool, user.UserID, *file.image, conversationID, authsec.MaxUploadBytes(), authsec.MaxUploadLabel(), "input")
		if err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		httpx.WriteJSON(w, 200, map[string]any{"attachment": att})
		return
	}
	if file.table != nil {
		att, err := a.saveTable(r, user.UserID, conversationID, *file.table)
		if file.table.temp != "" {
			_ = os.Remove(file.table.temp)
		}
		if err != nil {
			httpx.Error(w, statusOfUpload(err), err.Error())
			return
		}
		httpx.WriteJSON(w, 200, map[string]any{"attachment": att})
		return
	}
	httpx.Error(w, 400, "请上传图片或 CSV/XLSX 文件")
}

type parsedUpload struct {
	image *uploads.FileBytes
	table *tableUpload
}
type tableUpload struct {
	temp, name, mime string
	size             int64
}

func readUpload(r *http.Request, userID string) (parsedUpload, map[string]string, error) {
	ct := r.Header.Get("Content-Type")
	if !strings.Contains(ct, "multipart/form-data") {
		return parsedUpload{}, nil, &uploads.StatusError{400, "请使用 multipart/form-data 上传"}
	}
	_, params, err := mime.ParseMediaType(ct)
	if err != nil {
		return parsedUpload{}, nil, &uploads.StatusError{400, "请使用 multipart/form-data 上传"}
	}
	mr := multipart.NewReader(r.Body, params["boundary"])
	fields := map[string]string{}
	var parsed parsedUpload
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return parsedUpload{}, fields, &uploads.StatusError{400, "上传失败"}
		}
		if part.FileName() == "" {
			buf, _ := io.ReadAll(io.LimitReader(part, 1<<20))
			fields[part.FormName()] = string(buf)
			continue
		}
		if part.FormName() != "file" {
			_, _ = io.Copy(io.Discard, part)
			continue
		}
		name := safeName(part.FileName())
		mimeType := strings.ToLower(part.Header.Get("Content-Type"))
		if authsec.AllowedImage(mimeType) {
			buf, _ := io.ReadAll(io.LimitReader(part, authsec.MaxUploadBytes()+1))
			if int64(len(buf)) > authsec.MaxUploadBytes() {
				return parsedUpload{}, fields, &uploads.StatusError{400, "图片不能超过 " + authsec.MaxUploadLabel()}
			}
			parsed.image = &uploads.FileBytes{Buffer: buf, Filename: name, MimeType: mimeType}
			continue
		}
		if !isTableName(name, mimeType) {
			_, _ = io.Copy(io.Discard, part)
			return parsedUpload{}, fields, &uploads.StatusError{400, "仅支持 jpeg/png/webp 图片或 CSV/XLSX 文件"}
		}
		dir := filepath.Join(paths.UploadDir(), userID)
		_ = os.MkdirAll(dir, 0o755)
		temp := filepath.Join(dir, "."+idgen.NewID("upload")+".part")
		out, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return parsedUpload{}, fields, err
		}
		n, err := io.Copy(out, io.LimitReader(part, authsec.TableUploadMaxBytes+1))
		out.Close()
		if err != nil || n > authsec.TableUploadMaxBytes {
			_ = os.Remove(temp)
			return parsedUpload{}, fields, &uploads.StatusError{413, "表格文件不能超过 100MB"}
		}
		parsed.table = &tableUpload{temp: temp, name: name, mime: mimeType, size: n}
	}
	return parsed, fields, nil
}

func isTableName(name, mimeType string) bool {
	lower := strings.ToLower(name)
	return (strings.HasSuffix(lower, ".csv") || strings.HasSuffix(lower, ".xlsx")) && authsec.AllowedTable(mimeType)
}

func safeName(value string) string {
	value = filepath.Base(strings.ReplaceAll(value, "\\", "/"))
	value = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r == 0 || r == '\r' || r == '\n' {
			return -1
		}
		return r
	}, value))
	if len([]rune(value)) > 180 {
		value = string([]rune(value)[:180])
	}
	if value == "" {
		return "upload"
	}
	return value
}

func (a *App) saveTable(r *http.Request, userID, conversationID string, file tableUpload) (uploads.Attachment, error) {
	exists, err := uploads.UserConversationExists(r.Context(), a.Pool, conversationID, userID)
	if err != nil {
		return uploads.Attachment{}, err
	}
	if conversationID == "" || !exists {
		return uploads.Attachment{}, &uploads.StatusError{404, "会话不存在"}
	}
	if !isTableName(file.name, file.mime) {
		return uploads.Attachment{}, &uploads.StatusError{400, "仅支持 CSV 或 XLSX 文件"}
	}
	info, err := os.Stat(file.temp)
	if err != nil || info.Size() != file.size || file.size < 1 || file.size > authsec.TableUploadMaxBytes {
		return uploads.Attachment{}, &uploads.StatusError{400, "上传文件校验失败"}
	}
	if err = paths.EnsureConversationWorkspace(conversationID); err != nil {
		return uploads.Attachment{}, err
	}
	id := idgen.NewID("att")
	ext := ".csv"
	if strings.HasSuffix(strings.ToLower(file.name), ".xlsx") {
		ext = ".xlsx"
	}
	dest := filepath.Join(paths.ConversationInputDir(conversationID), id+ext)
	if err = os.Rename(file.temp, dest); err != nil {
		data, readErr := os.ReadFile(file.temp)
		if readErr != nil {
			return uploads.Attachment{}, err
		}
		if writeErr := os.WriteFile(dest, data, 0o644); writeErr != nil {
			return uploads.Attachment{}, writeErr
		}
		_ = os.Remove(file.temp)
	}
	file.temp = ""
	created := idgen.NowISO()
	_, err = a.Pool.Exec(r.Context(), `INSERT INTO attachments (id,user_id,conversation_id,original_name,file_path,public_path,mime_type,size,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, userID, conversationID, file.name, dest, "/api/files/"+id, file.mime, file.size, created)
	if err != nil {
		_ = os.Remove(dest)
		return uploads.Attachment{}, err
	}
	return uploads.Attachment{ID: id, OriginalName: file.name, PublicPath: "/api/files/" + id, MimeType: file.mime, Size: file.size, CreatedAt: created}, nil
}

func statusOfUpload(err error) int {
	if se, ok := err.(*uploads.StatusError); ok {
		return se.Status
	}
	return 400
}

func (a *App) file(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	var path, mimeType string
	var name *string
	err := a.Pool.QueryRow(r.Context(), `SELECT file_path, mime_type, original_name FROM attachments WHERE id=$1 AND user_id=$2`, r.PathValue("attachmentId"), user.UserID).Scan(&path, &mimeType, &name)
	if err != nil {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	buf, err := os.ReadFile(path)
	if err != nil {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	label := "download"
	if name != nil && *name != "" {
		label = *name
	}
	disposition := "inline"
	if r.URL.Query().Get("download") == "1" {
		disposition = "attachment; filename*=UTF-8''" + urlQuery(label)
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(200)
	_, _ = w.Write(buf)
}

func (a *App) workspace(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	id := r.PathValue("id")
	exists, err := a.conversationExists(r.Context(), id, user.UserID)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	if !exists {
		httpx.Error(w, 404, "会话不存在")
		return
	}
	_ = paths.EnsureConversationWorkspace(id)
	rows, err := a.Pool.Query(r.Context(), `SELECT id, original_name, mime_type, size, created_at, file_path FROM attachments WHERE user_id=$1 AND conversation_id=$2`, user.UserID, id)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	type row struct {
		id, name, mime, created, path string
		size                          int64
	}
	byPath := map[string]row{}
	for rows.Next() {
		var item row
		var name *string
		if err := rows.Scan(&item.id, &name, &item.mime, &item.size, &item.created, &item.path); err == nil {
			if name != nil {
				item.name = *name
			}
			byPath[filepath.Clean(item.path)] = item
		}
	}
	rows.Close()
	result := map[string]any{"conversationId": id, "input": []any{}, "output": []any{}}
	for _, bucket := range []string{"input", "output"} {
		dir := paths.ConversationInputDir(id)
		if bucket == "output" {
			dir = paths.ConversationOutputDir(id)
		}
		entries, _ := os.ReadDir(dir)
		var files []map[string]any
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			info, err := os.Lstat(path)
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			att, ok := byPath[filepath.Clean(path)]
			if !ok {
				continue
			}
			url := "/api/files/" + urlQuery(att.id)
			item := map[string]any{"name": att.name, "mimeType": att.mime, "size": att.size, "createdAt": att.created, "bucket": bucket, "attachmentId": att.id, "url": url, "downloadUrl": url + "?download=1"}
			if att.name == "" {
				item["name"] = entry.Name()
			}
			if strings.HasPrefix(att.mime, "image/") {
				item["previewUrl"] = url
			}
			files = append(files, item)
		}
		if files == nil {
			files = []map[string]any{}
		}
		result[bucket] = files
	}
	httpx.WriteJSON(w, 200, map[string]any{"workspace": result})
}

func (a *App) workspaceFile(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	id := r.PathValue("id")
	bucket := r.PathValue("bucket")
	name := r.PathValue("name")
	if !paths.IsSafeWorkspaceID(id) || (bucket != "input" && bucket != "output") || name == "" || filepath.Base(name) != name {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	exists, err := a.conversationExists(r.Context(), id, user.UserID)
	if err != nil || !exists {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	dir := paths.ConversationInputDir(id)
	if bucket == "output" {
		dir = paths.ConversationOutputDir(id)
	}
	path := filepath.Join(dir, name)
	if !paths.IsWithinDirectory(dir, path) {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	var mimeType string
	var original *string
	var size int64
	err = a.Pool.QueryRow(r.Context(), `SELECT mime_type, original_name, size FROM attachments WHERE user_id=$1 AND conversation_id=$2 AND file_path=$3`, user.UserID, id, path).Scan(&mimeType, &original, &size)
	if err != nil {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	fileName := name
	if original != nil && *original != "" {
		fileName = *original
	}
	disposition := "inline"
	if r.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	http.ServeFile(w, r, path)
	_ = mimeType
	_ = size
	_ = disposition
	_ = fileName
}

func (a *App) usage(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	var inputTotal, outputTotal, cachedTotal int64
	err := a.Pool.QueryRow(r.Context(), `SELECT COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), COALESCE(SUM(cached_tokens),0) FROM token_usage WHERE user_id=$1`, user.UserID).Scan(&inputTotal, &outputTotal, &cachedTotal)
	if err != nil {
		httpx.Error(w, 500, err.Error())
		return
	}
	rows, err := a.Pool.Query(r.Context(), `SELECT substring(created_at from 1 for 10) AS date,
		COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), COALESCE(SUM(cached_tokens),0),
		COALESCE(SUM(CASE WHEN cache_measured_prompt_tokens IS NOT NULL THEN prompt_tokens ELSE 0 END),0),
		COUNT(cache_measured_prompt_tokens)
		FROM token_usage WHERE user_id=$1 GROUP BY substring(created_at from 1 for 10) ORDER BY date DESC LIMIT 7`, user.UserID)
	if err != nil {
		httpx.Error(w, 500, err.Error())
		return
	}
	type day struct {
		Date        string   `json:"date"`
		Label       string   `json:"label"`
		InputValue  int64    `json:"inputValue"`
		OutputValue int64    `json:"outputValue"`
		CachedValue int64    `json:"cachedValue"`
		CacheRate   *float64 `json:"cacheRate"`
		Value       int64    `json:"value"`
	}
	var tokenDays []day
	for rows.Next() {
		var item day
		var measured int64
		var measuredCount int64
		if err := rows.Scan(&item.Date, &item.InputValue, &item.OutputValue, &item.CachedValue, &measured, &measuredCount); err != nil {
			continue
		}
		item.Label = labelDate(item.Date)
		item.Value = item.InputValue + item.OutputValue
		if measuredCount > 0 && measured > 0 {
			rate := float64(item.CachedValue) / float64(measured) * 100
			item.CacheRate = &rate
		}
		tokenDays = append(tokenDays, item)
	}
	rows.Close()
	for i, j := 0, len(tokenDays)-1; i < j; i, j = i+1, j-1 {
		tokenDays[i], tokenDays[j] = tokenDays[j], tokenDays[i]
	}
	if tokenDays == nil {
		tokenDays = []day{}
	}
	var imageTotal float64
	_ = a.Pool.QueryRow(r.Context(), `SELECT COALESCE(SUM(cost_units),0) FROM image_usage WHERE user_id=$1`, user.UserID).Scan(&imageTotal)
	irows, err := a.Pool.Query(r.Context(), `SELECT substring(created_at from 1 for 10), COALESCE(SUM(cost_units),0) FROM image_usage WHERE user_id=$1 GROUP BY 1 ORDER BY 1 DESC LIMIT 7`, user.UserID)
	if err != nil {
		httpx.Error(w, 500, err.Error())
		return
	}
	var imageDays []map[string]any
	for irows.Next() {
		var date string
		var value float64
		if err := irows.Scan(&date, &value); err == nil {
			imageDays = append(imageDays, map[string]any{"date": date, "label": labelDate(date), "value": value})
		}
	}
	irows.Close()
	for i, j := 0, len(imageDays)-1; i < j; i, j = i+1, j-1 {
		imageDays[i], imageDays[j] = imageDays[j], imageDays[i]
	}
	if imageDays == nil {
		imageDays = []map[string]any{}
	}
	httpx.WriteJSON(w, 200, map[string]any{
		"token": map[string]any{"inputTotal": inputTotal, "outputTotal": outputTotal, "cachedTotal": cachedTotal, "days": tokenDays, "total": inputTotal + outputTotal},
		"image": map[string]any{"total": imageTotal, "days": imageDays},
	})
}

func labelDate(date string) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return date
	}
	return itoa(int(t.Month())) + "月" + itoa(t.Day()) + "日"
}

func (a *App) generateImage(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	body := httpx.ReadJSON(r, 1<<20)
	prompt := strings.TrimSpace(httpx.AsString(body["prompt"]))
	conversationID := strings.TrimSpace(httpx.AsString(body["conversationId"]))
	if prompt == "" {
		httpx.Error(w, 400, "提示词不能为空")
		return
	}
	if conversationID == "" {
		httpx.Error(w, 400, "conversationId不能为空")
		return
	}
	exists, err := a.conversationExists(r.Context(), conversationID, user.UserID)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	if !exists {
		httpx.Error(w, 404, "会话不存在")
		return
	}
	source := strings.TrimSpace(firstString(body["sourceAttachmentId"], body["attachmentId"]))
	genID := idgen.NewID("img")
	model := os.Getenv("TEXT_IMAGE_MODEL")
	if source != "" {
		model = os.Getenv("IMAGE_EDIT_MODEL")
	}
	_, _ = a.Pool.Exec(r.Context(), `INSERT INTO image_generations (id,user_id,prompt,model,status,created_at) VALUES ($1,$2,$3,$4,'running',$5)`, genID, user.UserID, prompt, model, idgen.NowISO())
	var image uploads.FileBytes
	if source != "" {
		image, err = a.editImage(r.Context(), user.UserID, conversationID, prompt, source)
	} else {
		image, err = textImage(r.Context(), prompt)
	}
	if err != nil {
		_, _ = a.Pool.Exec(r.Context(), `UPDATE image_generations SET status='failed', error=$1 WHERE id=$2 AND user_id=$3`, err.Error(), genID, user.UserID)
		httpx.Error(w, 502, err.Error())
		return
	}
	att, err := uploads.SaveImageBuffer(r.Context(), a.Pool, user.UserID, image, conversationID, authsec.MaxUploadBytes(), authsec.MaxUploadLabel(), "output")
	if err != nil {
		_, _ = a.Pool.Exec(r.Context(), `UPDATE image_generations SET status='failed', error=$1 WHERE id=$2`, err.Error(), genID)
		httpx.Error(w, 502, err.Error())
		return
	}
	_, _ = a.Pool.Exec(r.Context(), `UPDATE image_generations SET status='completed', result_attachment_id=$1 WHERE id=$2 AND user_id=$3`, att.ID, genID, user.UserID)
	cost := 1.0
	_, _ = a.Pool.Exec(r.Context(), `INSERT INTO image_usage (user_id,image_generation_id,model,cost_units,created_at) VALUES ($1,$2,$3,$4,$5)`, user.UserID, genID, model, cost, idgen.NowISO())
	httpx.WriteJSON(w, 200, map[string]any{"generationId": genID, "attachment": att, "markdown": "![生成图片](" + att.PublicPath + ")"})
}

func textImage(ctx context.Context, prompt string) (uploads.FileBytes, error) {
	endpoint := strings.TrimRight(os.Getenv("TEXT_IMAGE_API_URL"), "/")
	key := os.Getenv("TEXT_IMAGE_API_KEY")
	model := os.Getenv("TEXT_IMAGE_MODEL")
	if endpoint == "" || key == "" || model == "" {
		return uploads.FileBytes{}, errString("文生图 API 未配置：请设置 TEXT_IMAGE_API_URL、TEXT_IMAGE_API_KEY、TEXT_IMAGE_MODEL")
	}
	if !strings.HasSuffix(endpoint, "/images/generations") {
		endpoint += "/images/generations"
	}
	body, _ := json.Marshal(map[string]any{"model": model, "prompt": prompt, "n": 1, "response_format": "b64_json"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return uploads.FileBytes{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return uploads.FileBytes{}, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var data map[string]any
	_ = json.Unmarshal(raw, &data)
	if res.StatusCode >= 300 {
		return uploads.FileBytes{}, errString(apiErr(data, res.StatusCode))
	}
	return imageFromPayload(data)
}

func (a *App) editImage(ctx context.Context, userID, conversationID, prompt, attachmentID string) (uploads.FileBytes, error) {
	endpoint := strings.TrimRight(os.Getenv("IMAGE_EDIT_API_URL"), "/")
	key := os.Getenv("IMAGE_EDIT_API_KEY")
	model := os.Getenv("IMAGE_EDIT_MODEL")
	if endpoint == "" || key == "" || model == "" {
		return uploads.FileBytes{}, errString("图生图 API 未配置：请设置 IMAGE_EDIT_API_URL、IMAGE_EDIT_API_KEY、IMAGE_EDIT_MODEL")
	}
	if strings.HasSuffix(strings.ToLower(endpoint), "/images/generations") {
		endpoint = strings.TrimSuffix(endpoint, "/images/generations") + "/images/edits"
	} else if !strings.HasSuffix(strings.ToLower(endpoint), "/images/edits") {
		endpoint += "/images/edits"
	}
	var path, mime string
	var name *string
	if err := a.Pool.QueryRow(ctx, `SELECT file_path, mime_type, original_name FROM attachments WHERE id=$1 AND user_id=$2 AND conversation_id=$3`, normalizeID(attachmentID), userID, conversationID).Scan(&path, &mime, &name); err != nil {
		return uploads.FileBytes{}, errString("图片不存在：" + attachmentID)
	}
	buf, err := os.ReadFile(path)
	if err != nil {
		return uploads.FileBytes{}, err
	}
	filename := "source.png"
	if name != nil && *name != "" {
		filename = *name
	}
	var body strings.Builder
	boundary := "----chatlite"
	write := func(s string) { body.WriteString(s) }
	write("--" + boundary + "\r\n")
	write("Content-Disposition: form-data; name=\"model\"\r\n\r\n" + model + "\r\n")
	write("--" + boundary + "\r\n")
	write("Content-Disposition: form-data; name=\"prompt\"\r\n\r\n" + prompt + "\r\n")
	write("--" + boundary + "\r\n")
	write("Content-Disposition: form-data; name=\"image\"; filename=\"" + filename + "\"\r\nContent-Type: " + mime + "\r\n\r\n")
	body.Write(buf)
	write("\r\n--" + boundary + "--\r\n")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(body.String()))
	if err != nil {
		return uploads.FileBytes{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return uploads.FileBytes{}, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var data map[string]any
	_ = json.Unmarshal(raw, &data)
	if res.StatusCode >= 300 {
		return uploads.FileBytes{}, errString(apiErr(data, res.StatusCode))
	}
	return imageFromPayload(data)
}

func imageFromPayload(data map[string]any) (uploads.FileBytes, error) {
	var first map[string]any
	if items, ok := data["data"].([]any); ok && len(items) > 0 {
		first, _ = items[0].(map[string]any)
	}
	if first == nil {
		return uploads.FileBytes{}, errString("图片生成失败")
	}
	if b64, _ := first["b64_json"].(string); b64 != "" {
		raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(b64, "data:image/png;base64,"))
		if err != nil {
			return uploads.FileBytes{}, err
		}
		return uploads.FileBytes{Buffer: raw, MimeType: "image/png", Filename: "generated.png"}, nil
	}
	if url, _ := first["url"].(string); url != "" {
		res, err := http.Get(url)
		if err != nil {
			return uploads.FileBytes{}, err
		}
		defer res.Body.Close()
		buf, _ := io.ReadAll(res.Body)
		return uploads.FileBytes{Buffer: buf, MimeType: "image/png", Filename: "generated.png"}, nil
	}
	return uploads.FileBytes{}, errString("图片生成失败")
}

func apiErr(data map[string]any, status int) string {
	if errObj, ok := data["error"].(map[string]any); ok {
		if msg, _ := errObj["message"].(string); msg != "" {
			return msg
		}
	}
	if msg, _ := data["message"].(string); msg != "" {
		return msg
	}
	return "图片生成失败 HTTP " + itoa(status)
}

func normalizeID(value string) string {
	value = strings.TrimSpace(value)
	if i := strings.LastIndex(value, "/api/files/"); i >= 0 {
		return strings.TrimSpace(value[i+len("/api/files/"):])
	}
	return value
}

type errString string

func (e errString) Error() string { return string(e) }

func urlQuery(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, " ", "%20"), "#", "%23")
}

var _ = pgx.ErrNoRows
