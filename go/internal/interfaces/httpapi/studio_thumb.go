package httpapi

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/jpeg"
	_ "image/png"
	"log"
	"net/http"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"

	"chatlite/internal/application/storagequota"
	"chatlite/internal/infrastructure/storage"
	"chatlite/internal/platform/httpx"
)

const thumbMaxEdge = 480

func jpegThumb(src []byte) ([]byte, error) {
	img, err := decodeStudioImage(src)
	if err != nil {
		return nil, err
	}
	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width < 1 || height < 1 {
		return nil, errors.New("图片尺寸无效")
	}
	targetW, targetH := width, height
	if width > thumbMaxEdge || height > thumbMaxEdge {
		if width >= height {
			targetW = thumbMaxEdge
			targetH = height * thumbMaxEdge / width
		} else {
			targetH = thumbMaxEdge
			targetW = width * thumbMaxEdge / height
		}
	}
	if targetW < 1 {
		targetW = 1
	}
	if targetH < 1 {
		targetH = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, targetW, targetH))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), img, bounds, draw.Src, nil)
	var out bytes.Buffer
	if err = jpeg.Encode(&out, dst, &jpeg.Options{Quality: 75}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (a *App) BackfillStudioFiles(ctx context.Context) (int, int) {
	images := a.backfillTable(ctx, false)
	refs := a.backfillTable(ctx, true)
	return images, refs
}

func (a *App) backfillTable(ctx context.Context, reference bool) int {
	query := `SELECT id, user_id, file_path, file_size, thumbnail_path FROM studio_images WHERE file_path IS NOT NULL AND (file_size IS NULL OR thumbnail_path IS NULL OR thumbnail_path='')`
	if reference {
		query = `SELECT id, user_id, file_path, file_size, thumbnail_path, studio_image_id FROM studio_image_references WHERE file_path<>'' AND (file_size IS NULL OR thumbnail_path IS NULL OR thumbnail_path='')`
	}
	rows, err := a.Pool.Query(ctx, query)
	if err != nil {
		log.Printf("[studio-backfill] query failed reference=%t err=%v", reference, err)
		return 0
	}
	type item struct {
		id, userID, path, studioID string
		size                       *int64
		thumb                      *string
	}
	var items []item
	for rows.Next() {
		var it item
		var scanErr error
		if reference {
			scanErr = rows.Scan(&it.id, &it.userID, &it.path, &it.size, &it.thumb, &it.studioID)
		} else {
			scanErr = rows.Scan(&it.id, &it.userID, &it.path, &it.size, &it.thumb)
		}
		if scanErr == nil {
			items = append(items, it)
		}
	}
	rows.Close()
	done := 0
	for _, it := range items {
		needSize := it.size == nil
		needThumb := it.thumb == nil || *it.thumb == ""
		var body []byte
		if needThumb || needSize {
			body, err = storage.Read(ctx, it.path)
			if err != nil {
				log.Printf("[studio-backfill] read failed id=%s err=%v", it.id, err)
				continue
			}
		}
		fileSize := int64(0)
		if it.size != nil {
			fileSize = *it.size
		}
		if needSize {
			fileSize = int64(len(body))
		}
		thumbPath := ""
		thumbSize := int64(0)
		if it.thumb != nil {
			thumbPath = *it.thumb
		}
		if needThumb {
			name := it.id + "_thumb.jpg"
			if reference {
				name = it.studioID + "_" + it.id + "_thumb.jpg"
			}
			thumbPath, thumbSize = a.saveThumb(ctx, it.userID, name, body)
			if thumbPath == "" {
				log.Printf("[studio-backfill] thumb failed id=%s", it.id)
			}
		}
		if needThumb && thumbPath != "" {
			update := `UPDATE studio_images SET file_size=$1, thumbnail_path=$2, thumbnail_size=$3 WHERE id=$4 AND user_id=$5`
			if reference {
				update = `UPDATE studio_image_references SET file_size=$1, thumbnail_path=$2, thumbnail_size=$3 WHERE id=$4 AND user_id=$5`
			}
			_, err = a.Pool.Exec(ctx, update, fileSize, thumbPath, thumbSize, it.id, it.userID)
		} else if needSize {
			update := `UPDATE studio_images SET file_size=$1 WHERE id=$2 AND user_id=$3`
			if reference {
				update = `UPDATE studio_image_references SET file_size=$1 WHERE id=$2 AND user_id=$3`
			}
			_, err = a.Pool.Exec(ctx, update, fileSize, it.id, it.userID)
		}
		if err != nil {
			log.Printf("[studio-backfill] update failed id=%s err=%v", it.id, err)
			continue
		}
		done++
		log.Printf("[studio-backfill] updated id=%s bytes=%d thumb=%d reference=%t", it.id, fileSize, thumbSize, reference)
	}
	return done
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (a *App) saveThumb(ctx context.Context, userID, name string, original []byte) (string, int64) {
	thumb, err := jpegThumb(original)
	if err != nil {
		log.Printf("[studio] thumb skipped name=%s err=%s", name, trimErr(err))
		return "", 0
	}
	if err = storagequota.Ensure(ctx, a.Pool, userID, int64(len(thumb))); err != nil {
		log.Printf("[studio] thumb skipped name=%s err=%s", name, trimErr(err))
		return "", 0
	}
	path := storage.ObjectPath(userID, "", "studio", name)
	if err = storage.Put(ctx, path, thumb, "image/jpeg"); err != nil {
		log.Printf("[studio] thumb skipped name=%s err=%s", name, trimErr(err))
		return "", 0
	}
	return path, int64(len(thumb))
}

func (a *App) studioThumb(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	id := r.PathValue("id")
	var path, mimeType, thumb *string
	var status string
	err := a.Pool.QueryRow(r.Context(), `SELECT file_path, mime_type, thumbnail_path, status FROM studio_images WHERE id=$1 AND user_id=$2`, id, user.UserID).Scan(&path, &mimeType, &thumb, &status)
	if err != nil || status != "succeeded" || path == nil {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	if thumb != nil && *thumb != "" {
		streamStored(w, r, *thumb, "image/jpeg", "inline")
		return
	}
	body, err := storage.Read(r.Context(), *path)
	if err != nil {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	saved, size := a.saveThumb(r.Context(), user.UserID, id+"_thumb.jpg", body)
	if saved == "" {
		mt := "application/octet-stream"
		if mimeType != nil {
			mt = *mimeType
		}
		streamStored(w, r, *path, mt, "inline")
		return
	}
	_, _ = a.Pool.Exec(r.Context(), `UPDATE studio_images SET thumbnail_path=$1, thumbnail_size=$2 WHERE id=$3 AND user_id=$4`, saved, size, id, user.UserID)
	streamStored(w, r, saved, "image/jpeg", "inline")
}

func (a *App) studioReferenceThumb(w http.ResponseWriter, r *http.Request) {
	user := authFrom(r)
	imageID := r.PathValue("id")
	refID := r.PathValue("refId")
	var path, mimeType string
	var thumb *string
	err := a.Pool.QueryRow(r.Context(), `SELECT file_path, mime_type, thumbnail_path FROM studio_image_references WHERE studio_image_id=$1 AND id=$2 AND user_id=$3`, imageID, refID, user.UserID).Scan(&path, &mimeType, &thumb)
	if err != nil {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	if thumb != nil && *thumb != "" {
		streamStored(w, r, *thumb, "image/jpeg", "inline")
		return
	}
	body, err := storage.Read(r.Context(), path)
	if err != nil {
		httpx.Error(w, 404, "文件不存在")
		return
	}
	saved, size := a.saveThumb(r.Context(), user.UserID, imageID+"_"+refID+"_thumb.jpg", body)
	if saved == "" {
		streamStored(w, r, path, mimeType, "inline")
		return
	}
	_, _ = a.Pool.Exec(r.Context(), `UPDATE studio_image_references SET thumbnail_path=$1, thumbnail_size=$2 WHERE id=$3 AND user_id=$4`, saved, size, refID, user.UserID)
	streamStored(w, r, saved, "image/jpeg", "inline")
}

func decodeStudioImage(src []byte) (image.Image, error) {
	if len(src) > 12 && string(src[0:4]) == "RIFF" && string(src[8:12]) == "WEBP" {
		return webp.Decode(bytes.NewReader(src))
	}
	img, _, err := image.Decode(bytes.NewReader(src))
	return img, err
}
