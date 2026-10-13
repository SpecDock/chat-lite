package storage

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"chatlite/config"
)

const Prefix = "minio://"

func IsObjectPath(value string) bool {
	return strings.HasPrefix(value, Prefix)
}

func ObjectPath(userID, conversationID, bucket, fileName string) string {
	name := fileName
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	if name == "" {
		name = "file"
	}
	if bucket == "studio" {
		return Prefix + "u/" + userID + "/studio/" + name
	}
	if conversationID == "" {
		return Prefix + "u/" + userID + "/uploads/" + name
	}
	return Prefix + "u/" + userID + "/c/" + conversationID + "/" + bucket + "/" + name
}

func IsConversationObject(stored, conversationID, bucket string) bool {
	return strings.HasPrefix(stored, Prefix+"u/") && strings.Contains(stored, "/c/"+conversationID+"/"+bucket+"/")
}

func IsUserStudioObject(stored, userID string) bool {
	return strings.HasPrefix(stored, Prefix+"u/"+userID+"/studio/")
}

func Put(ctx context.Context, stored string, body []byte, contentType string) error {
	client, bucket, key, err := open(stored)
	if err != nil {
		return err
	}
	_, err = client.PutObject(ctx, bucket, key, bytes.NewReader(body), int64(len(body)), minio.PutObjectOptions{ContentType: contentType})
	return err
}

func Read(ctx context.Context, stored string) ([]byte, error) {
	body, _, err := Open(ctx, stored)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	return io.ReadAll(body)
}

func Open(ctx context.Context, stored string) (io.ReadCloser, int64, error) {
	if !IsObjectPath(stored) {
		file, err := os.Open(stored)
		if err != nil {
			return nil, 0, err
		}
		info, err := file.Stat()
		if err != nil {
			file.Close()
			return nil, 0, err
		}
		return file, info.Size(), nil
	}
	client, bucket, key, err := open(stored)
	if err != nil {
		return nil, 0, err
	}
	info, err := client.StatObject(ctx, bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return nil, 0, err
	}
	obj, err := client.GetObject(ctx, bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, 0, err
	}
	return obj, info.Size, nil
}

func Remove(ctx context.Context, stored string) error {
	if stored == "" {
		return nil
	}
	if !IsObjectPath(stored) {
		err := os.Remove(stored)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	client, bucket, key, err := open(stored)
	if err != nil {
		return err
	}
	return client.RemoveObject(ctx, bucket, key, minio.RemoveObjectOptions{})
}

func Materialize(ctx context.Context, stored, destination string) error {
	body, err := Read(ctx, stored)
	if err != nil {
		return err
	}
	return os.WriteFile(destination, body, 0o644)
}

func open(stored string) (*minio.Client, string, string, error) {
	cfg := config.Current().MinIO
	endpoint := strings.TrimSpace(cfg.Endpoint)
	endpoint = strings.TrimPrefix(endpoint, "https://")
	endpoint = strings.TrimPrefix(endpoint, "http://")
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: strings.EqualFold(cfg.UseSSL, "true"),
	})
	if err != nil {
		return nil, "", "", err
	}
	bucket := cfg.Bucket
	if bucket == "" {
		bucket = "chat-lite"
	}
	exists, err := client.BucketExists(context.Background(), bucket)
	if err == nil && !exists {
		err = client.MakeBucket(context.Background(), bucket, minio.MakeBucketOptions{})
	}
	if err != nil {
		return nil, "", "", err
	}
	return client, bucket, strings.TrimPrefix(stored, Prefix), nil
}
