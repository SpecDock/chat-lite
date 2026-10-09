package uploads

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/infrastructure/authsec"
	"chatlite/internal/platform/idgen"
	"chatlite/internal/platform/paths"
)

type FileBytes struct {
	Buffer   []byte
	Filename string
	MimeType string
}

type Attachment struct {
	ID           string `json:"id"`
	OriginalName string `json:"original_name"`
	PublicPath   string `json:"public_path"`
	MimeType     string `json:"mime_type"`
	Size         int64  `json:"size"`
	CreatedAt    string `json:"created_at"`
}

type StatusError struct {
	Status  int
	Message string
}

func (e *StatusError) Error() string { return e.Message }

func SaveImageBuffer(ctx context.Context, pool *pgxpool.Pool, userID string, file FileBytes, conversationID string, maxBytes int64, maxLabel, bucket string) (Attachment, error) {
	if !authsec.AllowedImage(file.MimeType) {
		return Attachment{}, &StatusError{Status: 400, Message: "仅支持 jpeg/png/webp 图片"}
	}
	if int64(len(file.Buffer)) > maxBytes {
		return Attachment{}, &StatusError{Status: 400, Message: "图片不能超过 " + maxLabel}
	}
	ext := ".jpg"
	switch file.MimeType {
	case "image/png":
		ext = ".png"
	case "image/webp":
		ext = ".webp"
	default:
		if e := strings.ToLower(filepath.Ext(file.Filename)); e != "" {
			ext = e
		}
	}
	id := idgen.NewID("att")
	var dir string
	if conversationID != "" {
		if err := paths.EnsureConversationWorkspace(conversationID); err != nil {
			return Attachment{}, err
		}
		if bucket == "output" {
			dir = paths.ConversationOutputDir(conversationID)
		} else {
			dir = paths.ConversationInputDir(conversationID)
		}
	} else {
		dir = filepath.Join(paths.UploadDir(), userID)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Attachment{}, err
	}
	filePath := filepath.Join(dir, id+ext)
	if err := os.WriteFile(filePath, file.Buffer, 0o644); err != nil {
		return Attachment{}, err
	}
	publicPath := "/api/files/" + id
	createdAt := idgen.NowISO()
	var conv any
	if conversationID != "" {
		conv = conversationID
	}
	_, err := pool.Exec(ctx, `INSERT INTO attachments (id,user_id,conversation_id,original_name,file_path,public_path,mime_type,size,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		id, userID, conv, file.Filename, filePath, publicPath, file.MimeType, len(file.Buffer), createdAt)
	if err != nil {
		_ = os.Remove(filePath)
		return Attachment{}, err
	}
	return Attachment{ID: id, OriginalName: file.Filename, PublicPath: publicPath, MimeType: file.MimeType, Size: int64(len(file.Buffer)), CreatedAt: createdAt}, nil
}

func UserConversationExists(ctx context.Context, pool *pgxpool.Pool, conversationID, userID string) (bool, error) {
	var id string
	err := pool.QueryRow(ctx, `SELECT id FROM conversations WHERE id=$1 AND user_id=$2`, conversationID, userID).Scan(&id)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}
