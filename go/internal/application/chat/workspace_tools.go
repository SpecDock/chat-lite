package chat

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/infrastructure/sandbox"
	"chatlite/internal/infrastructure/storage"
	"chatlite/internal/platform/idgen"
	"chatlite/internal/platform/paths"
)

type scratch struct {
	jobID     string
	root      string
	published map[string]int64
}

func openScratch() (*scratch, error) {
	if runtime.GOOS != "linux" {
		return nil, errScratch("表格沙箱只在 Linux Docker 运行环境中可用")
	}
	jobID := idgen.NewID("job")
	root := filepath.Join(sandbox.JobsDir, jobID)
	if err := os.MkdirAll(filepath.Join(root, "input"), 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(root, "output"), 0o777); err != nil {
		return nil, err
	}
	_ = os.Chmod(root, 0o1777)
	_ = os.Chmod(filepath.Join(root, "input"), 0o755)
	_ = os.Chmod(filepath.Join(root, "output"), 0o777)
	return &scratch{jobID: jobID, root: root, published: map[string]int64{}}, nil
}

func (s *scratch) close() {
	if s != nil && s.root != "" {
		_ = os.RemoveAll(s.root)
	}
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
	return cleanRel(rel), nil
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
	return cleanRel(rel), nil
}

func fileCatalog(ctx context.Context, pool *pgxpool.Pool, in Input, work *scratch) string {
	rows, err := pool.Query(ctx, `SELECT id, COALESCE(original_name, id), file_path FROM attachments WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 40`, in.UserID, in.ConversationID)
	if err != nil {
		return ""
	}
	defer rows.Close()
	var lines []string
	for rows.Next() {
		var id, name, path string
		if err = rows.Scan(&id, &name, &path); err != nil {
			return ""
		}
		bucket := "input"
		if strings.Contains(path, "/output/") {
			bucket = "output"
		}
		where := "需要 download_file"
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
	result, err := sandbox.Run(ctx, s.jobID, string(body))
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

