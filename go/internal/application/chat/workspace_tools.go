package chat

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/infrastructure/sandbox"
	"chatlite/internal/infrastructure/storage"
	"chatlite/internal/platform/paths"
)

type scratch struct {
	jobID, root, userID, conversationID string
	published                           map[string]int64
}

func openScratch(in Input) (*scratch, error) {
	if runtime.GOOS != "linux" {
		return nil, errScratch("表格沙箱只在 Linux Docker 运行环境中可用")
	}
	if !paths.IsSafeWorkspaceID(in.ConversationID) {
		return nil, errScratch("会话无效")
	}
	root := filepath.Join(sandbox.SessionsDir, in.ConversationID)
	if err := os.MkdirAll(filepath.Join(root, "input"), 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(root, "output"), 0o777); err != nil {
		return nil, err
	}
	_ = os.Chmod(root, 0o1777)
	_ = os.Chmod(filepath.Join(root, "input"), 0o755)
	_ = os.Chmod(filepath.Join(root, "output"), 0o777)
	work := &scratch{jobID: in.ConversationID, root: root, userID: in.UserID, conversationID: in.ConversationID, published: map[string]int64{}}
	work.restoreWorkspace()
	return work, nil
}

func (s *scratch) close() {}

func removeJobDir(root string) {
	if root == "" {
		return
	}
	if _, err := os.Lstat(filepath.Join(root, ".sandbox-held")); !os.IsNotExist(err) {
		return
	}
	_ = os.RemoveAll(root)
}

func (s *scratch) mountCurrent(ctx context.Context, pool *pgxpool.Pool, in Input) {
	for _, id := range in.AttachmentIDs {
		_, _ = s.download(ctx, pool, in, id)
	}
}

func (s *scratch) download(ctx context.Context, pool *pgxpool.Pool, in Input, attachmentID string) (string, error) {
	attachmentID = strings.TrimSpace(attachmentID)
	var name, filePath string
	err := pool.QueryRow(ctx, `SELECT original_name, file_path FROM attachments WHERE id=$1 AND user_id=$2 AND conversation_id=$3`, attachmentID, in.UserID, in.ConversationID).Scan(&name, &filePath)
	if err != nil {
		return "", errScratch("附件不存在或不属于当前会话")
	}
	if strings.HasSuffix(strings.ToLower(name), ".pdf") {
		return "", errScratch("PDF 由服务端解析，不能放进工作区")
	}
	safe := safeTableName(name)
	if safe == "" || safe == "." {
		safe = attachmentID
	}
	target := filepath.Join(s.root, "input", safe)
	if !paths.IsWithinDirectory(filepath.Join(s.root, "input"), target) {
		return "", errScratch("文件名无效")
	}
	if err = storage.Materialize(ctx, filePath, target); err != nil {
		return "", err
	}
	_ = os.Chmod(target, 0o644)
	if body, readErr := os.ReadFile(target); readErr == nil {
		s.syncFile("input/"+safe, body)
	}
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
	target := filepath.Join(s.root, "input", safe)
	if !paths.IsWithinDirectory(filepath.Join(s.root, "input"), target) {
		return "", errScratch("文件名无效")
	}
	if err := os.WriteFile(target, body, 0o644); err != nil {
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
	if err = os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return "", err
	}
	if err = os.WriteFile(target, []byte(content), 0o644); err != nil {
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
	body, err := os.ReadFile(target)
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
	if err = os.WriteFile(target, []byte(updated), 0o644); err != nil {
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
			if _, err := os.Stat(filepath.Join(work.root, "input", safeTableName(name))); err == nil {
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
	if isRootScript(cleanRel(path)) {
		if err := sandbox.EnsureSession(context.Background(), work.conversationID, false); err != nil {
			return "写入失败：" + err.Error(), nil, []Event{{Type: "think", Text: "工具调用失败：write_file"}}
		}
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

func runPythonFile(ctx context.Context, pool *pgxpool.Pool, in Input, work *scratch, path string) (string, map[string]any, []Event) {
	if work == nil {
		return "临时工作区不可用。", nil, []Event{{Type: "think", Text: "工具调用失败：run_python"}}
	}
	result, code, err := work.run(ctx, path)
	if err != nil {
		return "工具 run_python 执行失败：" + err.Error(), nil, []Event{{Type: "think", Text: "工具调用失败：run_python"}}
	}
	saved := ""
	if result.Status == "succeeded" && result.ExitCode != nil && *result.ExitCode == 0 {
		note, saveErr := publishPythonOutputs(ctx, pool, in, work, filepath.Join(work.root, "output"))
		if saveErr != nil {
			saved = "\n新文件保存失败：" + saveErr.Error()
		} else if note != "" {
			saved = "\n" + note
		}
	}
	detail := structuredSandboxResult(result, "")
	events := []Event{{Type: "execution", Language: "python", Code: code, Output: tableResultText(result)}}
	think := "工具完成：run_python"
	text := "Python 已执行。路径：" + path + "。" + saved + "\n" + detail
	if result.Status != "succeeded" || result.ExitCode == nil || *result.ExitCode != 0 {
		think = "工具返回失败：run_python"
		text = "Python 未通过。请用 edit_file 修改后再次运行。路径：" + path + "。" + saved + "\n" + detail
	}
	events = append(events, Event{Type: "think", Text: think})
	return text, nil, events
}

func (s *scratch) run(ctx context.Context, rel string) (sandbox.Result, string, error) {
	rel = cleanRel(rel)
	if !strings.HasSuffix(strings.ToLower(rel), ".py") || strings.HasPrefix(rel, "input/") {
		return sandbox.Result{}, "", errScratch("只能运行工作区里的 .py 文件，不能运行 input 中的文件")
	}
	target := filepath.Join(s.root, filepath.FromSlash(rel))
	if !paths.IsWithinDirectory(s.root, target) {
		return sandbox.Result{}, "", errScratch("路径无效")
	}
	body, err := os.ReadFile(target)
	if err != nil {
		return sandbox.Result{}, "", errScratch("文件不存在")
	}
	result, err := sandbox.ExecSession(ctx, s.conversationID, rel)
	if err == nil {
		s.syncBucket("output")
	}
	return result, string(body), err
}

func (s *scratch) writable(rel string) (string, error) {
	rel = cleanRel(rel)
	if rel == "" || strings.HasPrefix(rel, "input/") || rel == "input" {
		return "", errScratch("不能修改 input 里的原文件")
	}
	target := filepath.Join(s.root, filepath.FromSlash(rel))
	if !paths.IsWithinDirectory(s.root, target) {
		return "", errScratch("路径无效")
	}
	return target, nil
}

func cleanRel(rel string) string {
	rel = strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
	rel = strings.TrimPrefix(rel, "/")
	if strings.Contains(rel, "..") {
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

func isRootScript(rel string) bool {
	rel = cleanRel(rel)
	return strings.HasSuffix(strings.ToLower(rel), ".py") && !strings.Contains(rel, "/")
}

func isWorkspaceData(rel string) bool {
	rel = cleanRel(rel)
	return strings.HasPrefix(rel, "input/") || strings.HasPrefix(rel, "output/")
}

func (s *scratch) syncFile(rel string, body []byte) {
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
	dir := filepath.Join(s.root, bucket)
	entries, err := os.ReadDir(dir)
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
		body, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		s.syncFile(bucket+"/"+entry.Name(), body)
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
			target := filepath.Join(s.root, bucket, name)
			if _, err := os.Lstat(target); err == nil {
				continue
			}
			_ = storage.Materialize(context.Background(), storage.Prefix+key, target)
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
	target := filepath.Join(s.root, filepath.FromSlash(rel))
	if !paths.IsWithinDirectory(s.root, target) {
		return "", errScratch("路径无效")
	}
	body, err := os.ReadFile(target)
	if err != nil {
		return "", errScratch("文件不存在")
	}
	return textBody(body)
}

func (s *scratch) readAbsolute(ctx context.Context, path string) (string, error) {
	if strings.HasPrefix(path, "/work/") {
		rel := strings.TrimPrefix(path, "/work/")
		return s.read(ctx, rel)
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
