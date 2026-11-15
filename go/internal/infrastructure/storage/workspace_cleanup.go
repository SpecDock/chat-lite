package storage

import (
	"context"
	"fmt"
	"strings"

	"github.com/minio/minio-go/v7"
)

// DeleteWorkspace removes only the two exact conversation cache prefixes; do
// not use ObjectPath here, since it deliberately reduces names to a basename.
func DeleteWorkspace(ctx context.Context, userID, conversationID string) error {
	for _, id := range []string{userID, conversationID} {
		if id == "" || strings.ContainsAny(id, "/\\") || id == "." || id == ".." {
			return fmt.Errorf("invalid workspace owner")
		}
	}
	for _, bucketName := range []string{"ws-input", "ws-output"} {
		prefix := "u/" + userID + "/c/" + conversationID + "/" + bucketName + "/"
		client, bucket, _, err := open(Prefix + prefix)
		if err != nil {
			return err
		}
		for object := range client.ListObjects(ctx, bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
			if object.Err != nil {
				return object.Err
			}
			if err = client.RemoveObject(ctx, bucket, object.Key, minio.RemoveObjectOptions{}); err != nil {
				return err
			}
		}
	}
	return ctx.Err()
}
