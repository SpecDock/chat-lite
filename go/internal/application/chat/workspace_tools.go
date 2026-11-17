package chat

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/infrastructure/authsec"
	"chatlite/internal/infrastructure/sandbox"
	"chatlite/internal/infrastructure/storage"
	"chatlite/internal/platform/paths"
)

type scratch struct {
	userID, conversationID string
	published              map[string]int64
	fs                     *os.Root
}

func openScratch(ctx context.Context, in Input) (*scratch, error) {
	if runtime.GOOS != "linux" {
		return nil, errScratch("表格沙箱只在 Linux Docker 运行环境中可用")
	}
	if !paths.IsSafeWorkspaceID(in.ConversationID) {
		return nil, errScratch("会话无效")
	}
	// Quota admission and root-owned input provisioning precede every trusted
	// write, including restore and attachment staging. No app-side mkdir fallback.
	if err := sandbox.EnsureSession(ctx, in.ConversationID, false); err != nil {
		return nil, err
	}
	parent, err := os.OpenRoot(sandbox.SessionsDir)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	rootFS, err := parent.OpenRoot(in.ConversationID)
	if err != nil {
		return nil, err
	}
	for _, bucket := range []string{"input", "output"} {
		info, err := rootFS.Lstat(bucket)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			rootFS.Close()
			return nil, errScratch("工作区目录无效")
		}
	}
	work := &scratch{fs: rootFS, userID: in.UserID, conversationID: in.ConversationID, published: map[string]int64{}}
	work.restoreWorkspace()
	return work, nil
}

func (s *scratch) close() {
	if s != nil && s.fs != nil {
		_ = s.fs.Close()
	}
}

func (s *scratch) mountCurrent(ctx context.Context, pool *pgxpool.Pool, in Input) error {
	for _, id := range in.AttachmentIDs {
		var name, mimeType string
		if err := pool.QueryRow(ctx, `SELECT COALESCE(original_name,''), mime_type FROM attachments WHERE id=$1 AND user_id=$2 AND conversation_id=$3`, id, in.UserID, in.ConversationID).Scan(&name, &mimeType); err != nil {
			return errScratch("附件不存在或不属于当前会话")
		}
		// PDFs keep their existing server-side parsing path; download_file still
		// rejects them, but automatic staging must not abort a mixed-file turn.
		if isPDFName(name, mimeType) {
			continue
		}
		if _, err := s.download(ctx, pool, in, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *scratch) download(ctx context.Context, pool *pgxpool.Pool, in Input, attachmentID string) (string, error) {
	attachmentID = strings.TrimSpace(attachmentID)
	var name, filePath, mimeType string
	err := pool.QueryRow(ctx, `SELECT original_name, file_path, mime_type FROM attachments WHERE id=$1 AND user_id=$2 AND conversation_id=$3`, attachmentID, in.UserID, in.ConversationID).Scan(&name, &filePath, &mimeType)
	if err != nil {
		return "", errScratch("附件不存在或不属于当前会话")
	}
	if isPDFName(name, mimeType) {
		return "", errScratch("PDF 由服务端解析，不能放进工作区")
	}
	safe := safeTableName(name)
	if safe == "" || safe == "." {
		safe = attachmentID
	}
	body, err := storage.Read(ctx, filePath)
	if err != nil {
		return "", err
	}
	if authsec.IsTextUploadName(name) {
		if _, ok := authsec.TextUploadMIME(name, mimeType); !ok || !authsec.ValidTextUpload(body) {
			return "", errScratch("文本/源码附件校验失败")
		}
	}
	if err = s.writeInputFile(safe, body); err != nil {
		return "", err
	}
	s.syncFile("input/"+safe, body)
	return "input/" + safe, nil
}

func (s *scratch) stageInputFile(name string, body []byte) (string, error) {
	if s == nil {
		return "", errScratch("临时工作区不可用")
	}
	safe := safeTableName(name)
	if !strings.HasSuffix(strings.ToLower(safe), ".txt") {
		safe += ".txt"
	}
	if err := s.writeInputFile(safe, body); err != nil {
		return "", err
	}
	s.syncFile("input/"+safe, body)
	return "input/" + safe, nil
}

func (s *scratch) write(rel, content string) (string, error) {
	target, err := s.writable(rel)
	if err != nil {
		return "", err
	}
	if len(content) > 1<<20 {
		return "", errScratch("文件不能超过 1MB")
	}
	if err = s.fs.MkdirAll(path.Dir(target), 0o777); err != nil {
		return "", err
	}
	if err = s.writeTrusted(target, []byte(content), 0o644); err != nil {
		return "", err
	}
	saved := cleanRel(rel)
	if isWorkspaceData(saved) {
		s.syncFile(saved, []byte(content))
	}
	return saved, nil
}

func (s *scratch) edit(rel, oldText, newText string) (string, error) {
	target, err := s.writable(rel)
	if err != nil {
		return "", err
	}
	body, err := s.readRegular(target, 1<<20)
	if err != nil {
		return "", errScratch("文件不存在")
	}
	text := string(body)
	if oldText == "" || !strings.Contains(text, oldText) {
		return "", errScratch("未找到要替换的原文")
	}
	if strings.Count(text, oldText) != 1 {
		return "", errScratch("原文出现了多次，请给出更长的一段")
	}
	updated := strings.Replace(text, oldText, newText, 1)
	if len(updated) > 1<<20 {
		return "", errScratch("文件不能超过 1MB")
	}
	if err = s.writeTrusted(target, []byte(updated), 0o644); err != nil {
		return "", err
	}
	saved := cleanRel(rel)
	if isWorkspaceData(saved) {
		s.syncFile(saved, []byte(updated))
	}
	return saved, nil
}

func fileCatalog(ctx context.Context, pool *pgxpool.Pool, in Input, work *scratch) string {
	rows, err := pool.Query(ctx, `SELECT id, COALESCE(original_name, id), file_path, COALESCE(pdf_status,'') FROM attachments WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 40`, in.UserID, in.ConversationID)
	if err != nil {
		return ""
	}
	defer rows.Close()
	var lines []string
	for rows.Next() {
		var id, name, path, pdfStatus string
		if err = rows.Scan(&id, &name, &path, &pdfStatus); err != nil {
			return ""
		}
		bucket := "input"
		if strings.Contains(path, "/output/") {
			bucket = "output"
		}
		where := "需要 download_file"
		if strings.HasSuffix(strings.ToLower(name), ".pdf") {
			switch pdfStatus {
			case "indexed":
				where = "已解析，不要下载"
			case "too_short":
				where = "文本过少，未入库，不要下载"
			case "ocr_failed":
				where = "OCR 失败，不要下载"
			case "failed":
				where = "解析失败，不要下载"
			default:
				where = "尚未解析，不要下载"
			}
		}
		if work != nil {
			if _, err := work.fs.Stat("input/" + safeTableName(name)); err == nil {
				where = "已在 input/" + safeTableName(name)
			}
		}
		lines = append(lines, fmt.Sprintf("- %s attachmentId=%s 清单位置=%s %s", name, id, bucket, where))
	}
	if len(lines) == 0 {
		return ""
	}
	return "本会话文件清单。已在 input/ 的文件不要再下载。\n" + strings.Join(lines, "\n")
}

func runDownload(ctx context.Context, pool *pgxpool.Pool, in Input, work *scratch, attachmentID string) (string, map[string]any, []Event) {
	if work == nil {
		return "临时工作区不可用。", nil, []Event{{Type: "think", Text: "工具调用失败：download_file"}}
	}
	virtual, err := work.download(ctx, pool, in, attachmentID)
	if err != nil {
		return "下载失败：" + err.Error(), nil, []Event{{Type: "think", Text: "工具调用失败：download_file"}}
	}
	return "已下载到 " + virtual + "。代码只能读取这个相对路径。", nil, []Event{{Type: "think", Text: "工具完成：download_file"}}
}

func runWrite(work *scratch, path, content string) (string, map[string]any, []Event) {
	if work == nil {
		return "临时工作区不可用。", nil, []Event{{Type: "think", Text: "工具调用失败：write_file"}}
	}
	saved, err := work.write(path, content)
	if err != nil {
		return "写入失败：" + err.Error(), nil, []Event{{Type: "think", Text: "工具调用失败：write_file"}}
	}
	return "已写入 " + saved, nil, []Event{{Type: "think", Text: "工具完成：write_file"}}
}

func runEdit(work *scratch, path, oldText, newText string) (string, map[string]any, []Event) {
	if work == nil {
		return "临时工作区不可用。", nil, []Event{{Type: "think", Text: "工具调用失败：edit_file"}}
	}
	saved, err := work.edit(path, oldText, newText)
	if err != nil {
		return "修改失败：" + err.Error(), nil, []Event{{Type: "think", Text: "工具调用失败：edit_file"}}
	}
	return "已修改 " + saved, nil, []Event{{Type: "think", Text: "工具完成：edit_file"}}
}

func (s *scratch) writable(rel string) (string, error) {
	rel = cleanRel(rel)
	if rel == "" || strings.HasPrefix(rel, "input/") || rel == "input" {
		return "", errScratch("不能修改 input 里的原文件")
	}
	if err := s.noSymlinks(rel); err != nil {
		return "", err
	}
	return rel, nil
}

func cleanRel(rel string) string {
	rel = strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
	if rel == "" || strings.ContainsRune(rel, 0) {
		return ""
	}
	// Reject parent traversal before Clean can erase it. Dots inside ordinary
	// filenames are valid; only the complete parent component is forbidden.
	for _, component := range strings.Split(rel, "/") {
		if component == ".." {
			return ""
		}
	}
	rel = path.Clean(rel)
	if path.IsAbs(rel) {
		if !strings.HasPrefix(rel, "/work/") {
			return ""
		}
		rel = strings.TrimPrefix(rel, "/work/")
	}
	if rel == "." || rel == "" {
		return ""
	}
	return rel
}

type scratchError string

func (e scratchError) Error() string { return string(e) }

func errScratch(message string) error { return scratchError(message) }

func containerStateLine(ctx context.Context, conversationID string) string {
	now := time.Now().Format(time.RFC3339)
	state, err := sandbox.SessionStatus(ctx, conversationID)
	if err != nil || !state.Alive || state.ExpiresAt == "" {
		return "现在的容器状态为没有容器。当前时间 " + now + "。"
	}
	return "现在的容器状态为有容器。当前时间 " + now + "。预计销毁时间 " + state.ExpiresAt + "。"
}

func isWorkspaceData(rel string) bool {
	rel = cleanRel(rel)
	return strings.HasPrefix(rel, "input/") || strings.HasPrefix(rel, "output/")
}

func (s *scratch) syncFile(rel string, body []byte) {
	rel = cleanRel(rel)
	if !isWorkspaceData(rel) {
		return
	}
	if s == nil || s.userID == "" || len(body) == 0 || len(body) > 20<<20 || strings.Contains(rel, "/") == false {
		return
	}
	bucket := "input"
	name := strings.TrimPrefix(rel, "input/")
	if strings.HasPrefix(rel, "output/") {
		bucket = "output"
		name = strings.TrimPrefix(rel, "output/")
	}
	if name == "" || strings.Contains(name, "/") {
		return
	}
	stored := storage.ObjectPath(s.userID, s.conversationID, "ws-"+bucket, name)
	_ = storage.Put(context.Background(), stored, body, "application/octet-stream")
}

func (s *scratch) syncBucket(bucket string) {
	if s == nil || (bucket != "input" && bucket != "output") {
		return
	}
	entries, err := fs.ReadDir(s.fs.FS(), bucket)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 20<<20 {
			continue
		}
		rel := cleanRel(bucket + "/" + entry.Name())
		if rel == "" || path.Dir(rel) != bucket {
			continue
		}
		body, err := s.readRegular(rel, 20<<20)
		if err != nil {
			continue
		}
		s.syncFile(rel, body)
	}
}

func (s *scratch) restoreWorkspace() {
	if s == nil || s.userID == "" {
		return
	}
	for _, bucket := range []string{"input", "output"} {
		prefix := "u/" + s.userID + "/c/" + s.conversationID + "/ws-" + bucket + "/"
		keys, err := storage.ListKeys(context.Background(), prefix)
		if err != nil {
			continue
		}
		for _, key := range keys {
			name := strings.TrimPrefix(key, prefix)
			if name == "" || strings.Contains(name, "/") {
				continue
			}
			target := cleanRel(bucket + "/" + name)
			if target == "" || path.Dir(target) != bucket {
				continue
			}
			if _, err := s.fs.Lstat(target); err == nil {
				continue
			}
			body, err := storage.Read(context.Background(), storage.Prefix+key)
			if err == nil {
				if bucket == "input" {
					_ = s.writeInputFile(name, body)
				} else {
					_ = s.writeTrusted(target, body, 0o644)
				}
			}
		}
	}
}

func runRead(ctx context.Context, work *scratch, path string) (string, map[string]any, []Event) {
	if work == nil {
		return "临时工作区不可用。", nil, []Event{{Type: "think", Text: "工具调用失败：read_file"}}
	}
	text, err := work.read(ctx, path)
	if err != nil {
		return "读取失败：" + err.Error(), nil, []Event{{Type: "think", Text: "工具调用失败：read_file"}}
	}
	return text, nil, []Event{{Type: "think", Text: "工具完成：read_file"}}
}

func (s *scratch) read(ctx context.Context, path string) (string, error) {
	raw := strings.TrimSpace(path)
	if raw == "" {
		return "", errScratch("路径无效")
	}
	if strings.HasPrefix(raw, "/") {
		return s.readAbsolute(ctx, raw)
	}
	rel := cleanRel(raw)
	if rel == "" {
		return "", errScratch("路径无效")
	}
	body, err := s.readRegular(rel, (1<<20)+1)
	if err != nil {
		return "", errScratch("文件不存在")
	}
	return textBody(body)
}

// The root capability prevents host escapes even when a worker left symlinks.
// Rejecting write-side symlinks also preserves the input/ read-only boundary.
// All trusted tools execute serially, with the worker stopped between commands.
func (s *scratch) noSymlinks(rel string) error {
	rel = cleanRel(rel)
	if rel == "" {
		return errScratch("路径无效")
	}
	parts := strings.Split(rel, "/")
	for i := range parts {
		info, err := s.fs.Lstat(strings.Join(parts[:i+1], "/"))
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errScratch("不能写入符号链接")
		}
	}
	return nil
}

func (s *scratch) writeTrusted(rel string, body []byte, mode os.FileMode) error {
	var err error
	rel, err = s.writable(rel)
	if err != nil {
		return err
	}
	return s.writeWorkspaceFile(rel, body, mode)
}

// Only attachment staging/restoration may write input/. The generated name is
// validated after normalization and must remain one direct child of input/.
func (s *scratch) writeInputFile(name string, body []byte) error {
	rel := cleanRel("input/" + name)
	if rel == "" || path.Dir(rel) != "input" {
		return errScratch("input 文件名无效")
	}
	return s.writeWorkspaceFile(rel, body, 0o644)
}

func (s *scratch) writeWorkspaceFile(rel string, body []byte, mode os.FileMode) error {
	if err := s.noSymlinks(rel); err != nil {
		return err
	}
	f, err := openWorkspaceFile(s.fs, rel, os.O_WRONLY|os.O_CREATE, mode)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = f.Truncate(0); err != nil {
		return err
	}
	if err = f.Chmod(mode); err != nil {
		return err
	}
	_, err = f.Write(body)
	return err
}

func (s *scratch) readRegular(rel string, limit int64) ([]byte, error) {
	rel = cleanRel(rel)
	if rel == "" {
		return nil, errScratch("路径无效")
	}
	before, err := s.fs.Stat(rel)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return nil, errScratch("文件不是普通文件或超过大小限制")
	}
	f, err := openWorkspaceFile(s.fs, rel, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errScratch("文件不是普通文件或超过大小限制")
	}
	body, err := io.ReadAll(io.LimitReader(f, limit+1))
	if int64(len(body)) > limit {
		return nil, errScratch("文件超过大小限制")
	}
	return body, err
}

func (s *scratch) readAbsolute(ctx context.Context, path string) (string, error) {
	if rel := cleanRel(path); rel != "" {
		body, err := s.readRegular(rel, (1<<20)+1)
		if err != nil {
			return "", err
		}
		return textBody(body)
	}
	if path == "/work" {
		return "", errScratch("路径无效")
	}
	state, err := sandbox.SessionStatus(ctx, s.conversationID)
	if err != nil {
		return "", err
	}
	if !state.Alive {
		return "", errScratch("容器已回收，不能读取容器内部文件")
	}
	body, err := sandbox.ReadSession(ctx, s.conversationID, path)
	if err != nil {
		return "", err
	}
	text, err := textBody(body)
	if err != nil {
		return "", err
	}
	_ = sandbox.TouchSession(ctx, s.conversationID)
	return text, nil
}

func textBody(body []byte) (string, error) {
	if len(body) == 0 {
		return "", nil
	}
	cut := body
	truncated := false
	if len(body) > 1<<20 {
		cut = body[:1<<20]
		truncated = true
	}
	if bytes.IndexByte(cut, 0) >= 0 || !utf8.Valid(cut) {
		return "", errScratch("只能读取文本文件")
	}
	text := string(cut)
	if truncated {
		text += "\n\n文件未读完，已截断到 1MB。"
	}
	return text, nil
}
