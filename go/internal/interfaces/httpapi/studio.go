package httpapi

import (
	"context"
	"encoding/binary"
	"errors"
	"encoding/json"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"chatlite/internal/application/storagequota"
	"chatlite/internal/application/uploads"
	"chatlite/internal/infrastructure/authsec"
	"chatlite/internal/infrastructure/storage"
	"chatlite/config"
	"chatlite/internal/platform/httpx"
	"chatlite/internal/platform/idgen"
)

var studioAspects = map[string]string{
	"auto": "", "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "4:3": "2048x1536", "3:4": "1536x2048", "16:9": "2048x1152", "9:16": "1152x2048", "21:9": "3360x1440",
}
var studioQualities = map[string]struct{}{"auto": {}, "low": {}, "medium": {}, "standard": {}, "high": {}, "xhigh": {}, "max": {}}
var studioStyles = map[string]struct{}{"vivid": {}, "natural": {}}

func (a *App) registerStudio(mux *http.ServeMux) {
	if a.Pool != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		tag, err := a.Pool.Exec(ctx, `UPDATE studio_images SET status='failed', error=$1 WHERE status='running'`, "生成已中断")
		cancel()
		if err == nil && tag.RowsAffected() > 0 {
			log.Printf("[studio] marked %d interrupted image jobs as failed", tag.RowsAffected())
		}
	}
	mux.HandleFunc("POST /api/studio/images", a.withAuth(a.studioCreate))
	mux.HandleFunc("GET /api/studio/images", a.withAuth(a.studioList))
	mux.HandleFunc("DELETE /api/studio/images/{id}", a.withAuth(a.studioDelete))
	mux.HandleFunc("GET /api/studio/images/{id}/references/{refId}", a.withAuth(a.studioReference))
	mux.HandleFunc("GET /api/studio/images/{id}/file", a.withAuth(a.studioFile))
}

func (a *App) studioCreate(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	req, err := parseStudio(r)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	prompt := strings.TrimSpace(req.prompt)
	if prompt == "" {
		httpx.Error(w, 400, "提示词不能为空")
		return
	}
	if len([]rune(prompt)) > 4000 {
		httpx.Error(w, 400, "提示词不能超过 4000 字")
		return
	}
	if _, ok := studioAspects[req.aspect]; !ok {
		httpx.Error(w, 400, "不支持的画面比例")
		return
	}
	if _, ok := studioQualities[req.quality]; !ok {
		httpx.Error(w, 400, "不支持的画质")
		return
	}
	if req.style == "" {
		req.style = "vivid"
	}
	if _, ok := studioStyles[req.style]; !ok {
		httpx.Error(w, 400, "不支持的画面风格")
		return
	}
	if len(req.images) > 16 {
		httpx.Error(w, 400, "参考图最多 16 张")
		return
	}
	var running int
	_ = a.Pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM studio_images WHERE user_id=$1 AND status='running'`, user.UserID).Scan(&running)
	if running >= 6 {
		httpx.Error(w, 409, "当前已有 6 张图片正在生成，请等完成后再试。")
		return
	}
	id := idgen.NewID("simg")
	created := idgen.NowISO()
	log.Printf("[studio] start id=%s user=%s refs=%d aspect=%s quality=%s style=%s", id, user.UserID, len(req.images), req.aspect, req.quality, req.style)
	if _, err = a.Pool.Exec(r.Context(), `INSERT INTO studio_images (id,user_id,prompt,aspect_ratio,quality,style,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,'running',$7)`, id, user.UserID, prompt, req.aspect, req.quality, req.style, created); err != nil {
		log.Printf("[studio] fail id=%s stage=insert err=%s", id, trimErr(err))
		httpx.Error(w, 500, "图片生成失败")
		return
	}
	var refs []map[string]any
	var storedRefs []string
	for i, image := range req.images {
		measured := readImage(image.Buffer)
		if measured == nil {
			a.discardStudio(r.Context(), id, user.UserID, storedRefs)
			log.Printf("[studio] fail id=%s stage=reference index=%d err=unsupported image", id, i)
			httpx.Error(w, 400, "参考图仅支持 jpeg/png/webp 图片")
			return
		}
		refID := idgen.NewID("sref")
		path := storage.ObjectPath(user.UserID, "", "studio", id+"_"+refID+measured.ext)
		if err = storagequota.Ensure(r.Context(), a.Pool, user.UserID, int64(len(image.Buffer))); err != nil {
			a.discardStudio(r.Context(), id, user.UserID, storedRefs)
			if errors.Is(err, storagequota.ErrFull) {
				log.Printf("[studio] fail id=%s stage=reference-quota index=%d", id, i)
				httpx.Error(w, 413, "储存已满")
				return
			}
			log.Printf("[studio] fail id=%s stage=reference-quota index=%d err=%s", id, i, trimErr(err))
			httpx.Error(w, 500, "图片生成失败")
			return
		}
		if err = storage.Put(r.Context(), path, append([]byte(nil), image.Buffer...), measured.mime); err != nil {
			a.discardStudio(r.Context(), id, user.UserID, storedRefs)
			log.Printf("[studio] fail id=%s stage=reference-put index=%d bytes=%d err=%s", id, i, len(image.Buffer), trimErr(err))
			httpx.Error(w, 500, "图片生成失败")
			return
		}
		storedRefs = append(storedRefs, path)
		if _, err = a.Pool.Exec(r.Context(), `INSERT INTO studio_image_references (id,studio_image_id,user_id,file_path,mime_type,sort_order) VALUES ($1,$2,$3,$4,$5,$6)`, refID, id, user.UserID, path, measured.mime, i); err != nil {
			a.discardStudio(r.Context(), id, user.UserID, storedRefs)
			log.Printf("[studio] fail id=%s stage=reference-bind index=%d err=%s", id, i, trimErr(err))
			httpx.Error(w, 500, "图片生成失败")
			return
		}
		log.Printf("[studio] reference id=%s index=%d ref=%s bytes=%d", id, i, refID, len(image.Buffer))
		refs = append(refs, map[string]any{"id": refID, "url": "/api/studio/images/" + id + "/references/" + refID})
	}
	if refs == nil {
		refs = []map[string]any{}
	}
	log.Printf("[studio] accepted id=%s refs=%d", id, len(refs))
	go a.runStudio(id, user.UserID, prompt, req.aspect, req.quality, req.style, cloneStudioImages(req.images))
	httpx.WriteJSON(w, 200, map[string]any{"image": studioDTO(id, user.UserID, prompt, req.aspect, req.quality, req.style, nil, nil, "running", nil, nil, nil, created, refs)})
}

func (a *App) discardStudio(ctx context.Context, id, userID string, paths []string) {
	_, _ = a.Pool.Exec(ctx, `DELETE FROM studio_images WHERE id=$1 AND user_id=$2`, id, userID)
	for _, path := range paths {
		_ = storage.Remove(ctx, path)
	}
}

func cloneStudioImages(images []uploads.FileBytes) []uploads.FileBytes {
	out := make([]uploads.FileBytes, len(images))
	for i, image := range images {
		out[i] = image
		out[i].Buffer = append([]byte(nil), image.Buffer...)
	}
	return out
}

func (a *App) runStudio(id, userID, prompt, aspect, quality, style string, images []uploads.FileBytes) {
	started := time.Now()
	ctx := context.Background()
	var image uploads.FileBytes
	var err error
	mode := "text"
	if len(images) > 0 {
		mode = "edit"
		image, err = a.editStudio(ctx, prompt, aspect, quality, style, images)
	} else {
		image, err = textImage(ctx, prompt)
	}
	if err != nil {
		log.Printf("[studio] fail id=%s stage=upstream mode=%s elapsedMs=%d err=%s", id, mode, time.Since(started).Milliseconds(), trimErr(err))
		_, _ = a.Pool.Exec(ctx, `UPDATE studio_images SET status='failed', error=$1, duration_ms=$2 WHERE id=$3 AND user_id=$4 AND status='running'`, trimErr(err), int(time.Since(started).Milliseconds()), id, userID)
		return
	}
	measured := readImage(image.Buffer)
	if measured == nil {
		log.Printf("[studio] fail id=%s stage=result-decode elapsedMs=%d", id, time.Since(started).Milliseconds())
		_, _ = a.Pool.Exec(ctx, `UPDATE studio_images SET status='failed', error=$1, duration_ms=$2 WHERE id=$3 AND user_id=$4`, "无法读取生成图片尺寸", int(time.Since(started).Milliseconds()), id, userID)
		return
	}
	path := storage.ObjectPath(userID, "", "studio", id+measured.ext)
	if err = storagequota.Ensure(ctx, a.Pool, userID, int64(len(image.Buffer))); err != nil {
		message := trimErr(err)
		if errors.Is(err, storagequota.ErrFull) {
			message = "储存已满"
		}
		log.Printf("[studio] fail id=%s stage=result-quota elapsedMs=%d err=%s", id, time.Since(started).Milliseconds(), message)
		_, _ = a.Pool.Exec(ctx, `UPDATE studio_images SET status='failed', error=$1, duration_ms=$2 WHERE id=$3 AND user_id=$4 AND status='running'`, message, int(time.Since(started).Milliseconds()), id, userID)
		return
	}
	if err = storage.Put(ctx, path, image.Buffer, measured.mime); err != nil {
		log.Printf("[studio] fail id=%s stage=result-put elapsedMs=%d err=%s", id, time.Since(started).Milliseconds(), trimErr(err))
		_, _ = a.Pool.Exec(ctx, `UPDATE studio_images SET status='failed', error=$1 WHERE id=$2`, trimErr(err), id)
		return
	}
	tag, err := a.Pool.Exec(ctx, `UPDATE studio_images SET status='succeeded', width=$1, height=$2, duration_ms=$3, file_path=$4, mime_type=$5 WHERE id=$6 AND user_id=$7 AND status='running'`, measured.width, measured.height, int(time.Since(started).Milliseconds()), path, measured.mime, id, userID)
	if err != nil || tag.RowsAffected() == 0 {
		log.Printf("[studio] fail id=%s stage=complete elapsedMs=%d err=%v", id, time.Since(started).Milliseconds(), err)
		return
	}
	log.Printf("[studio] done id=%s mode=%s bytes=%d width=%d height=%d elapsedMs=%d", id, mode, len(image.Buffer), measured.width, measured.height, time.Since(started).Milliseconds())
	model := config.Current().TextImage.Model
	if len(images) > 0 {
		model = config.Current().ImageEdit.Model
	}
	_, _ = a.Pool.Exec(ctx, `INSERT INTO image_usage (user_id,image_generation_id,model,cost_units,created_at) VALUES ($1,$2,$3,1,$4)`, userID, id, model, idgen.NowISO())
}

func (a *App) editStudio(ctx context.Context, prompt, aspect, quality, style string, images []uploads.FileBytes) (uploads.FileBytes, error) {
	return editImageRaw(ctx, prompt, studioAspects[aspect], quality, style, images)
}

func (a *App) editImageBytes(ctx context.Context, prompt string, images []uploads.FileBytes) (uploads.FileBytes, error) {
	if len(images) == 0 {
		return uploads.FileBytes{}, errString("图生图至少需要一张主图")
	}
	return editImageRaw(ctx, prompt, "", "", "", images)
}

func editImageRaw(ctx context.Context, prompt, size, quality, style string, images []uploads.FileBytes) (uploads.FileBytes, error) {
	editCfg := config.Current().ImageEdit
	endpoint := strings.TrimRight(editCfg.APIURL, "/")
	key := editCfg.APIKey
	model := editCfg.Model
	if endpoint == "" || key == "" || model == "" {
		return uploads.FileBytes{}, errString("图生图 API 未配置：请设置 IMAGE_EDIT_API_URL、IMAGE_EDIT_API_KEY、IMAGE_EDIT_MODEL")
	}
	if strings.HasSuffix(strings.ToLower(endpoint), "/images/generations") {
		endpoint = strings.TrimSuffix(endpoint, "/images/generations") + "/images/edits"
	} else if !strings.HasSuffix(strings.ToLower(endpoint), "/images/edits") {
		endpoint += "/images/edits"
	}
	body := &strings.Builder{}
	boundary := "----chatlite-studio"
	body.WriteString("--" + boundary + "\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n" + model + "\r\n")
	body.WriteString("--" + boundary + "\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\n" + prompt + "\r\n")
	if size != "" {
		body.WriteString("--" + boundary + "\r\nContent-Disposition: form-data; name=\"size\"\r\n\r\n" + size + "\r\n")
	}
	if quality != "" && quality != "auto" {
		body.WriteString("--" + boundary + "\r\nContent-Disposition: form-data; name=\"quality\"\r\n\r\n" + quality + "\r\n")
	}
	if style != "" {
		body.WriteString("--" + boundary + "\r\nContent-Disposition: form-data; name=\"style\"\r\n\r\n" + style + "\r\n")
	}
	field := "image"
	if len(images) > 1 {
		field = "image[]"
	}
	for _, image := range images {
		body.WriteString("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + field + "\"; filename=\"" + image.Filename + "\"\r\nContent-Type: " + image.MimeType + "\r\n\r\n")
		body.Write(image.Buffer)
		body.WriteString("\r\n")
	}
	body.WriteString("--" + boundary + "--\r\n")
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
	_ = jsonUnmarshal(raw, &data)
	if res.StatusCode >= 300 {
		return uploads.FileBytes{}, errString(apiErr(data, res.StatusCode))
	}
	return imageFromPayload(data)
}

func (a *App) studioList(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	rows, err := a.Pool.Query(r.Context(), `SELECT id,user_id,prompt,aspect_ratio,quality,style,width,height,status,error,duration_ms,mime_type,created_at,file_path FROM studio_images WHERE user_id=$1 ORDER BY created_at DESC, id DESC`, user.UserID)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	defer rows.Close()
	refs := map[string][]map[string]any{}
	rrows, err := a.Pool.Query(r.Context(), `SELECT id, studio_image_id FROM studio_image_references WHERE user_id=$1 ORDER BY sort_order ASC`, user.UserID)
	if err == nil {
		for rrows.Next() {
			var id, imageID string
			if err := rrows.Scan(&id, &imageID); err == nil {
				refs[imageID] = append(refs[imageID], map[string]any{"id": id, "url": "/api/studio/images/" + imageID + "/references/" + id})
			}
		}
		rrows.Close()
	}
	list := []any{}
	for rows.Next() {
		var id, uid, prompt, aspect, quality, style, status, created string
		var width, height, duration *int
		var errText, mimeType, filePath *string
		if err := rows.Scan(&id, &uid, &prompt, &aspect, &quality, &style, &width, &height, &status, &errText, &duration, &mimeType, &created, &filePath); err != nil {
			continue
		}
		ref := refs[id]
		if ref == nil {
			ref = []map[string]any{}
		}
		list = append(list, studioDTO(id, uid, prompt, aspect, quality, style, width, height, status, errText, duration, mimeType, created, ref))
	}
	httpx.WriteJSON(w, 200, map[string]any{"images": list})
}

func studioDTO(id, userID, prompt, aspect, quality, style string, width, height *int, status string, errText *string, duration *int, mimeType *string, created string, refs []map[string]any) map[string]any {
	var fileURL any
	if status == "succeeded" {
		fileURL = "/api/studio/images/" + id + "/file"
	}
	return map[string]any{"id": id, "user_id": userID, "prompt": prompt, "aspect_ratio": aspect, "quality": quality, "style": style, "width": width, "height": height, "status": status, "error": errText, "duration_ms": duration, "mime_type": mimeType, "created_at": created, "file_url": fileURL, "references": refs}
}

func (a *App) studioDelete(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	id := r.PathValue("id")
	var filePath *string
	err := a.Pool.QueryRow(r.Context(), `SELECT file_path FROM studio_images WHERE id=$1 AND user_id=$2`, id, user.UserID).Scan(&filePath)
	if err == pgx.ErrNoRows {
		httpx.Error(w, 404, "记录不存在")
		return
	}
	if err != nil {
		httpx.Error(w, 500, "删除失败")
		return
	}
	rows, _ := a.Pool.Query(r.Context(), `SELECT file_path FROM studio_image_references WHERE studio_image_id=$1 AND user_id=$2`, id, user.UserID)
	var refs []string
	if rows != nil {
		for rows.Next() {
			var path string
			if rows.Scan(&path) == nil {
				refs = append(refs, path)
			}
		}
		rows.Close()
	}
	if _, err = a.Pool.Exec(r.Context(), `DELETE FROM studio_images WHERE id=$1 AND user_id=$2`, id, user.UserID); err != nil {
		httpx.Error(w, 500, "删除失败")
		return
	}
	if filePath != nil {
		_ = storage.Remove(r.Context(), *filePath)
	}
	for _, path := range refs {
		_ = storage.Remove(r.Context(), path)
	}
	httpx.WriteJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) studioReference(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	var path, mimeType string
	err := a.Pool.QueryRow(r.Context(), `SELECT file_path, mime_type FROM studio_image_references WHERE studio_image_id=$1 AND id=$2 AND user_id=$3`, r.PathValue("id"), r.PathValue("refId"), user.UserID).Scan(&path, &mimeType)
	if err != nil {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	streamStored(w, r, path, mimeType, "inline")
}

func (a *App) studioFile(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	var path, mimeType *string
	var status string
	err := a.Pool.QueryRow(r.Context(), `SELECT file_path, mime_type, status FROM studio_images WHERE id=$1 AND user_id=$2`, r.PathValue("id"), user.UserID).Scan(&path, &mimeType, &status)
	if err != nil || status != "succeeded" || path == nil {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	mt := "application/octet-stream"
	if mimeType != nil {
		mt = *mimeType
	}
	streamStored(w, r, *path, mt, "inline")
}

func streamStored(w http.ResponseWriter, r *http.Request, path, mimeType, disposition string) {
	body, size, err := storage.Open(r.Context(), path)
	if err != nil {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	defer body.Close()
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(200)
	_, _ = io.Copy(w, body)
}

type studioReq struct {
	prompt, aspect, quality, style string
	images                         []uploads.FileBytes
}

func parseStudio(r *http.Request) (studioReq, error) {
	ct := r.Header.Get("Content-Type")
	if !strings.Contains(ct, "multipart/form-data") {
		return studioReq{}, errString("请使用 multipart/form-data 上传")
	}
	_, params, err := mime.ParseMediaType(ct)
	if err != nil {
		return studioReq{}, errString("请使用 multipart/form-data 上传")
	}
	mr := multipart.NewReader(r.Body, params["boundary"])
	var req studioReq
	req.style = "vivid"
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return studioReq{}, errString("上传失败")
		}
		if part.FileName() == "" {
			buf, _ := io.ReadAll(io.LimitReader(part, 32*1024))
			switch part.FormName() {
			case "prompt":
				req.prompt = string(buf)
			case "aspectRatio":
				req.aspect = strings.TrimSpace(string(buf))
			case "quality":
				req.quality = strings.TrimSpace(string(buf))
			case "style":
				req.style = strings.TrimSpace(string(buf))
			}
			continue
		}
		if part.FormName() != "images" {
			return studioReq{}, errString("参考图请使用 images 字段上传")
		}
		mimeType := strings.ToLower(part.Header.Get("Content-Type"))
		if !authsec.AllowedImage(mimeType) {
			return studioReq{}, errString("参考图仅支持 jpeg/png/webp 图片")
		}
		buf, _ := io.ReadAll(io.LimitReader(part, authsec.MaxUploadBytes()+1))
		if int64(len(buf)) > authsec.MaxUploadBytes() {
			return studioReq{}, errString("图片不能超过 " + authsec.MaxUploadLabel())
		}
		if len(buf) == 0 {
			return studioReq{}, errString("参考图无效")
		}
		name := part.FileName()
		if name == "" {
			name = "reference.jpg"
		}
		req.images = append(req.images, uploads.FileBytes{Buffer: buf, MimeType: mimeType, Filename: name})
	}
	return req, nil
}

type imageSize struct {
	width, height int
	mime, ext     string
}

func readImage(buf []byte) *imageSize {
	if len(buf) >= 24 && buf[0] == 0x89 && buf[1] == 0x50 && string(buf[12:16]) == "IHDR" {
		w := int(binary.BigEndian.Uint32(buf[16:20]))
		h := int(binary.BigEndian.Uint32(buf[20:24]))
		if w > 0 && h > 0 {
			return &imageSize{w, h, "image/png", ".png"}
		}
	}
	if len(buf) > 4 && buf[0] == 0xff && buf[1] == 0xd8 {
		return &imageSize{1, 1, "image/jpeg", ".jpg"}
	}
	if len(buf) > 12 && string(buf[0:4]) == "RIFF" && string(buf[8:12]) == "WEBP" {
		return &imageSize{1, 1, "image/webp", ".webp"}
	}
	return nil
}

func trimErr(err error) string {
	text := strings.Join(strings.Fields(err.Error()), " ")
	if len([]rune(text)) > 500 {
		text = string([]rune(text)[:500])
	}
	if text == "" {
		return "图片生成失败"
	}
	return text
}

func jsonUnmarshal(raw []byte, dest any) error {
	return json.Unmarshal(raw, dest)
}
