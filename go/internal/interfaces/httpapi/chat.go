package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"

	"chatlite/internal/application/chat"
	"chatlite/internal/application/rag"
	"chatlite/internal/domain/visibility"
	"chatlite/internal/infrastructure/llm"
	"chatlite/internal/platform/httpx"
	"chatlite/internal/platform/idgen"
	"chatlite/internal/platform/paths"
)

func (a *App) registerChat(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/chat", a.withAuth(a.chat))
}

func (a *App) chat(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	body := httpx.ReadJSON(r, 1<<20)
	content := strings.TrimSpace(firstString(body["content"], body["message"]))
	conversationID := strings.TrimSpace(httpx.AsString(body["conversationId"]))
	editID := strings.TrimSpace(httpx.AsString(body["editUserMessageId"]))
	attachmentIDs := stringList(body["attachmentIds"], 4)
	userInput := content
	created := false
	var userMessageID, assistantID, editMode string
	var firstTurn bool
	ctx := r.Context()
	var assistantPersisted bool
	if editID != "" {
		if conversationID == "" {
			httpx.Error(w, 400, "编辑消息必须指定会话")
			return
		}
		exists, err := a.conversationExists(ctx, conversationID, user.UserID)
		if err != nil {
			httpx.Error(w, 500, "服务器错误")
			return
		}
		if !exists {
			httpx.Error(w, 404, "会话不存在")
			return
		}
		if streaming, _ := a.hasStreaming(ctx, conversationID, user.UserID); streaming {
			httpx.Error(w, 409, "会话正在生成回复")
			return
		}
		pair, err := a.getMessagePair(ctx, conversationID, user.UserID, editID)
		if err != nil {
			httpx.Error(w, 500, "服务器错误")
			return
		}
		if pair == nil {
			httpx.Error(w, 404, "用户消息不存在")
			return
		}
		userInput = stripUserImageContent(content)
		original := a.listMessageAttachments(ctx, pair.User.ID, conversationID, user.UserID)
		if userInput == "" && len(original) == 0 {
			httpx.Error(w, 400, "消息不能为空")
			return
		}
		if pair.IsLatest {
			attachmentIDs = nil
			for _, item := range original {
				attachmentIDs = append(attachmentIDs, item.ID)
			}
			stored := a.userMessageContent(ctx, userInput, attachmentIDs)
			assistantID = pair.User.ID
			if pair.Assistant != nil {
				assistantID = pair.Assistant.ID
			} else {
				assistantID = idgen.NewID("msg")
			}
			if err := a.replaceLatest(ctx, conversationID, user.UserID, pair, stored, assistantID); err != nil {
				httpx.Error(w, statusOf(err), err.Error())
				return
			}
			userMessageID = pair.User.ID
			assistantPersisted = true
			firstTurn = pair.IsFirst
			editMode = "replace"
			if firstTurn {
				_ = a.updateAutoTitle(ctx, conversationID, user.UserID, safeTitle(userInput))
			}
		} else {
			clones, err := a.cloneAttachments(ctx, original, user.UserID, conversationID)
			if err != nil {
				a.discardClones(ctx, clones, user.UserID)
				httpx.Error(w, 500, "服务器错误")
				return
			}
			if streaming, _ := a.hasStreaming(ctx, conversationID, user.UserID); streaming {
				a.discardClones(ctx, clones, user.UserID)
				httpx.Error(w, 409, "会话正在生成回复")
				return
			}
			attachmentIDs = nil
			for _, clone := range clones {
				attachmentIDs = append(attachmentIDs, clone.ID)
			}
			userMessageID = idgen.NewID("msg")
			assistantID = idgen.NewID("msg")
			if err = a.insertMessage(ctx, userMessageID, user.UserID, conversationID, "user", a.userMessageContent(ctx, userInput, attachmentIDs), "completed"); err != nil {
				a.discardClones(ctx, clones, user.UserID)
				httpx.Error(w, 500, "服务器错误")
				return
			}
			_ = a.linkAttachments(ctx, attachmentIDs, user.UserID, conversationID, userMessageID)
			if err = a.insertMessage(ctx, assistantID, user.UserID, conversationID, "assistant", "", "streaming"); err != nil {
				httpx.Error(w, 500, "服务器错误")
				return
			}
			assistantPersisted = true
			editMode = "append"
		}
	} else {
		if content == "" && len(attachmentIDs) == 0 {
			httpx.Error(w, 400, "消息不能为空")
			return
		}
		if conversationID == "" {
			conversationID = idgen.NewID("conv")
			if _, err := a.createConversation(ctx, conversationID, user.UserID, safeTitle(userInput)); err != nil {
				httpx.Error(w, 500, "服务器错误")
				return
			}
			created = true
			emitToUser(user.UserID, "conversations_changed", map[string]any{"conversationId": conversationID, "reason": "created"})
		} else {
			exists, err := a.conversationExists(ctx, conversationID, user.UserID)
			if err != nil {
				httpx.Error(w, 500, "服务器错误")
				return
			}
			if !exists {
				httpx.Error(w, 404, "会话不存在")
				return
			}
		}
		if len(attachmentIDs) > 0 {
			count, err := a.countValidAttachments(ctx, attachmentIDs, user.UserID, conversationID)
			if err != nil {
				httpx.Error(w, 500, "服务器错误")
				return
			}
			if count != len(attachmentIDs) {
				httpx.Error(w, 400, "包含无效图片或表格附件")
				return
			}
		}
		userMessageID = idgen.NewID("msg")
		assistantID = idgen.NewID("msg")
		stored := a.userMessageContent(ctx, userInput, attachmentIDs)
		if err := a.insertMessage(ctx, userMessageID, user.UserID, conversationID, "user", stored, "completed"); err != nil {
			httpx.Error(w, 500, "服务器错误")
			return
		}
		_ = a.linkAttachments(ctx, attachmentIDs, user.UserID, conversationID, userMessageID)
		if err := a.insertMessage(ctx, assistantID, user.UserID, conversationID, "assistant", "", "streaming"); err != nil {
			httpx.Error(w, 500, "服务器错误")
			return
		}
		assistantPersisted = true
	}
	history := a.loadHistory(ctx, conversationID, user.UserID, userMessageID)
	summary := a.loadSummary(ctx, conversationID, user.UserID)
	if editMode == "" {
		firstTurn = len(history) == 0 && strings.TrimSpace(summary) == ""
		if !created && firstTurn {
			_ = a.updateAutoTitle(ctx, conversationID, user.UserID, safeTitle(userInput))
		}
	}
	rag.IndexChatMessage(a.Pool, rag.IndexInput{UserID: user.UserID, ConversationID: conversationID, MessageID: userMessageID, Role: "user", Content: a.userMessageContent(ctx, userInput, attachmentIDs), Status: "completed"})
	emitToUser(user.UserID, "messages_changed", map[string]any{"conversationId": conversationID, "reason": map[bool]string{true: "user_message_edited", false: "user_message"}[editMode != ""]})
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	meta := map[string]any{"conversationId": conversationID, "userMessageId": userMessageID, "messageId": assistantID}
	if editMode != "" {
		meta["mode"] = editMode
	}
	writeSSE(w, flusher, "meta", meta)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		<-r.Context().Done()
		cancel()
	}()
	var full, stored, execution string
	var thinkStarted, thinkClosed, executionInserted bool
	var executionAt, finalStart int
	var captured *llm.Usage
	appendThink := func(text string) {
		if !thinkStarted || thinkClosed {
			thinkStarted = true
			thinkClosed = false
			stored += "<think>\n"
		}
		stored += text + "\n"
		writeSSE(w, flusher, "think", map[string]any{"text": text})
	}
	closeThink := func() {
		if !thinkStarted || thinkClosed {
			return
		}
		thinkClosed = true
		stored += "</think>\n\n"
	}
	placeExecution := func(boundary bool) {
		if executionInserted || (!boundary && execution == "") {
			return
		}
		closeThink()
		executionAt = len(stored)
		stored += execution
		executionInserted = true
		finalStart = len(stored)
	}
	err := chat.Run(runCtx, a.Pool, chat.Input{UserID: user.UserID, ConversationID: conversationID, UserInput: userInput, Summary: visibility.StripThinkBlocks(summary), AttachmentIDs: attachmentIDs, History: history}, func(event chat.Event) {
		switch event.Type {
		case "think":
			appendThink(event.Text)
		case "delta":
			placeExecution(true)
			full += event.Text
			stored += event.Text
			writeSSE(w, flusher, "delta", map[string]any{"text": event.Text})
		case "execution":
			block := encodeExecution(event.Language, event.Code, event.Output)
			execution += block + "\n\n"
			if executionInserted {
				bodyText := ""
				if finalStart <= len(stored) {
					bodyText = stored[finalStart:]
				}
				stored = stored[:executionAt] + execution + bodyText
				finalStart = executionAt + len(execution)
			}
			writeSSE(w, flusher, "execution", map[string]any{"language": event.Language, "code": event.Code, "output": event.Output})
		case "usage":
			captured = mergeUsage(captured, event.Usage)
		}
	})
	if err == nil && strings.TrimSpace(full) == "" && !strings.Contains(stored, "](/api/files/att_") {
		appendThink("主模型未返回正文，请尝试重新提问或调整描述。")
		full = "主模型未返回正文，请尝试重新提问或调整描述。"
	}
	if err == nil {
		placeExecution(false)
		if thinkStarted && !thinkClosed {
			stored += "</think>"
		}
		completed := stored
		if completed == "" {
			completed = full
		}
		if completed == "" {
			completed = "（助手未返回内容）"
		}
		_ = a.finishMessage(ctx, assistantID, user.UserID, completed, "completed")
		rag.IndexChatMessage(a.Pool, rag.IndexInput{UserID: user.UserID, ConversationID: conversationID, MessageID: assistantID, Role: "assistant", Content: completed, Status: "completed"})
		a.recordUsage(ctx, user.UserID, conversationID, assistantID, userInput, history, completed, captured)
		a.touchConversation(context.Background(), conversationID, user.UserID)
		emitToUser(user.UserID, "messages_changed", map[string]any{"conversationId": conversationID, "reason": "assistant_completed"})
		emitToUser(user.UserID, "conversations_changed", map[string]any{"conversationId": conversationID, "reason": "updated"})
		writeSSE(w, flusher, "done", map[string]any{"ok": true})
		return
	}
	var partial *chat.PartialError
	aborted := errors.Is(err, context.Canceled) || strings.Contains(err.Error(), "请求已取消") || r.Context().Err() != nil
	if errors.As(err, &partial) && strings.TrimSpace(full+partial.Text) != "" {
		placeExecution(false)
		if thinkStarted && !thinkClosed {
			thinkClosed = true
			stored += "</think>\n\n"
		}
		notice := "\n\n> 回答生成过程中连接中断，已保留当前内容。你可以让我继续。"
		full += notice
		stored += notice
		writeSSE(w, flusher, "delta", map[string]any{"text": notice})
		_ = a.finishMessage(context.Background(), assistantID, user.UserID, stored, "interrupted")
		rag.IndexChatMessage(a.Pool, rag.IndexInput{UserID: user.UserID, ConversationID: conversationID, MessageID: assistantID, Role: "assistant", Content: stored, Status: "interrupted"})
		a.recordUsage(context.Background(), user.UserID, conversationID, assistantID, userInput, history, stored, captured)
		a.touchConversation(context.Background(), conversationID, user.UserID)
		emitToUser(user.UserID, "messages_changed", map[string]any{"conversationId": conversationID, "reason": "assistant_interrupted"})
		emitToUser(user.UserID, "conversations_changed", map[string]any{"conversationId": conversationID, "reason": "updated"})
		writeSSE(w, flusher, "cancelled", map[string]any{"ok": true, "reason": "model_interrupted"})
		return
	}
	if aborted {
		placeExecution(false)
		if thinkStarted && !thinkClosed {
			stored += "</think>"
		}
		text := stored
		if text == "" {
			text = full
		}
		if text == "" {
			text = "已取消"
		}
		_ = a.finishMessage(context.Background(), assistantID, user.UserID, text, "interrupted")
		rag.IndexChatMessage(a.Pool, rag.IndexInput{UserID: user.UserID, ConversationID: conversationID, MessageID: assistantID, Role: "assistant", Content: text, Status: "interrupted"})
		a.recordUsage(context.Background(), user.UserID, conversationID, assistantID, userInput, history, text, captured)
		a.touchConversation(context.Background(), conversationID, user.UserID)
		emitToUser(user.UserID, "messages_changed", map[string]any{"conversationId": conversationID, "reason": "assistant_interrupted"})
		emitToUser(user.UserID, "conversations_changed", map[string]any{"conversationId": conversationID, "reason": "updated"})
		writeSSE(w, flusher, "cancelled", map[string]any{"ok": true})
		return
	}
	msg := userFacing(err)
	placeExecution(false)
	if thinkStarted && !thinkClosed {
		stored += "</think>"
	}
	errorContent := msg
	if stored != "" {
		errorContent = stored + "\n\n" + msg
	}
	if assistantPersisted {
		_ = a.finishMessage(context.Background(), assistantID, user.UserID, errorContent, "error")
	}
	rag.IndexChatMessage(a.Pool, rag.IndexInput{UserID: user.UserID, ConversationID: conversationID, MessageID: assistantID, Role: "assistant", Content: errorContent, Status: "error"})
	a.recordUsage(context.Background(), user.UserID, conversationID, assistantID, userInput, history, errorContent, captured)
	emitToUser(user.UserID, "messages_changed", map[string]any{"conversationId": conversationID, "reason": "assistant_error"})
	writeSSE(w, flusher, "error", map[string]any{"error": msg})
}

func writeSSE(w http.ResponseWriter, flusher http.Flusher, event string, data any) {
	raw, _ := json.Marshal(data)
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw)
	if flusher != nil {
		flusher.Flush()
	}
}

func encodeExecution(language, code, output string) string {
	raw, _ := json.Marshal(map[string]string{"language": language, "code": code, "output": output})
	return `<chat-lite-execution v="1">` + base64.StdEncoding.EncodeToString(raw) + `</chat-lite-execution>`
}

func userFacing(err error) string {
	var httpErr *llm.HTTPError
	if errors.As(err, &httpErr) {
		if httpErr.Status == 401 || httpErr.Status == 403 {
			return "当前主模型额度不足或认证失败，请更换可用的模型 API Key 后再试。"
		}
		if httpErr.Status == 429 {
			return "当前主模型请求过于频繁，请稍后重试。"
		}
		if httpErr.Status == 408 || httpErr.Status >= 500 {
			return fmt.Sprintf("当前主模型连接不稳定或请求超时。已自动尝试 %d 次仍失败，请稍后重试。", llm.MaxAttempts())
		}
	}
	text := ""
	if err != nil {
		text = err.Error()
	}
	if strings.Contains(text, "未配置模型") || strings.Contains(text, "API Key") {
		return "当前主模型额度不足或认证失败，请更换可用的模型 API Key 后再试。"
	}
	if strings.Contains(text, "超时") || strings.Contains(text, "连接") {
		return fmt.Sprintf("当前主模型连接不稳定或请求超时。已自动尝试 %d 次仍失败，请稍后重试。", llm.MaxAttempts())
	}
	return "当前主模型调用失败，请稍后重试。"
}

func firstString(values ...any) string {
	for _, value := range values {
		if text := httpx.AsString(value); text != "" {
			return text
		}
	}
	return ""
}

func stringList(value any, limit int) []string {
	items, _ := value.([]any)
	var out []string
	for _, item := range items {
		text := strings.TrimSpace(httpx.AsString(item))
		if text != "" {
			out = append(out, text)
		}
		if len(out) >= limit {
			break
		}
	}
	return out
}

func statusOf(err error) int {
	var he *httpStatusError
	if errors.As(err, &he) {
		return he.status
	}
	return 500
}

func (a *App) loadHistory(ctx context.Context, conversationID, userID, exclude string) []chat.HistoryItem {
	limit := 6
	if raw := os.Getenv("ANSWER_HISTORY_LIMIT"); raw != "" {
		n := 0
		ok := true
		for _, c := range raw {
			if c < '0' || c > '9' {
				ok = false
				break
			}
			n = n*10 + int(c-'0')
		}
		if ok && n > 0 {
			limit = n
		}
	}
	rows, err := a.Pool.Query(ctx, `SELECT role, content, status FROM messages WHERE conversation_id=$1 AND user_id=$2 AND id<>$3 AND status IN ('completed','interrupted') ORDER BY created_at DESC, id DESC LIMIT 80`, conversationID, userID, exclude)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var newest []chat.HistoryItem
	for rows.Next() {
		var item chat.HistoryItem
		if err := rows.Scan(&item.Role, &item.Content, &item.Status); err != nil {
			continue
		}
		if visibility.IsModelVisible(item.Role, item.Content, item.Status) {
			newest = append(newest, item)
		}
		if len(newest) >= limit {
			break
		}
	}
	for i, j := 0, len(newest)-1; i < j; i, j = i+1, j-1 {
		newest[i], newest[j] = newest[j], newest[i]
	}
	return newest
}

func (a *App) loadSummary(ctx context.Context, conversationID, userID string) string {
	var summary string
	_ = a.Pool.QueryRow(ctx, `SELECT summary_text FROM conversation_context_states WHERE conversation_id=$1 AND user_id=$2`, conversationID, userID).Scan(&summary)
	return summary
}

func (a *App) insertMessage(ctx context.Context, id, userID, conversationID, role, content, status string) error {
	var prev string
	_ = a.Pool.QueryRow(ctx, `SELECT created_at FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1`, conversationID, userID).Scan(&prev)
	_, err := a.Pool.Exec(ctx, `INSERT INTO messages (id,user_id,conversation_id,role,content,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, userID, conversationID, role, content, status, idgen.AfterISO(prev))
	if err == nil {
		a.syncSearchDocument(ctx, id)
	}
	return err
}

func (a *App) finishMessage(ctx context.Context, id, userID, content, status string) error {
	_, err := a.Pool.Exec(ctx, `UPDATE messages SET content=$1, status=$2 WHERE id=$3 AND user_id=$4`, content, status, id, userID)
	if err == nil {
		a.syncSearchDocument(ctx, id)
	}
	return err
}

func (a *App) userMessageContent(ctx context.Context, input string, ids []string) string {
	if len(ids) == 0 {
		return input
	}
	var lines []string
	for _, id := range ids {
		var mime string
		var name *string
		_ = a.Pool.QueryRow(ctx, `SELECT mime_type, original_name FROM attachments WHERE id=$1`, id).Scan(&mime, &name)
		if strings.HasPrefix(mime, "image/") {
			lines = append(lines, "![image](/api/files/"+id+")")
			continue
		}
		label := "表格附件"
		if name != nil && *name != "" {
			label = strings.NewReplacer("[", "", "]", "", "(", "", ")", "", "`", "").Replace(*name)
			if len([]rune(label)) > 120 {
				label = string([]rune(label)[:120])
			}
		}
		lines = append(lines, "["+label+"](/api/files/"+id+")")
	}
	joined := strings.Join(lines, "\n")
	if input == "" {
		return joined
	}
	return input + "\n\n" + joined
}

func (a *App) countValidAttachments(ctx context.Context, ids []string, userID, conversationID string) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	args := make([]any, 0, len(ids)+2)
	for _, id := range ids {
		args = append(args, id)
	}
	args = append(args, userID, conversationID)
	rows, err := a.Pool.Query(ctx, `SELECT id, file_path FROM attachments WHERE id IN (`+placeholders(len(ids), 1)+`) AND user_id=$`+itoa(len(ids)+1)+` AND conversation_id=$`+itoa(len(ids)+2)+` AND message_id IS NULL AND (mime_type LIKE 'image/%' OR lower(original_name) LIKE '%.csv' OR lower(original_name) LIKE '%.xlsx')`, args...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id, filePath string
		if err := rows.Scan(&id, &filePath); err != nil {
			return 0, err
		}
		if paths.IsWorkspaceAttachment(filePath, conversationID, "input") {
			count++
		}
	}
	return count, nil
}

func (a *App) linkAttachments(ctx context.Context, ids []string, userID, conversationID, messageID string) error {
	if len(ids) == 0 {
		return nil
	}
	count, err := a.countValidAttachments(ctx, ids, userID, conversationID)
	if err != nil || count == 0 {
		return err
	}
	args := []any{messageID}
	for _, id := range ids {
		args = append(args, id)
	}
	args = append(args, userID, conversationID)
	_, err = a.Pool.Exec(ctx, `UPDATE attachments SET message_id=$1 WHERE id IN (`+placeholders(len(ids), 2)+`) AND user_id=$`+itoa(len(ids)+2)+` AND conversation_id=$`+itoa(len(ids)+3)+` AND message_id IS NULL`, args...)
	return err
}

type cloneFile struct {
	ID, FilePath, Name, Mime string
	Size                     int64
}

func (a *App) listMessageAttachments(ctx context.Context, messageID, conversationID, userID string) []cloneFile {
	rows, err := a.Pool.Query(ctx, `SELECT id, file_path, original_name, mime_type, size FROM attachments WHERE message_id=$1 AND conversation_id=$2 AND user_id=$3 ORDER BY created_at ASC, id ASC`, messageID, conversationID, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []cloneFile
	for rows.Next() {
		var item cloneFile
		var name *string
		if err := rows.Scan(&item.ID, &item.FilePath, &name, &item.Mime, &item.Size); err == nil {
			if name != nil {
				item.Name = *name
			}
			out = append(out, item)
		}
	}
	return out
}

func (a *App) cloneAttachments(ctx context.Context, sources []cloneFile, userID, conversationID string) ([]cloneFile, error) {
	var clones []cloneFile
	dir := paths.ConversationInputDir(conversationID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	for _, source := range sources {
		id := idgen.NewID("att")
		ext := filepath.Ext(source.FilePath)
		if ext == "" {
			ext = filepath.Ext(source.Name)
		}
		if ext == "" {
			ext = ".img"
		}
		path := filepath.Join(dir, id+ext)
		in, err := os.Open(source.FilePath)
		if err != nil {
			return clones, err
		}
		out, err := os.Create(path)
		if err != nil {
			in.Close()
			return clones, err
		}
		_, err = io.Copy(out, in)
		in.Close()
		out.Close()
		if err != nil {
			return clones, err
		}
		_, err = a.Pool.Exec(ctx, `INSERT INTO attachments (id,user_id,conversation_id,original_name,file_path,public_path,mime_type,size,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, userID, conversationID, source.Name, path, "/api/files/"+id, source.Mime, source.Size, idgen.NowISO())
		if err != nil {
			_ = os.Remove(path)
			return clones, err
		}
		clones = append(clones, cloneFile{ID: id, FilePath: path})
	}
	return clones, nil
}

func (a *App) discardClones(ctx context.Context, clones []cloneFile, userID string) {
	if len(clones) == 0 {
		return
	}
	args := []any{userID}
	for _, clone := range clones {
		args = append(args, clone.ID)
		_ = os.Remove(clone.FilePath)
	}
	_, _ = a.Pool.Exec(ctx, `DELETE FROM attachments WHERE user_id=$1 AND message_id IS NULL AND id IN (`+placeholders(len(clones), 2)+`)`, args...)
}

func (a *App) replaceLatest(ctx context.Context, conversationID, userID string, pair *messagePair, content, assistantID string) error {
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var streaming string
	if err = tx.QueryRow(ctx, `SELECT id FROM messages WHERE conversation_id=$1 AND user_id=$2 AND role='assistant' AND status='streaming' LIMIT 1`, conversationID, userID).Scan(&streaming); err == nil {
		return &httpStatusError{409, "会话正在生成回复"}
	} else if err != pgx.ErrNoRows {
		return err
	}
	if !pair.IsLatest {
		return &httpStatusError{409, "该消息已不是最新问题"}
	}
	if _, err = tx.Exec(ctx, `UPDATE messages SET content=$1, status='completed' WHERE id=$2 AND conversation_id=$3 AND user_id=$4 AND role='user'`, content, pair.User.ID, conversationID, userID); err != nil {
		return err
	}
	if pair.Assistant != nil {
		if _, err = tx.Exec(ctx, `UPDATE messages SET content='', status='streaming' WHERE id=$1 AND conversation_id=$2 AND user_id=$3 AND role='assistant'`, assistantID, conversationID, userID); err != nil {
			return err
		}
	} else {
		if _, err = tx.Exec(ctx, `INSERT INTO messages (id,user_id,conversation_id,role,content,status,created_at) VALUES ($1,$2,$3,'assistant','','streaming',$4)`, assistantID, userID, conversationID, idgen.NowISO()); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET updated_at=$1 WHERE id=$2 AND user_id=$3`, idgen.NowISO(), conversationID, userID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	a.syncSearchDocument(ctx, pair.User.ID)
	a.syncSearchDocument(ctx, assistantID)
	return nil
}

func (a *App) recordUsage(ctx context.Context, userID, conversationID, messageID, userInput string, history []chat.HistoryItem, output string, usage *llm.Usage) {
	prompt, completion, total := 0, 0, 0
	model := llm.ModelName()
	var measured, cached *int
	if usage != nil && usage.TotalTokens > 0 {
		prompt, completion, total = usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens
		if usage.Model != "" {
			model = usage.Model
		}
		measured, cached = usage.CacheMeasuredPromptTokens, usage.CachedTokens
	} else {
		var b strings.Builder
		for _, item := range history {
			b.WriteString(item.Content)
			b.WriteByte('\n')
		}
		b.WriteString(userInput)
		prompt = max(1, (len(b.String())+3)/4)
		completion = max(1, (len(output)+3)/4)
		total = prompt + completion
	}
	if total <= 0 {
		return
	}
	_, _ = a.Pool.Exec(ctx, `INSERT INTO token_usage (user_id,conversation_id,message_id,model,prompt_tokens,completion_tokens,total_tokens,cache_measured_prompt_tokens,cached_tokens,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, userID, conversationID, messageID, model, prompt, completion, total, measured, cached, idgen.NowISO())
}

func mergeUsage(current, next *llm.Usage) *llm.Usage {
	if next == nil {
		return current
	}
	if current == nil {
		copy := *next
		return &copy
	}
	current.PromptTokens += next.PromptTokens
	current.CompletionTokens += next.CompletionTokens
	current.TotalTokens += next.TotalTokens
	if next.Model != "" {
		current.Model = next.Model
	}
	if next.CacheMeasuredPromptTokens != nil && next.CachedTokens != nil {
		baseM, baseC := 0, 0
		if current.CacheMeasuredPromptTokens != nil {
			baseM = *current.CacheMeasuredPromptTokens
		}
		if current.CachedTokens != nil {
			baseC = *current.CachedTokens
		}
		m := baseM + *next.CacheMeasuredPromptTokens
		c := baseC + *next.CachedTokens
		current.CacheMeasuredPromptTokens = &m
		current.CachedTokens = &c
	}
	return current
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
