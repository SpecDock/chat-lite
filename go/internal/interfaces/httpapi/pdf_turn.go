package httpapi

import (
	"context"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"chatlite/internal/application/rag"
	"chatlite/internal/infrastructure/pdftext"
	"chatlite/internal/infrastructure/storage"
)

func isPDFName(name, mime string) bool {
	return strings.HasSuffix(strings.ToLower(name), ".pdf") || strings.EqualFold(mime, "application/pdf")
}

func (a *App) turnHasPDF(ctx context.Context, ids []string) bool {
	for _, id := range ids {
		var name, mime string
		if a.Pool.QueryRow(ctx, `SELECT COALESCE(original_name,''), COALESCE(mime_type,'') FROM attachments WHERE id=$1`, id).Scan(&name, &mime) != nil {
			continue
		}
		if isPDFName(name, mime) {
			return true
		}
	}
	return false
}

func (a *App) parseTurnPDFs(ctx context.Context, userID, conversationID string, ids []string, think func(string)) string {
	var bodies []string
	for _, id := range ids {
		var name, path, mime, status string
		err := a.Pool.QueryRow(ctx, `SELECT COALESCE(original_name,''), file_path, COALESCE(mime_type,''), COALESCE(pdf_status,'') FROM attachments WHERE id=$1 AND user_id=$2 AND conversation_id=$3`, id, userID, conversationID).Scan(&name, &path, &mime, &status)
		if err != nil || !isPDFName(name, mime) || status != "" {
			continue
		}
		think("正在解析 PDF：" + name)
		data, readErr := storage.Read(ctx, path)
		if readErr != nil {
			think("PDF 解析失败：" + name)
			_, _ = a.Pool.Exec(ctx, `UPDATE attachments SET pdf_status='failed', pdf_chars=0 WHERE id=$1`, id)
			continue
		}
		tmp, tmpErr := os.CreateTemp("", "chatlite-*.pdf")
		if tmpErr != nil {
			think("PDF 解析失败：" + name)
			_, _ = a.Pool.Exec(ctx, `UPDATE attachments SET pdf_status='failed', pdf_chars=0 WHERE id=$1`, id)
			continue
		}
		_, writeErr := tmp.Write(data)
		tmp.Close()
		if writeErr != nil {
			_ = os.Remove(tmp.Name())
			think("PDF 解析失败：" + name)
			_, _ = a.Pool.Exec(ctx, `UPDATE attachments SET pdf_status='failed', pdf_chars=0 WHERE id=$1`, id)
			continue
		}
		extracted := pdftext.Extract(tmp.Name())
		_ = os.Remove(tmp.Name())
		text := extracted.Text
		n := utf8.RuneCountInString(strings.TrimSpace(text))
		if extracted.Failure != "" {
			think(name + "：" + extracted.Failure)
			_, _ = a.Pool.Exec(ctx, `UPDATE attachments SET pdf_status='ocr_failed', pdf_chars=$2, pdf_inline=$3 WHERE id=$1`, id, n, extracted.Failure)
			continue
		}
		if strings.TrimSpace(text) == "" {
			think("PDF 解析失败：" + name)
			_, _ = a.Pool.Exec(ctx, `UPDATE attachments SET pdf_status='failed', pdf_chars=0 WHERE id=$1`, id)
			continue
		}
		if n < pdftext.MinRunes {
			think("文本过少，未入库：" + name)
			_, _ = a.Pool.Exec(ctx, `UPDATE attachments SET pdf_status='too_short', pdf_chars=$2 WHERE id=$1`, id, n)
			continue
		}
		var inline any
		if n <= pdftext.InlineRunes {
			inline = strings.TrimSpace(text)
		}
		bodies = append(bodies, name+"\n"+pdftext.Clip(text, pdftext.IndexRunes))
		line := "PDF 已解析并入库：" + name + "，约 " + strconv.Itoa(n) + " 字"
		if n > pdftext.IndexRunes {
			line += "，检索只收入前 40000 字"
		}
		think(line)
		_, _ = a.Pool.Exec(ctx, `UPDATE attachments SET pdf_status='indexed', pdf_chars=$2, pdf_inline=$3 WHERE id=$1`, id, n, inline)
	}
	return strings.Join(bodies, "\n\n")
}

func (a *App) indexTurnWithPDF(ctx context.Context, userID, conversationID, messageID, userText string, ids []string, extra string) {
	content := a.userMessageContent(ctx, userText, ids)
	if strings.TrimSpace(extra) != "" {
		content += "\n\n" + extra
	}
	if err := rag.IndexNow(ctx, a.Pool, rag.IndexInput{
		UserID: userID, ConversationID: conversationID, MessageID: messageID,
		Role: "user", Content: content, Status: "completed", MaxChars: pdftext.IndexRunes,
	}); err != nil {
		// 检索失败不阻断这一轮。短文仍会附在消息里。
	}
}
