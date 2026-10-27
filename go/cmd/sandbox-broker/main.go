package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	socketPath   = "/run/table-sandbox/table-sandbox.sock"
	jobsRoot     = "/run/table-sandbox/jobs"
	hostJobsRoot = "/var/lib/chat-lite/table-sandbox"
	workerImage  = "chat-lite-table-sandbox"
	dockerSock   = "/var/run/docker.sock"
	apiPrefix    = "/v1.41"

	runningCap   = 2
	waitingCap   = 2
	runTimeout   = 30 * time.Second
	reapTimeout  = 3 * time.Second
	outputCap    = 64 * 1024
	heldMarker   = ".sandbox-held"
	maxCodeBytes = 1 * 1024 * 1024
	maxBodyBytes = 2 * 1024 * 1024

	memoryLimit = 536870912
	pidsLimit   = 64
	fsizeLimit  = 20971520
	cpuSoft     = 30
	cpuHard     = 32
	tmpfsOpts   = "rw,noexec,nosuid,size=268435456"
)

var (
	jobIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
	refPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	errBusy      = errors.New("sandbox busy")
	errInvalid   = errors.New("invalid job")
	errJobsRoot  = errors.New("jobs root unavailable")
)

func main() {
	eng := newEngine()
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 45*time.Second)
	err := eng.cleanup(cleanupCtx)
	cleanupCancel()
	if err != nil {
		log.Fatalf("sandbox cleanup: %v", err)
	}
	clearHeldMarkers()

	if err := os.MkdirAll(filepath.Dir(socketPath), 0o755); err != nil {
		log.Fatal(err)
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Fatal(err)
	}
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.Chmod(socketPath, 0o660); err != nil {
		_ = ln.Close()
		log.Fatal(err)
	}

	server := &http.Server{
		Handler:           &broker{gate: &gate{}, eng: eng},
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("sandbox broker listening on %s", socketPath)
	if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

type errJSON struct {
	Error string `json:"error"`
}

type runResult struct {
	Status     string `json:"status"`
	ExitCode   *int   `json:"exit_code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMS int    `json:"duration_ms"`
	TimedOut   bool   `json:"timed_out"`
}

type broker struct {
	gate *gate
	eng  *engine
}

func (b *broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/run" {
		writeJSON(w, http.StatusNotFound, errJSON{Error: "not found"})
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, errJSON{Error: "method not allowed"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	defer r.Body.Close()
	var payload struct {
		JobID string `json:"jobId"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) || strings.Contains(err.Error(), "request body too large") {
			writeJSON(w, http.StatusRequestEntityTooLarge, errJSON{Error: "request too large"})
			return
		}
		writeJSON(w, http.StatusBadRequest, errJSON{Error: "invalid request"})
		return
	}

	jobPath, err := resolveJob(payload.JobID)
	if err != nil {
		if errors.Is(err, errJobsRoot) {
			log.Printf("sandbox jobs root: %v", err)
			writeJSON(w, http.StatusInternalServerError, errJSON{Error: "jobs root unavailable"})
			return
		}
		writeJSON(w, http.StatusBadRequest, errJSON{Error: "invalid job"})
		return
	}
	if strings.TrimSpace(payload.Code) == "" || len(payload.Code) > maxCodeBytes {
		writeJSON(w, http.StatusBadRequest, errJSON{Error: "invalid code"})
		return
	}
	if err := writeScript(jobPath, payload.Code); err != nil {
		log.Printf("sandbox job=%s write script: %v", payload.JobID, err)
		writeJSON(w, http.StatusInternalServerError, errJSON{Error: "write script failed"})
		return
	}

	if err := b.gate.acquire(r.Context()); err != nil {
		if errors.Is(err, errBusy) {
			log.Printf("sandbox busy job=%s", payload.JobID)
			writeJSON(w, http.StatusServiceUnavailable, errJSON{Error: "sandbox busy"})
			return
		}
		return
	}
	defer b.gate.release()
	if err := r.Context().Err(); err != nil {
		return
	}

	result, err := b.eng.run(r.Context(), payload.JobID)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		log.Printf("sandbox job=%s: %v", payload.JobID, err)
		writeJSON(w, http.StatusInternalServerError, errJSON{Error: safeErr(err)})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"encode failed"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", buf.Len()))
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

func safeErr(err error) string {
	msg := strings.Join(strings.Fields(err.Error()), " ")
	if msg == "" {
		return "sandbox failed"
	}
	if len(msg) > 300 {
		return msg[:300]
	}
	return msg
}

func resolveJob(jobID string) (string, error) {
	if !jobIDPattern.MatchString(jobID) {
		return "", errInvalid
	}
	root, err := filepath.EvalSymlinks(jobsRoot)
	if err != nil {
		return "", fmt.Errorf("%w: %s", errJobsRoot, jobsRoot)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(root, jobID))
	if err != nil {
		return "", errInvalid
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel != jobID {
		return "", errInvalid
	}
	info, err := os.Stat(filepath.Join(resolved, "input"))
	if err != nil || !info.IsDir() {
		return "", errInvalid
	}
	return resolved, nil
}

func writeScript(dir, code string) error {
	script := filepath.Join(dir, "script.py")
	info, err := os.Lstat(script)
	if err == nil && info.Mode()&os.ModeSymlink != 0 {
		if err := os.Remove(script); err != nil {
			return err
		}
	}
	if err := os.WriteFile(script, []byte(code), 0o444); err != nil {
		return err
	}
	return os.Chmod(script, 0o444)
}

type gate struct {
	mu      sync.Mutex
	running int
	waiting int
	queue   []chan struct{}
}

func (g *gate) acquire(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	g.mu.Lock()
	if g.running < runningCap {
		g.running++
		g.mu.Unlock()
		return nil
	}
	if g.waiting >= waitingCap {
		g.mu.Unlock()
		return errBusy
	}
	ready := make(chan struct{})
	g.waiting++
	g.queue = append(g.queue, ready)
	g.mu.Unlock()

	select {
	case <-ready:
		return nil
	case <-ctx.Done():
		g.mu.Lock()
		defer g.mu.Unlock()
		for i := range g.queue {
			if g.queue[i] == ready {
				g.queue = append(g.queue[:i], g.queue[i+1:]...)
				g.decWaiting()
				return ctx.Err()
			}
		}
		// The slot was handed off as this wait lost the select.
		g.handoff()
		return ctx.Err()
	}
}

func (g *gate) release() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.handoff()
}

// handoff moves one running slot to the next waiter, or frees it.
// Caller holds g.mu.
func (g *gate) handoff() {
	if len(g.queue) > 0 {
		ready := g.queue[0]
		g.queue = g.queue[1:]
		g.decWaiting()
		close(ready)
		return
	}
	if g.running > 0 {
		g.running--
	}
}

func (g *gate) decWaiting() {
	if g.waiting > 0 {
		g.waiting--
	}
}

type engine struct {
	client *http.Client
	seq    atomic.Uint64
}

func newEngine() *engine {
	return &engine{
		client: &http.Client{
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					var dialer net.Dialer
					return dialer.DialContext(ctx, "unix", dockerSock)
				},
			},
		},
	}
}

type createRequest struct {
	Image      string            `json:"Image"`
	Cmd        []string          `json:"Cmd"`
	WorkingDir string            `json:"WorkingDir"`
	User       string            `json:"User"`
	Env        []string          `json:"Env"`
	Labels     map[string]string `json:"Labels"`
	Tty        bool              `json:"Tty"`
	HostConfig hostConfig        `json:"HostConfig"`
}

type hostConfig struct {
	NetworkMode    string            `json:"NetworkMode"`
	ReadonlyRootfs bool              `json:"ReadonlyRootfs"`
	CapDrop        []string          `json:"CapDrop"`
	SecurityOpt    []string          `json:"SecurityOpt"`
	Memory         int64             `json:"Memory"`
	MemorySwap     int64             `json:"MemorySwap"`
	PidsLimit      int64             `json:"PidsLimit"`
	Ulimits        []ulimit          `json:"Ulimits"`
	Tmpfs          map[string]string `json:"Tmpfs"`
	Binds          []string          `json:"Binds"`
}

type ulimit struct {
	Name string `json:"Name"`
	Soft int64  `json:"Soft"`
	Hard int64  `json:"Hard"`
}

func sandboxSpec(jobID string) createRequest {
	return createRequest{
		Image:      workerImage,
		Cmd:        []string{"python", "-I", "-B", "/work/script.py"},
		WorkingDir: "/work",
		User:       "1000:1000",
		Env: []string{
			"PYTHONUNBUFFERED=1",
			"PYTHONDONTWRITEBYTECODE=1",
			"HOME=/tmp",
			"PATH=/usr/local/bin:/usr/bin:/bin",
		},
		Labels: map[string]string{"chatlite.sandbox": "1"},
		Tty:    false,
		HostConfig: hostConfig{
			NetworkMode:    "none",
			ReadonlyRootfs: true,
			CapDrop:        []string{"ALL"},
			SecurityOpt:    []string{"no-new-privileges:true"},
			Memory:         memoryLimit,
			MemorySwap:     memoryLimit,
			PidsLimit:      pidsLimit,
			Ulimits: []ulimit{
				{Name: "fsize", Soft: fsizeLimit, Hard: fsizeLimit},
				{Name: "cpu", Soft: cpuSoft, Hard: cpuHard},
			},
			Tmpfs: map[string]string{"/tmp": tmpfsOpts},
			Binds: []string{hostJobsRoot + "/jobs/" + jobID + ":/work"},
		},
	}
}

func heldPath(jobID string) string {
	return filepath.Join(jobsRoot, jobID, heldMarker)
}

func holdJob(jobID string) error {
	if !jobIDPattern.MatchString(jobID) {
		return errInvalid
	}
	file, err := os.OpenFile(heldPath(jobID), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	return file.Close()
}

func releaseJob(jobID string) error {
	err := os.Remove(heldPath(jobID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func clearHeldMarkers() {
	entries, err := os.ReadDir(jobsRoot)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || !jobIDPattern.MatchString(entry.Name()) {
			continue
		}
		if err := os.Remove(heldPath(entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("remove held marker %s: %v", entry.Name(), err)
		}
	}
}

func (e *engine) run(ctx context.Context, jobID string) (runResult, error) {
	started := time.Now()
	if err := holdJob(jobID); err != nil {
		return runResult{}, err
	}
	name := fmt.Sprintf("chatlite-sandbox-%d", e.seq.Add(1))
	created, err := e.create(ctx, name, jobID)
	if err != nil || !refPattern.MatchString(created) {
		if _, _, removeErr := e.reap(name, false); removeErr != nil {
			return runResult{}, removeErr
		}
		if releaseErr := releaseJob(jobID); releaseErr != nil {
			return runResult{}, releaseErr
		}
		if err == nil {
			err = errors.New("docker create returned an invalid id")
		}
		return runResult{}, err
	}
	if err = e.start(ctx, created); err != nil {
		if _, _, removeErr := e.reap(created, true); removeErr != nil {
			return runResult{}, removeErr
		}
		if releaseErr := releaseJob(jobID); releaseErr != nil {
			return runResult{}, releaseErr
		}
		return runResult{}, err
	}

	waitCtx, waitCancel := context.WithTimeout(ctx, runTimeout)
	status, waitErr := e.wait(waitCtx, created)
	waitCancel()
	stdout, stderr, reapErr := e.reap(created, waitErr != nil)
	if reapErr != nil {
		return runResult{}, reapErr
	}
	if releaseErr := releaseJob(jobID); releaseErr != nil {
		return runResult{}, releaseErr
	}
	if waitErr != nil {
		if ctx.Err() != nil {
			return runResult{}, ctx.Err()
		}
		if waitCtx.Err() != nil {
			return timeoutResult(stdout, stderr, started), nil
		}
		return runResult{}, waitErr
	}
	return finishResult(status, stdout, stderr, started), nil
}

func timeoutResult(stdout, stderr string, started time.Time) runResult {
	return runResult{
		Status:     "timeout",
		Stdout:     stdout,
		Stderr:     stderr,
		DurationMS: int(time.Since(started).Milliseconds()),
		TimedOut:   true,
	}
}

func finishResult(status int, stdout, stderr string, started time.Time) runResult {
	state := "failed"
	if status == 0 {
		state = "succeeded"
	}
	code := status
	return runResult{
		Status:     state,
		ExitCode:   &code,
		Stdout:     stdout,
		Stderr:     stderr,
		DurationMS: int(time.Since(started).Milliseconds()),
		TimedOut:   false,
	}
}

func (e *engine) cleanup(ctx context.Context) error {
	listed, err := e.list(ctx)
	if err != nil {
		return err
	}
	var first error
	removed := 0
	for _, item := range listed {
		if item.Labels["chatlite.sandbox"] != "1" {
			continue
		}
		if err := e.forceRemove(ctx, item.ID); err != nil {
			log.Printf("remove leftover sandbox %s: %v", item.ID, err)
			if first == nil {
				first = err
			}
			continue
		}
		removed++
	}
	if removed > 0 {
		log.Printf("removed %d leftover sandbox containers", removed)
	}
	return first
}

func (e *engine) list(ctx context.Context) ([]listedContainer, error) {
	query := url.Values{}
	query.Set("all", "true")
	query.Set("filters", `{"label":["chatlite.sandbox=1"]}`)
	var listed []listedContainer
	if err := e.do(ctx, http.MethodGet, apiPrefix+"/containers/json?"+query.Encode(), nil, &listed); err != nil {
		return nil, err
	}
	return listed, nil
}

type listedContainer struct {
	ID     string            `json:"Id"`
	Labels map[string]string `json:"Labels"`
}

func (e *engine) create(ctx context.Context, name, jobID string) (string, error) {
	if !jobIDPattern.MatchString(jobID) || !refPattern.MatchString(name) {
		return "", errInvalid
	}
	var created struct {
		ID string `json:"Id"`
	}
	path := apiPrefix + "/containers/create?name=" + url.QueryEscape(name)
	if err := e.do(ctx, http.MethodPost, path, sandboxSpec(jobID), &created); err != nil {
		return "", err
	}
	if created.ID == "" {
		return "", errors.New("docker create returned no id")
	}
	return created.ID, nil
}

func (e *engine) start(ctx context.Context, id string) error {
	return e.do(ctx, http.MethodPost, containerURL(id, "/start"), nil, nil)
}

func (e *engine) wait(ctx context.Context, id string) (int, error) {
	var body struct {
		StatusCode int `json:"StatusCode"`
		Error      *struct {
			Message string `json:"Message"`
		} `json:"Error"`
	}
	if err := e.do(ctx, http.MethodPost, containerURL(id, "/wait"), nil, &body); err != nil {
		return 0, err
	}
	if body.Error != nil && strings.TrimSpace(body.Error.Message) != "" {
		return 0, errors.New(strings.TrimSpace(body.Error.Message))
	}
	return body.StatusCode, nil
}

func (e *engine) kill(ctx context.Context, id string) error {
	err := e.do(ctx, http.MethodPost, containerURL(id, "/kill?signal=SIGKILL"), nil, nil)
	var dock *dockerError
	if errors.As(err, &dock) && (dock.status == http.StatusNotFound || dock.status == http.StatusConflict) {
		return nil
	}
	return err
}

func (e *engine) reap(id string, kill bool) (string, string, error) {
	if !refPattern.MatchString(id) {
		return "", "", errors.New("refused to remove unexpected container id")
	}
	reapCtx, cancel := context.WithTimeout(context.Background(), reapTimeout)
	defer cancel()
	if kill {
		if err := e.kill(reapCtx, id); err != nil {
			log.Printf("kill sandbox %s: %v", id, err)
		}
		if _, err := e.wait(reapCtx, id); err != nil {
			log.Printf("wait sandbox %s: %v", id, err)
		}
	}
	stdout, stderr, err := e.logs(reapCtx, id)
	if err != nil {
		log.Printf("sandbox logs %s: %v", id, err)
	}
	if err := e.forceRemove(reapCtx, id); err != nil {
		return "", "", err
	}
	return stdout, stderr, nil
}

func (e *engine) logs(ctx context.Context, id string) (string, string, error) {
	res, err := e.open(ctx, http.MethodGet, containerURL(id, "/logs?stdout=1&stderr=1"), nil)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return "", "", dockerStatusError(res.StatusCode, raw)
	}
	stdout, stderr := demuxLogs(res.Body)
	return stdout, stderr, nil
}

func (e *engine) forceRemove(ctx context.Context, id string) error {
	if id == "" {
		return nil
	}
	if !refPattern.MatchString(id) {
		return errors.New("refused to remove unexpected container id")
	}
	err := e.do(ctx, http.MethodDelete, containerURL(id, "?force=true"), nil, nil)
	var dock *dockerError
	if errors.As(err, &dock) && dock.status == http.StatusNotFound {
		return nil
	}
	return err
}

func containerURL(id, suffix string) string {
	return apiPrefix + "/containers/" + url.PathEscape(id) + suffix
}

type dockerError struct {
	status  int
	message string
}

func (e *dockerError) Error() string {
	if e.message != "" {
		return e.message
	}
	return fmt.Sprintf("HTTP %d", e.status)
}

func dockerStatusError(code int, raw []byte) error {
	var body struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &body)
	msg := strings.Join(strings.Fields(body.Message), " ")
	if msg == "" {
		msg = strings.Join(strings.Fields(string(raw)), " ")
	}
	if len(msg) > 400 {
		msg = msg[:400]
	}
	return &dockerError{status: code, message: msg}
}

func (e *engine) open(ctx context.Context, method, path string, in any) (*http.Response, error) {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://localhost"+path, body)
	if err != nil {
		return nil, err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return e.client.Do(req)
}

func (e *engine) do(ctx context.Context, method, path string, in, out any) error {
	res, err := e.open(ctx, method, path, in)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return dockerStatusError(res.StatusCode, raw)
	}
	if out == nil {
		return nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return errors.New("empty docker response")
	}
	return json.Unmarshal(trimmed, out)
}

func demuxLogs(r io.Reader) (string, string) {
	var stdout, stderr bytes.Buffer
	hdr := make([]byte, 8)
	for {
		if _, err := io.ReadFull(r, hdr); err != nil {
			break
		}
		size := int64(binary.BigEndian.Uint32(hdr[4:8]))
		var dst *bytes.Buffer
		switch hdr[0] {
		case 1:
			dst = &stdout
		case 2:
			dst = &stderr
		}
		if err := consumeFrame(dst, r, size); err != nil {
			break
		}
	}
	return stdout.String(), stderr.String()
}

func consumeFrame(dst *bytes.Buffer, r io.Reader, n int64) error {
	if n == 0 {
		return nil
	}
	if dst == nil {
		_, err := io.CopyN(io.Discard, r, n)
		return err
	}
	remain := int64(outputCap - dst.Len())
	if remain < 0 {
		remain = 0
	}
	take := n
	if take > remain {
		take = remain
	}
	if take > 0 {
		if _, err := io.CopyN(dst, r, take); err != nil {
			return err
		}
	}
	if n > take {
		_, err := io.CopyN(io.Discard, r, n-take)
		return err
	}
	return nil
}
