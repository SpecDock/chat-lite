package main

import (
	"context"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/config"
	"chatlite/internal/infrastructure/contextkafka"
	"chatlite/internal/infrastructure/contextstore"
	"chatlite/internal/infrastructure/postgres"
	"chatlite/internal/interfaces/httpapi"
	"chatlite/internal/platform/httpx"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	var pool *pgxpool.Pool
	if cfg.Postgres.URL != "" {
		opened, err := postgres.Open(ctx, cfg.Postgres.URL)
		if err != nil {
			log.Fatal(err)
		}
		pool = opened
		defer pool.Close()
		if err := postgres.ApplySchema(ctx, pool, cfg.Server.SchemaPath); err != nil {
			log.Fatal(err)
		}
	}
	if len(cfg.Kafka.BrokerList()) > 0 && strings.TrimSpace(cfg.Redis.Addr) != "" {
		if pool == nil {
			log.Fatal("kafka 已配置但 postgres 未配置")
		}
		store, err := contextstore.Open(cfg.Redis.Addr, cfg.Redis.Password, cfg.Redis.DB)
		if err != nil {
			log.Fatal(err)
		}
		runtime, err := contextkafka.Start(cfg.Kafka.BrokerList(), cfg.Kafka.TopicName(), store, pool)
		if err != nil {
			log.Fatal(err)
		}
		defer func() {
			if err := runtime.Close(); err != nil {
				log.Printf("[context-kafka] close_failed err=%v", err)
			}
		}()
	}

	mux := http.NewServeMux()
	httpapi.New(pool).Register(mux)

	server := &http.Server{
		Addr:              ":" + cfg.Server.Port,
		Handler:           httpx.CORS(staticOrAPI(mux, "dist")),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("chat-lite go listening on http://localhost:%s", cfg.Server.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
}

func staticOrAPI(next http.Handler, root string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		serveStatic(w, r, root)
	})
}

func serveStatic(w http.ResponseWriter, r *http.Request, root string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	clean := path.Clean("/" + r.URL.Path)
	fileAbs, err := filepath.Abs(filepath.Join(rootAbs, filepath.FromSlash(strings.TrimPrefix(clean, "/"))))
	if err != nil || (fileAbs != rootAbs && !strings.HasPrefix(fileAbs, rootAbs+string(os.PathSeparator))) {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(fileAbs)
	if err != nil || info.IsDir() {
		fileAbs = filepath.Join(rootAbs, "index.html")
		info, err = os.Stat(fileAbs)
	}
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	contentType := mime.TypeByExtension(filepath.Ext(fileAbs))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	cache := "public, max-age=31536000, immutable"
	if strings.HasSuffix(fileAbs, "index.html") {
		cache = "no-cache"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("Cache-Control", cache)
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	file, err := os.Open(fileAbs)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, file)
}
