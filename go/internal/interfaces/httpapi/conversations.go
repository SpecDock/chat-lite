package httpapi

import (
	"context"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"chatlite/internal/application/rag"
	"chatlite/internal/platform/httpx"
	"chatlite/internal/platform/idgen"
	"chatlite/internal/platform/paths"
)

type conversationDTO struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	PinnedAt  *string `json:"pinned_at"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

type messageDTO struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id"`
	Role           string `json:"role"`
	Content        string `json:"content"`
	Status         string `json:"status"`
	CreatedAt      string `json:"created_at"`
}

type messagePair struct {
	User      messageDTO
	Assistant *messageDTO
	IsFirst   bool
	IsLatest  bool
}

type attachmentFile struct {
	ID       string
	FilePath string
}

func (a *App) registerConversations(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/conversations", a.withAuth(a.listConversations))
	mux.HandleFunc("POST /api/conversations", a.withAuth(a.createConversationRoute))
	mux.HandleFunc("GET /api/conversations/{id}", a.withAuth(a.getConversationRoute))
	mux.HandleFunc("PATCH /api/conversations/{id}", a.withAuth(a.patchConversation))
	mux.HandleFunc("DELETE /api/conversations/{id}", a.withAuth(a.deleteConversationRoute))
	mux.HandleFunc("GET /api/conversations/{id}/messages", a.withAuth(a.listMessagesRoute))
	mux.HandleFunc("DELETE /api/conversations/{id}/messages/{messageId}", a.withAuth(a.deleteMessagePairRoute))
}

func safeTitle(text string) string {
	text = strings.Join(strings.Fields(strings.TrimSpace(text)), " ")
	runes := []rune(text)
	if len(runes) > 40 {
		text = string(runes[:40])
	}
	if text == "" {
		return "新会话"
	}
	return text
}

func (a *App) listConversations(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	rows, err := a.Pool.Query(r.Context(), `SELECT id,title,pinned_at,created_at,updated_at FROM conversations WHERE user_id=$1 ORDER BY pinned_at DESC NULLS LAST, updated_at DESC, id DESC`, user.UserID)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	defer rows.Close()
	list := []conversationDTO{}
	for rows.Next() {
		var item conversationDTO
		if err := rows.Scan(&item.ID, &item.Title, &item.PinnedAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
			httpx.Error(w, 500, "服务器错误")
			return
		}
		list = append(list, item)
	}
	httpx.WriteJSON(w, 200, map[string]any{"conversations": list})
}

func (a *App) createConversationRoute(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	body := httpx.ReadJSON(r, 1<<20)
	title := safeTitle(httpx.AsString(body["title"]))
	if strings.TrimSpace(httpx.AsString(body["title"])) == "" {
		title = safeTitle("新会话")
	}
	id := idgen.NewID("conv")
	conv, err := a.createConversation(r.Context(), id, user.UserID, title)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	emitToUser(user.UserID, "conversations_changed", map[string]any{"conversationId": id, "reason": "created"})
	httpx.WriteJSON(w, 200, map[string]any{"conversation": conv})
}

func (a *App) getConversationRoute(w http.ResponseWriter, r *http.Request) {
	conv, err := a.getConversation(r.Context(), r.PathValue("id"), authFrom(r).UserID)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	if conv == nil {
		httpx.Error(w, 404, "会话不存在")
		return
	}
	httpx.WriteJSON(w, 200, map[string]any{"conversation": conv})
}

func (a *App) patchConversation(w http.ResponseWriter, r *http.Request) {
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
	body := httpx.ReadJSON(r, 1<<20)
	if len(body) != 1 {
		httpx.Error(w, 400, "请求必须包含且仅包含一个有效操作")
		return
	}
	var conv *conversationDTO
	var reason string
	if pinned, ok := body["pinned"].(bool); ok && len(body) == 1 {
		var pin any
		if pinned {
			now := idgen.NowISO()
			pin = now
			reason = "pinned"
		} else {
			reason = "unpinned"
		}
		if _, err = a.Pool.Exec(r.Context(), `UPDATE conversations SET pinned_at=$1 WHERE id=$2 AND user_id=$3`, pin, id, user.UserID); err != nil {
			httpx.Error(w, 500, "服务器错误")
			return
		}
	} else if title, ok := body["title"].(string); ok {
		title = strings.Join(strings.Fields(strings.TrimSpace(title)), " ")
		if title == "" || len([]rune(title)) > 40 {
			httpx.Error(w, 400, "标题长度必须为 1 到 40 个字符")
			return
		}
		if _, err = a.Pool.Exec(r.Context(), `UPDATE conversations SET title=$1, title_manually_set=TRUE WHERE id=$2 AND user_id=$3`, title, id, user.UserID); err != nil {
			httpx.Error(w, 500, "服务器错误")
			return
		}
		reason = "renamed"
	} else {
		httpx.Error(w, 400, "请求必须包含且仅包含一个有效操作")
		return
	}
	conv, err = a.getConversation(r.Context(), id, user.UserID)
	if err != nil || conv == nil {
		httpx.Error(w, 404, "会话不存在")
		return
	}
	emitToUser(user.UserID, "conversations_changed", map[string]any{"conversationId": id, "reason": reason})
	httpx.WriteJSON(w, 200, map[string]any{"conversation": conv})
}

func (a *App) deleteConversationRoute(w http.ResponseWriter, r *http.Request) {
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
	if streaming, err := a.hasStreaming(r.Context(), id, user.UserID); err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	} else if streaming {
		httpx.Error(w, 409, "会话正在生成回复，请先停止生成后再删除")
		return
	}
	files, err := a.deleteConversationData(r.Context(), id, user.UserID)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	for _, file := range files {
		_ = os.Remove(file.FilePath)
	}
	_ = os.RemoveAll(paths.ConversationWorkspaceDir(id))
	rag.DeleteConversation(r.Context(), a.Pool, id)
	emitToUser(user.UserID, "conversation_deleted", map[string]any{"conversationId": id})
	emitToUser(user.UserID, "conversations_changed", map[string]any{"conversationId": id, "reason": "deleted"})
	httpx.WriteJSON(w, 200, map[string]bool{"ok": true})
}

func (a *App) listMessagesRoute(w http.ResponseWriter, r *http.Request) {
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
	rows, err := a.Pool.Query(r.Context(), `SELECT id,conversation_id,role,content,status,created_at FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC, id ASC`, id, user.UserID)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	defer rows.Close()
	list := []messageDTO{}
	for rows.Next() {
		var item messageDTO
		if err := rows.Scan(&item.ID, &item.ConversationID, &item.Role, &item.Content, &item.Status, &item.CreatedAt); err != nil {
			httpx.Error(w, 500, "服务器错误")
			return
		}
		list = append(list, item)
	}
	httpx.WriteJSON(w, 200, map[string]any{"messages": list})
}

func (a *App) deleteMessagePairRoute(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	conversationID := r.PathValue("id")
	exists, err := a.conversationExists(r.Context(), conversationID, user.UserID)
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	if !exists {
		httpx.Error(w, 404, "会话不存在")
		return
	}
	if streaming, err := a.hasStreaming(r.Context(), conversationID, user.UserID); err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	} else if streaming {
		httpx.Error(w, 409, "会话正在生成回复")
		return
	}
	pair, err := a.getMessagePair(r.Context(), conversationID, user.UserID, r.PathValue("messageId"))
	if err != nil {
		httpx.Error(w, 500, "服务器错误")
		return
	}
	if pair == nil {
		httpx.Error(w, 404, "用户消息不存在")
		return
	}
	assistantContent := ""
	if pair.Assistant != nil {
		assistantContent = pair.Assistant.Content
	}
	refs := attachmentIDsFromContent(pair.User.Content + "\n" + assistantContent)
	deleted, files, next, err := a.deleteMessagePairData(r.Context(), conversationID, user.UserID, pair, refs)
	if err != nil {
		status := 500
		if he, ok := err.(*httpStatusError); ok {
			status = he.status
		}
		httpx.Error(w, status, err.Error())
		return
	}
	for _, file := range files {
		_ = os.Remove(file.FilePath)
	}
	if deleted {
		_ = os.RemoveAll(paths.ConversationWorkspaceDir(conversationID))
		rag.DeleteConversation(r.Context(), a.Pool, conversationID)
	} else {
		rag.DeleteMessage(r.Context(), a.Pool, user.UserID, pair.User.ID)
		if pair.Assistant != nil {
			rag.DeleteMessage(r.Context(), a.Pool, user.UserID, pair.Assistant.ID)
		}
		if pair.IsFirst && next != nil {
			nextInput := stripUserImageContent(next.User.Content)
			_ = a.updateAutoTitle(r.Context(), conversationID, user.UserID, safeTitle(nextInput))
		}
	}
	assistantID := any(nil)
	if pair.Assistant != nil {
		assistantID = pair.Assistant.ID
	}
	emitToUser(user.UserID, "messages_changed", map[string]any{"conversationId": conversationID, "reason": "pair_deleted", "userMessageId": pair.User.ID, "messageId": assistantID})
	reason := "updated"
	if deleted {
		emitToUser(user.UserID, "conversation_deleted", map[string]any{"conversationId": conversationID})
		reason = "deleted"
	}
	emitToUser(user.UserID, "conversations_changed", map[string]any{"conversationId": conversationID, "reason": reason})
	httpx.WriteJSON(w, 200, map[string]any{"ok": true, "conversationDeleted": deleted})
}

type httpStatusError struct {
	status int
	msg    string
}

func (e *httpStatusError) Error() string { return e.msg }

func (a *App) createConversation(ctx context.Context, id, userID, title string) (*conversationDTO, error) {
	if err := paths.EnsureConversationWorkspace(id); err != nil {
		return nil, err
	}
	now := idgen.NowISO()
	_, err := a.Pool.Exec(ctx, `INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES ($1,$2,$3,$4,$5)`, id, userID, title, now, now)
	if err != nil {
		return nil, err
	}
	return a.getConversation(ctx, id, userID)
}

func (a *App) getConversation(ctx context.Context, id, userID string) (*conversationDTO, error) {
	var item conversationDTO
	err := a.Pool.QueryRow(ctx, `SELECT id,title,pinned_at,created_at,updated_at FROM conversations WHERE id=$1 AND user_id=$2`, id, userID).
		Scan(&item.ID, &item.Title, &item.PinnedAt, &item.CreatedAt, &item.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (a *App) conversationExists(ctx context.Context, id, userID string) (bool, error) {
	var found string
	err := a.Pool.QueryRow(ctx, `SELECT id FROM conversations WHERE id=$1 AND user_id=$2`, id, userID).Scan(&found)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

func (a *App) hasStreaming(ctx context.Context, conversationID, userID string) (bool, error) {
	var id string
	err := a.Pool.QueryRow(ctx, `SELECT id FROM messages WHERE conversation_id=$1 AND user_id=$2 AND role='assistant' AND status='streaming' LIMIT 1`, conversationID, userID).Scan(&id)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

func (a *App) updateAutoTitle(ctx context.Context, conversationID, userID, title string) error {
	_, err := a.Pool.Exec(ctx, `UPDATE conversations SET title=$1 WHERE id=$2 AND user_id=$3 AND title_manually_set=FALSE`, title, conversationID, userID)
	return err
}

func (a *App) touchConversation(ctx context.Context, conversationID, userID string) {
	_, _ = a.Pool.Exec(ctx, `UPDATE conversations SET updated_at=$1 WHERE id=$2 AND user_id=$3`, idgen.NowISO(), conversationID, userID)
}

func (a *App) deleteConversationData(ctx context.Context, conversationID, userID string) ([]attachmentFile, error) {
	rows, err := a.Pool.Query(ctx, `SELECT id,file_path FROM attachments WHERE conversation_id=$1 AND user_id=$2`, conversationID, userID)
	if err != nil {
		return nil, err
	}
	var files []attachmentFile
	for rows.Next() {
		var file attachmentFile
		if err := rows.Scan(&file.ID, &file.FilePath); err != nil {
			rows.Close()
			return nil, err
		}
		files = append(files, file)
	}
	rows.Close()
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if len(files) > 0 {
		ids := make([]any, len(files))
		for i, file := range files {
			ids[i] = file.ID
		}
		ph := placeholders(len(files), 1)
		args := append(ids, userID)
		if _, err = tx.Exec(ctx, `UPDATE users SET avatar_attachment_id=NULL WHERE avatar_attachment_id IN (`+ph+`) AND id=$`+itoa(len(files)+1), args...); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM image_generations WHERE result_attachment_id IN (`+ph+`) AND user_id=$`+itoa(len(files)+1), args...); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM attachments WHERE id IN (`+ph+`) AND user_id=$`+itoa(len(files)+1), args...); err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM messages WHERE conversation_id=$1 AND user_id=$2`, conversationID, userID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM conversations WHERE id=$1 AND user_id=$2`, conversationID, userID); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return files, nil
}

func (a *App) getMessagePair(ctx context.Context, conversationID, userID, userMessageID string) (*messagePair, error) {
	var user messageDTO
	err := a.Pool.QueryRow(ctx, `SELECT id,conversation_id,role,content,status,created_at FROM messages WHERE id=$1 AND conversation_id=$2 AND user_id=$3 AND role='user'`, userMessageID, conversationID, userID).
		Scan(&user.ID, &user.ConversationID, &user.Role, &user.Content, &user.Status, &user.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var assistant messageDTO
	err = a.Pool.QueryRow(ctx, `SELECT id,conversation_id,role,content,status,created_at FROM messages candidate
		WHERE candidate.conversation_id=$1 AND candidate.user_id=$2 AND candidate.role='assistant' AND candidate.created_at>$3
		AND NOT EXISTS (
			SELECT 1 FROM messages boundary WHERE boundary.conversation_id=candidate.conversation_id AND boundary.user_id=candidate.user_id
			AND boundary.role='user' AND boundary.created_at>$3 AND boundary.created_at<candidate.created_at
		)
		ORDER BY candidate.created_at ASC, candidate.id ASC LIMIT 1`, conversationID, userID, user.CreatedAt).
		Scan(&assistant.ID, &assistant.ConversationID, &assistant.Role, &assistant.Content, &assistant.Status, &assistant.CreatedAt)
	var assistantPtr *messageDTO
	if err == nil {
		assistantPtr = &assistant
	} else if err != pgx.ErrNoRows {
		return nil, err
	}
	var firstAt, latestAt string
	_ = a.Pool.QueryRow(ctx, `SELECT created_at FROM messages WHERE conversation_id=$1 AND user_id=$2 AND role='user' ORDER BY created_at ASC, id ASC LIMIT 1`, conversationID, userID).Scan(&firstAt)
	_ = a.Pool.QueryRow(ctx, `SELECT created_at FROM messages WHERE conversation_id=$1 AND user_id=$2 AND role='user' ORDER BY created_at DESC, id DESC LIMIT 1`, conversationID, userID).Scan(&latestAt)
	return &messagePair{User: user, Assistant: assistantPtr, IsFirst: firstAt == user.CreatedAt, IsLatest: latestAt == user.CreatedAt}, nil
}

func (a *App) deleteMessagePairData(ctx context.Context, conversationID, userID string, pair *messagePair, refs []string) (bool, []attachmentFile, *messagePair, error) {
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return false, nil, nil, err
	}
	defer tx.Rollback(ctx)
	var streaming string
	err = tx.QueryRow(ctx, `SELECT id FROM messages WHERE conversation_id=$1 AND user_id=$2 AND role='assistant' AND status='streaming' LIMIT 1`, conversationID, userID).Scan(&streaming)
	if err == nil {
		return false, nil, nil, &httpStatusError{409, "会话正在生成回复"}
	}
	messageIDs := []string{pair.User.ID}
	if pair.Assistant != nil {
		messageIDs = append(messageIDs, pair.Assistant.ID)
	}
	files, err := attachmentsForRemoval(ctx, tx, conversationID, userID, messageIDs, refs, "")
	if err != nil {
		return false, nil, nil, err
	}
	if err = deleteAttachmentRows(ctx, tx, files, userID); err != nil {
		return false, nil, nil, err
	}
	args := make([]any, 0, len(messageIDs)+2)
	for _, id := range messageIDs {
		args = append(args, id)
	}
	args = append(args, conversationID, userID)
	if _, err = tx.Exec(ctx, `DELETE FROM messages WHERE id IN (`+placeholders(len(messageIDs), 1)+`) AND conversation_id=$`+itoa(len(messageIDs)+1)+` AND user_id=$`+itoa(len(messageIDs)+2), args...); err != nil {
		return false, nil, nil, err
	}
	var remaining int
	if err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE conversation_id=$1 AND user_id=$2 AND role='user'`, conversationID, userID).Scan(&remaining); err != nil {
		return false, nil, nil, err
	}
	if remaining == 0 {
		rows, err := tx.Query(ctx, `SELECT id,file_path FROM attachments WHERE conversation_id=$1 AND user_id=$2`, conversationID, userID)
		if err != nil {
			return false, nil, nil, err
		}
		var rest []attachmentFile
		for rows.Next() {
			var file attachmentFile
			if err = rows.Scan(&file.ID, &file.FilePath); err != nil {
				rows.Close()
				return false, nil, nil, err
			}
			rest = append(rest, file)
		}
		rows.Close()
		if err = deleteAttachmentRows(ctx, tx, rest, userID); err != nil {
			return false, nil, nil, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM conversations WHERE id=$1 AND user_id=$2`, conversationID, userID); err != nil {
			return false, nil, nil, err
		}
		if err = tx.Commit(ctx); err != nil {
			return false, nil, nil, err
		}
		return true, append(files, rest...), nil, nil
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET updated_at=$1 WHERE id=$2 AND user_id=$3`, idgen.NowISO(), conversationID, userID); err != nil {
		return false, nil, nil, err
	}
	_, _ = tx.Exec(ctx, `UPDATE conversation_context_snapshots SET status='invalid' WHERE conversation_id=$1 AND user_id=$2 AND (covered_message_created_at>$3 OR (covered_message_created_at=$3 AND covered_message_id>=$4))`, conversationID, userID, pair.User.CreatedAt, pair.User.ID)
	if err = tx.Commit(ctx); err != nil {
		return false, nil, nil, err
	}
	var nextID string
	err = a.Pool.QueryRow(ctx, `SELECT id FROM messages WHERE conversation_id=$1 AND user_id=$2 AND role='user' ORDER BY created_at ASC, id ASC LIMIT 1`, conversationID, userID).Scan(&nextID)
	var next *messagePair
	if err == nil {
		next, _ = a.getMessagePair(ctx, conversationID, userID, nextID)
	}
	return false, files, next, nil
}

func attachmentsForRemoval(ctx context.Context, tx pgx.Tx, conversationID, userID string, messageIDs, refs []string, protect string) ([]attachmentFile, error) {
	if len(messageIDs) == 0 && len(refs) == 0 {
		return nil, nil
	}
	args := []any{conversationID, userID}
	clauses := []string{}
	if len(messageIDs) > 0 {
		start := len(args) + 1
		clauses = append(clauses, `message_id IN (`+placeholders(len(messageIDs), start)+`)`)
		for _, id := range messageIDs {
			args = append(args, id)
		}
	}
	if len(refs) > 0 {
		start := len(args) + 1
		clauses = append(clauses, `(id IN (`+placeholders(len(refs), start)+`) AND message_id IS NULL)`)
		for _, id := range refs {
			args = append(args, id)
		}
	}
	sql := `SELECT id,file_path FROM attachments WHERE conversation_id=$1 AND user_id=$2 AND (` + strings.Join(clauses, " OR ") + `)`
	if protect != "" {
		args = append(args, protect)
		sql += ` AND (message_id IS NULL OR message_id<>$` + itoa(len(args)) + `)`
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var files []attachmentFile
	for rows.Next() {
		var file attachmentFile
		if err := rows.Scan(&file.ID, &file.FilePath); err != nil {
			return nil, err
		}
		files = append(files, file)
	}
	return files, nil
}

func deleteAttachmentRows(ctx context.Context, tx pgx.Tx, files []attachmentFile, userID string) error {
	if len(files) == 0 {
		return nil
	}
	args := make([]any, 0, len(files)+1)
	for _, file := range files {
		args = append(args, file.ID)
	}
	args = append(args, userID)
	ph := placeholders(len(files), 1)
	userPh := "$" + itoa(len(files)+1)
	if _, err := tx.Exec(ctx, `UPDATE users SET avatar_attachment_id=NULL WHERE avatar_attachment_id IN (`+ph+`) AND id=`+userPh, args...); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM image_generations WHERE result_attachment_id IN (`+ph+`) AND user_id=`+userPh, args...); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM attachments WHERE id IN (`+ph+`) AND user_id=`+userPh, args...)
	return err
}

func itoa(n int) string {
	return strconv.Itoa(n)
}

var fileRefRE = regexp.MustCompile(`!?\[[^\]]*\]\(/api/files/([^\s)]+)(?:\s+["'][^"']*["'])?\)`)

func attachmentIDsFromContent(content string) []string {
	seen := map[string]struct{}{}
	var ids []string
	for _, match := range fileRefRE.FindAllStringSubmatch(content, -1) {
		id := match[1]
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids
}

func stripUserImageContent(content string) string {
	text := fileRefRE.ReplaceAllString(content, "")
	text = regexp.MustCompile(`[ \t]+\n`).ReplaceAllString(text, "\n")
	text = regexp.MustCompile(`\n{3,}`).ReplaceAllString(text, "\n\n")
	return strings.TrimSpace(text)
}
