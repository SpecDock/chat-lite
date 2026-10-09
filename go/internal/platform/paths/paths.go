package paths

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

func DataDir() string {
	if v := os.Getenv("DATA_DIR"); v != "" {
		return v
	}
	return filepath.Join(".", "data")
}

func UploadDir() string {
	if v := os.Getenv("UPLOAD_DIR"); v != "" {
		return v
	}
	return filepath.Join(DataDir(), "uploads")
}

func WorkspaceRoot() string {
	return filepath.Join(DataDir(), "work")
}

func IsSafeWorkspaceID(value string) bool {
	return safeID.MatchString(value)
}

func ConversationWorkspaceDir(conversationID string) string {
	return filepath.Join(WorkspaceRoot(), conversationID)
}

func ConversationInputDir(conversationID string) string {
	return filepath.Join(ConversationWorkspaceDir(conversationID), "input")
}

func ConversationOutputDir(conversationID string) string {
	return filepath.Join(ConversationWorkspaceDir(conversationID), "output")
}

func EnsureConversationWorkspace(conversationID string) error {
	if !IsSafeWorkspaceID(conversationID) {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(ConversationInputDir(conversationID), 0o755); err != nil {
		return err
	}
	return os.MkdirAll(ConversationOutputDir(conversationID), 0o755)
}

func IsWithinDirectory(root, target string) bool {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}

func IsWorkspaceAttachment(filePath, conversationID, bucket string) bool {
	if !IsSafeWorkspaceID(conversationID) {
		return false
	}
	dir := ConversationInputDir(conversationID)
	if bucket == "output" {
		dir = ConversationOutputDir(conversationID)
	}
	return IsWithinDirectory(dir, filePath)
}
