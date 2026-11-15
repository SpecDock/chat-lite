package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	sessionIdle   = 30 * time.Minute
	sessionRoot   = "/run/table-sandbox/sessions"
	sessionNet    = "chatlite-sandbox"
	readByteLimit = 1<<20 + 1
)

type liveSession struct {
	container string
	expires   time.Time
}

type sessionTable struct {
	mu    sync.Mutex
	items map[string]*liveSession
}

var sessions = sessionTable{items: map[string]*liveSession{}}

type sessionView struct {
	Alive     bool   `json:"alive"`
	ExpiresAt string `json:"expiresAt,omitempty"`
	Created   bool   `json:"created,omitempty"`
}

type sessionContainerState struct {
	Running   bool   `json:"Running"`
	ExitCode  int    `json:"ExitCode"`
	OOMKilled bool   `json:"OOMKilled"`
	Error     string `json:"Error"`
}

func (b *broker) serveSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, errJSON{Error: "method not allowed"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	defer r.Body.Close()
	var payload struct {
		ID      string `json:"id"`
		Refresh bool   `json:"refresh"`
		Path    string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, errJSON{Error: "invalid request"})
		return
	}
	id := strings.TrimSpace(payload.ID)
	if !jobIDPattern.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, errJSON{Error: "invalid session"})
		return
	}
	switch r.URL.Path {
	case "/session/status":
		view, err := sessions.status(r.Context(), b.eng, id)
		if err != nil {
			writeSessionErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, view)
	case "/session/ensure":
		view, err := sessions.ensure(r.Context(), b.eng, id, payload.Refresh)
		if err != nil {
			writeSessionErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, view)
	case "/session/touch":
		view, err := sessions.touch(id)
		if err != nil {
			writeSessionErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, view)
	case "/session/exec":
		result, err := sessions.exec(r.Context(), b.eng, id, payload.Path)
		if err != nil {
			writeSessionErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case "/session/read":
		body, err := sessions.read(r.Context(), b.eng, id, payload.Path)
		if err != nil {
			writeSessionErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	default:
		writeJSON(w, http.StatusNotFound, errJSON{Error: "not found"})
	}
}

func writeSessionErr(w http.ResponseWriter, err error) {
	if errors.Is(err, errBusy) {
		writeJSON(w, http.StatusServiceUnavailable, errJSON{Error: "sandbox busy"})
		return
	}
	if errors.Is(err, errGone) {
		writeJSON(w, http.StatusConflict, errJSON{Error: "sandbox gone"})
		return
	}
	log.Printf("sandbox session: %v", err)
	writeJSON(w, http.StatusInternalServerError, errJSON{Error: safeErr(err)})
}

var errGone = errors.New("sandbox gone")

func (t *sessionTable) status(ctx context.Context, eng *engine, id string) (sessionView, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	item := t.items[id]
	if item == nil || !item.expires.After(time.Now()) {
		return sessionView{Alive: false}, nil
	}
	state, err := eng.inspectSession(ctx, item.container)
	if err != nil {
		return sessionView{}, err
	}
	if state == nil || !state.Running {
		delete(t.items, id)
		if err := eng.forceRemove(ctx, item.container); err != nil {
			return sessionView{}, err
		}
		return sessionView{Alive: false}, nil
	}
	return sessionView{Alive: true, ExpiresAt: item.expires.Format(time.RFC3339)}, nil
}

func (t *sessionTable) ensure(ctx context.Context, eng *engine, id string, refresh bool) (sessionView, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	if item := t.items[id]; item != nil && item.expires.After(now) {
		state, err := eng.inspectSession(ctx, item.container)
		if err != nil {
			return sessionView{}, err
		}
		if state != nil && state.Running {
			if refresh {
				item.expires = now.Add(sessionIdle)
			}
			return sessionView{Alive: true, ExpiresAt: item.expires.Format(time.RFC3339)}, nil
		}
		// A failed container must not discard scripts written for this session.
		delete(t.items, id)
		if err := eng.forceRemove(ctx, item.container); err != nil {
			return sessionView{}, err
		}
	}
	if old := t.items[id]; old != nil {
		_ = eng.forceRemove(ctx, old.container)
		stripSessionScripts(id)
		delete(t.items, id)
	}
	if t.aliveCount(now) >= runningCap {
		return sessionView{}, errBusy
	}
	if err := prepareSessionDir(id); err != nil {
		return sessionView{}, err
	}
	name := "chatlite-sess-" + id
	if len(name) > 120 {
		name = name[:120]
	}
	created, err := eng.createSession(ctx, name, id)
	if err != nil {
		return sessionView{}, err
	}
	if err = eng.start(ctx, created); err != nil {
		_ = eng.forceRemove(ctx, created)
		return sessionView{}, err
	}
	state, err := eng.inspectSession(ctx, created)
	if err != nil {
		_ = eng.forceRemove(ctx, created)
		return sessionView{}, err
	}
	if state == nil || !state.Running {
		_ = eng.forceRemove(ctx, created)
		if state == nil {
			return sessionView{}, errors.New("sandbox container missing after start")
		}
		return sessionView{}, fmt.Errorf("sandbox exited after start: exit_code=%d OOMKilled=%t error=%q", state.ExitCode, state.OOMKilled, state.Error)
	}
	item := &liveSession{container: created, expires: now.Add(sessionIdle)}
	t.items[id] = item
	return sessionView{Alive: true, Created: true, ExpiresAt: item.expires.Format(time.RFC3339)}, nil
}

func (t *sessionTable) touch(id string) (sessionView, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	item := t.items[id]
	if item == nil || !item.expires.After(time.Now()) {
		return sessionView{}, errGone
	}
	item.expires = time.Now().Add(sessionIdle)
	return sessionView{Alive: true, ExpiresAt: item.expires.Format(time.RFC3339)}, nil
}

func (t *sessionTable) exec(ctx context.Context, eng *engine, id, rel string) (runResult, error) {
	if _, err := t.ensure(ctx, eng, id, true); err != nil {
		return runResult{}, err
	}
	t.mu.Lock()
	item := t.items[id]
	container := ""
	if item != nil {
		container = item.container
	}
	t.mu.Unlock()
	if container == "" {
		return runResult{}, errGone
	}
	rel = strings.TrimPrefix(strings.ReplaceAll(rel, "\\", "/"), "/")
	if rel == "" || strings.Contains(rel, "..") || !strings.HasSuffix(strings.ToLower(rel), ".py") || strings.HasPrefix(rel, "input/") {
		return runResult{}, errInvalid
	}
	return eng.execPython(ctx, container, "/work/"+rel)
}

func (t *sessionTable) read(ctx context.Context, eng *engine, id, path string) ([]byte, error) {
	t.mu.Lock()
	item := t.items[id]
	alive := item != nil && item.expires.After(time.Now())
	container := ""
	if alive {
		container = item.container
	}
	t.mu.Unlock()
	if !alive {
		return nil, errGone
	}
	if !validContainerPath(path) {
		return nil, errInvalid
	}
	return eng.readFile(ctx, container, path)
}

func (t *sessionTable) aliveCount(now time.Time) int {
	n := 0
	for _, item := range t.items {
		if item.expires.After(now) {
			n++
		}
	}
	return n
}

func (t *sessionTable) reap(eng *engine, id string, item *liveSession) {
	ctx, cancel := context.WithTimeout(context.Background(), reapTimeout)
	defer cancel()
	if item != nil && item.container != "" {
		_ = eng.forceRemove(ctx, item.container)
	}
	stripSessionScripts(id)
	t.mu.Lock()
	if current := t.items[id]; current == item {
		delete(t.items, id)
	}
	t.mu.Unlock()
}

func sweepSessions(eng *engine) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for now := range ticker.C {
		var expired []struct {
			id   string
			item *liveSession
		}
		sessions.mu.Lock()
		for id, item := range sessions.items {
			if !item.expires.After(now) {
				expired = append(expired, struct {
					id   string
					item *liveSession
				}{id, item})
			}
		}
		sessions.mu.Unlock()
		for _, item := range expired {
			sessions.reap(eng, item.id, item.item)
		}
	}
}

func prepareSessionDir(id string) error {
	root := filepath.Join(sessionRoot, id)
	if err := os.MkdirAll(filepath.Join(root, "input"), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(root, "output"), 0o777); err != nil {
		return err
	}
	_ = os.Chmod(root, 0o1777)
	_ = os.Chmod(filepath.Join(root, "output"), 0o777)
	return nil
}

func stripSessionScripts(id string) {
	if !jobIDPattern.MatchString(id) {
		return
	}
	root := filepath.Join(sessionRoot, id)
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "input" || name == "output" {
			continue
		}
		_ = os.RemoveAll(filepath.Join(root, name))
	}
}

func stripAllSessionScripts() {
	entries, err := os.ReadDir(sessionRoot)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			stripSessionScripts(entry.Name())
		}
	}
}

func validContainerPath(path string) bool {
	if path == "" || !strings.HasPrefix(path, "/") || strings.Contains(path, "..") || strings.ContainsAny(path, "\r\n") {
		return false
	}
	return true
}

func (e *engine) ensureNetwork(ctx context.Context) error {
	var created struct {
		ID string `json:"Id"`
	}
	body := map[string]any{
		"Name":   sessionNet,
		"Driver": "bridge",
		"Options": map[string]string{
			"com.docker.network.bridge.enable_icc": "false",
		},
	}
	err := e.do(ctx, http.MethodPost, apiPrefix+"/networks/create", body, &created)
	var dock *dockerError
	if errors.As(err, &dock) && (dock.status == http.StatusConflict || strings.Contains(strings.ToLower(dock.message), "already exists")) {
		return nil
	}
	return err
}

func (e *engine) inspectSession(ctx context.Context, container string) (*sessionContainerState, error) {
	var inspected struct {
		State *sessionContainerState `json:"State"`
	}
	err := e.do(ctx, http.MethodGet, containerURL(container, "/json"), nil, &inspected)
	var dock *dockerError
	if errors.As(err, &dock) && dock.status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if inspected.State == nil {
		return nil, errors.New("docker inspect returned no container state")
	}
	return inspected.State, nil
}

func (e *engine) createSession(ctx context.Context, name, sessionID string) (string, error) {
	if !jobIDPattern.MatchString(sessionID) || !refPattern.MatchString(name) {
		return "", errInvalid
	}
	spec := sandboxSpec(sessionID)
	spec.User = "0:0"
	spec.Cmd = []string{"/usr/local/bin/chatlite-sandbox-init"}
	spec.HostConfig.NetworkMode = sessionNet
	spec.HostConfig.CapAdd = []string{"NET_ADMIN", "SETGID", "SETUID"}
	spec.HostConfig.CapDrop = []string{"ALL"}
	spec.HostConfig.Tmpfs = map[string]string{"/tmp": "rw,nosuid,size=268435456", "/run": "rw,nosuid,size=16777216"}
	spec.HostConfig.Binds = []string{hostJobsRoot + "/sessions/" + sessionID + ":/work"}
	spec.Labels["chatlite.session"] = sessionID
	var created struct {
		ID string `json:"Id"`
	}
	_ = e.forceRemove(ctx, name)
	path := apiPrefix + "/containers/create?name=" + url.QueryEscape(name)
	if err := e.do(ctx, http.MethodPost, path, spec, &created); err != nil {
		return "", err
	}
	if created.ID == "" {
		return "", errors.New("docker create returned no id")
	}
	return created.ID, nil
}

func (e *engine) execPython(ctx context.Context, container, path string) (runResult, error) {
	started := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	stdout, stderr, code, err := e.exec(runCtx, container, []string{"python", "-I", "-B", path})
	if err != nil {
		if runCtx.Err() != nil && ctx.Err() == nil {
			return timeoutResult(stdout, stderr, started), nil
		}
		return runResult{}, err
	}
	return finishResult(code, stdout, stderr, started), nil
}

func (e *engine) readFile(ctx context.Context, container, path string) ([]byte, error) {
	script := "import pathlib,sys\np=pathlib.Path(sys.argv[1])\nif not p.is_file():\n raise SystemExit(2)\nsys.stdout.buffer.write(p.read_bytes()[:1048577])"
	stdout, stderr, code, err := e.exec(ctx, container, []string{"python", "-c", script, path})
	if err != nil {
		return nil, err
	}
	if code == 2 {
		return nil, errors.New("文件不存在")
	}
	if code != 0 {
		detail := strings.TrimSpace(stderr)
		if detail == "" {
			detail = "读取失败"
		}
		return nil, errors.New(detail)
	}
	return []byte(stdout), nil
}

func (e *engine) exec(ctx context.Context, container string, cmd []string) (string, string, int, error) {
	var created struct {
		ID string `json:"Id"`
	}
	body := map[string]any{
		"AttachStdout": true,
		"AttachStderr": true,
		"Tty":          false,
		"User":         "1000:1000",
		"WorkingDir":   "/work",
		"Cmd":          cmd,
	}
	if err := e.do(ctx, http.MethodPost, containerURL(container, "/exec"), body, &created); err != nil {
		return "", "", 0, err
	}
	if created.ID == "" {
		return "", "", 0, errors.New("docker exec returned no id")
	}
	res, err := e.open(ctx, http.MethodPost, apiPrefix+"/exec/"+created.ID+"/start", map[string]any{"Detach": false, "Tty": false})
	if err != nil {
		return "", "", 0, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return "", "", 0, dockerStatusError(res.StatusCode, raw)
	}
	limit := outputCap
	for _, arg := range cmd {
		if arg == "-c" {
			limit = readByteLimit
			break
		}
	}
	stdout, stderr := demuxLogsMax(io.LimitReader(res.Body, int64(limit*2)), limit)
	var inspected struct {
		ExitCode *int `json:"ExitCode"`
	}
	if err := e.do(context.Background(), http.MethodGet, apiPrefix+"/exec/"+created.ID+"/json", nil, &inspected); err != nil {
		return stdout, stderr, 1, err
	}
	code := 1
	if inspected.ExitCode != nil {
		code = *inspected.ExitCode
	}
	return stdout, stderr, code, nil
}
