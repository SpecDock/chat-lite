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
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	sessionIdle   = 30 * time.Minute
	sessionRoot   = "/run/table-sandbox/sessions"
	sessionNet    = "chatlite-sandbox"
	readByteLimit = 1<<20 + 1
	cleanupBudget = 25 * time.Second
)

type bashRequest struct {
	Command        string `json:"command"`
	Cwd            string `json:"cwd"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}
type liveSession struct {
	gate        chan struct{}
	container   string
	expires     time.Time
	unavailable string
}
type sessionTable struct {
	mu    sync.Mutex
	items map[string]*liveSession
	live  int
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
	Status    string `json:"Status"`
}

var errGone = errors.New("sandbox gone")

func (t *sessionTable) entry(id string) *liveSession {
	t.mu.Lock()
	defer t.mu.Unlock()
	item := t.items[id]
	if item == nil {
		item = &liveSession{gate: make(chan struct{}, 1)}
		t.items[id] = item
	}
	return item
}
func lockSession(ctx context.Context, item *liveSession) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case item.gate <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-item.gate
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func unlockSession(item *liveSession) { <-item.gate }

func (b *broker) serveSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, errJSON{Error: "method not allowed"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	defer r.Body.Close()
	var p struct {
		ID      string `json:"id"`
		Refresh bool   `json:"refresh"`
		Path    string `json:"path"`
		bashRequest
	}
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&p); err != nil || !jobIDPattern.MatchString(p.ID) {
		writeJSON(w, 400, errJSON{Error: "invalid session request"})
		return
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		writeJSON(w, 400, errJSON{Error: "invalid request suffix"})
		return
	}
	if r.URL.Path == "/session/bash" || r.URL.Path == "/session/exec" {
		request := p.bashRequest
		if r.URL.Path == "/session/exec" {
			rel := strings.TrimPrefix(strings.ReplaceAll(p.Path, "\\", "/"), "/")
			if rel == "" || strings.Contains(rel, "..") || strings.HasPrefix(rel, "input/") || !strings.HasSuffix(strings.ToLower(rel), ".py") {
				writeSessionErr(w, errInvalid)
				return
			}
			request = bashRequest{Command: "python -I -B -- " + shellQuote("/work/"+rel)}
		}
		if err := validateBash(&request); err != nil {
			writeSessionErr(w, err)
			return
		}
		// The real task admission spans ensure, execution AND independent cleanup.
		if err := b.gate.acquire(r.Context()); err != nil {
			writeSessionErr(w, err)
			return
		}
		defer b.gate.release()
		item := sessions.entry(p.ID)
		if err := lockSession(r.Context(), item); err != nil {
			writeSessionErr(w, err)
			return
		}
		defer unlockSession(item)
		if _, err := sessions.ensureLocked(r.Context(), b.eng, p.ID, item, true); err != nil {
			writeSessionErr(w, err)
			return
		}
		result := sessions.runBash(r.Context(), b.eng, item, request)
		writeJSON(w, 200, result)
		return
	}
	item := sessions.entry(p.ID)
	if err := lockSession(r.Context(), item); err != nil {
		writeSessionErr(w, err)
		return
	}
	defer unlockSession(item)
	switch r.URL.Path {
	case "/session/ensure":
		view, err := sessions.ensureLocked(r.Context(), b.eng, p.ID, item, p.Refresh)
		if err != nil {
			writeSessionErr(w, err)
			return
		}
		writeJSON(w, 200, view)
	case "/session/status", "/session/touch":
		if item.unavailable != "" {
			writeSessionErr(w, errors.New(item.unavailable))
			return
		}
		alive := item.container != "" && item.expires.After(time.Now())
		if alive {
			state, err := b.eng.inspectSession(r.Context(), item.container)
			if err != nil {
				writeSessionErr(w, err)
				return
			}
			alive = state != nil && state.Running
		}
		if r.URL.Path == "/session/touch" {
			if !alive {
				writeSessionErr(w, errGone)
				return
			}
			item.expires = time.Now().Add(sessionIdle)
		}
		view := sessionView{Alive: alive}
		if alive {
			view.ExpiresAt = item.expires.Format(time.RFC3339)
		}
		writeJSON(w, 200, view)
	case "/session/read":
		if item.unavailable != "" {
			writeSessionErr(w, errors.New(item.unavailable))
			return
		}
		if item.container == "" || !item.expires.After(time.Now()) {
			writeSessionErr(w, errGone)
			return
		}
		if !validContainerPath(p.Path) {
			writeSessionErr(w, errInvalid)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		raw, err := b.eng.readFile(ctx, item.container, p.Path)
		if err != nil {
			writeSessionErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(200)
		_, _ = w.Write(raw)
	case "/session/delete":
		ctx, cancel := context.WithTimeout(context.Background(), cleanupBudget)
		defer cancel()
		if err := sessions.removeLocked(ctx, b.eng, item); err != nil {
			writeSessionErr(w, err)
			return
		}
		// Root.RemoveAll never follows untrusted symlinks out of the trusted sessions root.
		root, err := os.OpenRoot(sessionRoot)
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, 200, sessionView{})
			return
		}
		if err != nil {
			writeSessionErr(w, err)
			return
		}
		defer root.Close()
		if err = root.RemoveAll(p.ID); err != nil {
			writeSessionErr(w, err)
			return
		}
		item.unavailable = ""
		writeJSON(w, 200, sessionView{})
	default:
		writeJSON(w, 404, errJSON{Error: "not found"})
	}
}

func writeSessionErr(w http.ResponseWriter, err error) {
	code := 500
	switch {
	case errors.Is(err, errBusy):
		code = 503
	case errors.Is(err, errGone):
		code = 409
	case errors.Is(err, errInvalid):
		code = 400
	}
	log.Printf("sandbox session: %v", err)
	writeJSON(w, code, errJSON{Error: safeErr(err)})
}
func validateBash(r *bashRequest) error {
	if strings.TrimSpace(r.Command) == "" || len(r.Command) > 64*1024 || !utf8.ValidString(r.Command) || strings.ContainsRune(r.Command, 0) {
		return fmt.Errorf("%w: command must be valid UTF-8, nonempty, at most 64KiB, without NUL", errInvalid)
	}
	if r.TimeoutSeconds == 0 {
		r.TimeoutSeconds = 60
	}
	if r.TimeoutSeconds < 1 || r.TimeoutSeconds > 300 {
		return fmt.Errorf("%w: timeout_seconds must be 1..300", errInvalid)
	}
	if r.Cwd == "" {
		r.Cwd = "/work"
	}
	if !utf8.ValidString(r.Cwd) || len(r.Cwd) > 4096 || strings.ContainsAny(r.Cwd, "\x00\r\n") {
		return errInvalid
	}
	if !strings.HasPrefix(r.Cwd, "/") {
		r.Cwd = "/work/" + r.Cwd
	}
	r.Cwd = path.Clean(r.Cwd)
	if r.Cwd != "/work" && !strings.HasPrefix(r.Cwd, "/work/") {
		return fmt.Errorf("%w: cwd must stay within /work", errInvalid)
	}
	return nil
}
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

func (t *sessionTable) ensureLocked(ctx context.Context, e *engine, id string, item *liveSession, refresh bool) (sessionView, error) {
	if item.unavailable != "" {
		return sessionView{}, fmt.Errorf("sandbox unavailable: %s", item.unavailable)
	}
	if item.container != "" && item.expires.After(time.Now()) {
		state, err := e.inspectSession(ctx, item.container)
		if err != nil {
			return sessionView{}, err
		}
		if state == nil || !state.Running {
			item.unavailable = "container stopped outside command cleanup"
			return sessionView{}, errors.New(item.unavailable)
		}
		if refresh {
			item.expires = time.Now().Add(sessionIdle)
		}
		return sessionView{Alive: true, ExpiresAt: item.expires.Format(time.RFC3339)}, nil
	}
	if item.container != "" {
		if err := t.removeLocked(ctx, e, item); err != nil {
			return sessionView{}, err
		}
	}
	t.mu.Lock()
	if t.live >= runningCap {
		t.mu.Unlock()
		return sessionView{}, errBusy
	}
	t.live++
	t.mu.Unlock()
	reserved := true
	defer func() {
		if reserved {
			t.mu.Lock()
			t.live--
			t.mu.Unlock()
		}
	}()
	if err := prepareSessionDir(id); err != nil {
		return sessionView{}, err
	}
	name := "chatlite-sess-" + id
	created, err := e.createSession(ctx, name, id)
	if err != nil {
		return sessionView{}, err
	}
	item.container = created
	reserved = false
	if err = e.start(ctx, created); err == nil {
		err = e.ready(ctx, created)
	}
	if err != nil {
		item.unavailable = "startup failed: " + safeErr(err)
		clean, cancel := context.WithTimeout(context.Background(), cleanupBudget)
		defer cancel()
		_ = e.kill(clean, created)
		return sessionView{}, errors.New(item.unavailable)
	}
	item.expires = time.Now().Add(sessionIdle)
	return sessionView{Alive: true, Created: true, ExpiresAt: item.expires.Format(time.RFC3339)}, nil
}
func (t *sessionTable) removeLocked(ctx context.Context, e *engine, item *liveSession) error {
	if item.container == "" {
		return nil
	}
	if err := e.forceRemove(ctx, item.container); err != nil {
		item.unavailable = "container removal failed: " + safeErr(err)
		return errors.New(item.unavailable)
	}
	item.container = ""
	item.expires = time.Time{}
	t.mu.Lock()
	t.live--
	t.mu.Unlock()
	return nil
}
func sweepSessions(e *engine) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		sessions.mu.Lock()
		snapshot := make(map[string]*liveSession, len(sessions.items))
		for id, item := range sessions.items {
			snapshot[id] = item
		}
		sessions.mu.Unlock()
		for id, item := range snapshot {
			// Never wait behind an active command; recheck expiry and identity under its gate.
			select {
			case item.gate <- struct{}{}:
			default:
				continue
			}
			sessions.mu.Lock()
			same := sessions.items[id] == item
			sessions.mu.Unlock()
			if same && item.container != "" && !item.expires.After(time.Now()) && item.unavailable == "" {
				ctx, cancel := context.WithTimeout(context.Background(), cleanupBudget)
				if err := sessions.removeLocked(ctx, e, item); err != nil {
					log.Printf("sandbox TTL %s: %v", id, err)
				}
				cancel()
			}
			unlockSession(item)
		}
	}
}

func (t *sessionTable) runBash(ctx context.Context, e *engine, item *liveSession, r bashRequest) runResult {
	started := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(r.TimeoutSeconds)*time.Second)
	// Resolve cwd physically inside the container before invoking the independent shell.
	// Passing command as argv avoids interpolation and profile/rc processing.
	cmd := []string{"python", "-I", "-B", "-c", `import os,sys
p=os.path.realpath(sys.argv[1])
if p!='/work' and not p.startswith('/work/'): raise SystemExit('cwd escapes /work')
os.chdir(p)
os.execv('/bin/bash',['/bin/bash','--noprofile','--norc','-c',sys.argv[2]])`, r.Cwd, r.Command}
	stdout, stderr, code, truncated, err := e.execCapture(runCtx, item.container, cmd, "/work", outputCap)
	stdout, stderr, truncated = safeOutput(stdout, stderr, truncated)
	runErr := runCtx.Err()
	cancel()
	result := runResult{Status: "interrupted", Stdout: stdout, Stderr: stderr, Truncated: truncated}
	if ctx.Err() != nil {
		result.Status = "cancelled"
	} else if runErr != nil {
		result.Status = "timeout"
		result.TimedOut = true
	} else if err != nil {
		result.InfrastructureError = safeErr(err)
	} else {
		result = finishResult(code, stdout, stderr, started)
		result.Truncated = truncated
	}
	// HTTP cancellation only ends I/O. This independent bounded stop is the kill boundary.
	clean, cancelClean := context.WithTimeout(context.Background(), cleanupBudget)
	defer cancelClean()
	oom, cleanupErr := e.resetSession(clean, item.container)
	if oom {
		result.OOMKilled = true
		result.Status = "oom"
		result.ExitCode = nil
	}
	if cleanupErr != nil {
		item.unavailable = "cleanup failed: " + safeErr(cleanupErr)
		result.InfrastructureError = item.unavailable
		if result.Status == "succeeded" || result.Status == "failed" {
			result.Status = "interrupted"
		}
	}
	item.expires = time.Now().Add(sessionIdle)
	result.DurationMS = int(time.Since(started).Milliseconds())
	return result
}

// Raw stdout+stderr share a 64KiB collector. Replace malformed UTF-8 with U+FFFD
// and NUL with the visible two-character \\0 for PostgreSQL text. A second shared
// 64KiB ceiling bounds encoding expansion and cuts only at UTF-8 boundaries.
// Truncated also marks this lossy transformation, with an explicit stderr note.
func safeOutput(stdout, stderr string, truncated bool) (string, string, bool) {
	changed := !utf8.ValidString(stdout) || !utf8.ValidString(stderr) || strings.ContainsRune(stdout, 0) || strings.ContainsRune(stderr, 0)
	stdout = strings.ReplaceAll(strings.ToValidUTF8(stdout, "\uFFFD"), "\x00", "\\0")
	stderr = strings.ReplaceAll(strings.ToValidUTF8(stderr, "\uFFFD"), "\x00", "\\0")
	note := ""
	if changed {
		note = "\n[sandbox: binary output sanitized; NUL=\\0, invalid UTF-8=U+FFFD]\n"
		truncated = true
	}
	limit := outputCap - len(note)
	trim := func(s string, n int) string {
		if len(s) <= n {
			return s
		}
		truncated = true
		for n > 0 && !utf8.RuneStart(s[n]) {
			n--
		}
		return s[:n]
	}
	stdout = trim(stdout, limit)
	stderr = trim(stderr, limit-len(stdout)) + note
	return stdout, stderr, truncated
}

func (e *engine) resetSession(ctx context.Context, id string) (bool, error) {
	before, err := e.inspectSession(ctx, id)
	if err != nil {
		return false, err
	}
	oom := before != nil && before.OOMKilled
	if err = e.do(ctx, http.MethodPost, containerURL(id, "/stop?t=0"), nil, nil); err != nil {
		var dock *dockerError
		if !errors.As(err, &dock) || dock.status != http.StatusNotModified {
			return oom, err
		}
	}
	// Docker's stopped state is reached only after all namespace/cgroup processes die.
	state, err := e.inspectSession(ctx, id)
	if err != nil {
		return oom, err
	}
	if state == nil || state.Running || state.Status != "exited" {
		return oom, errors.New("container stop not confirmed")
	}
	oom = oom || state.OOMKilled
	if err = e.start(ctx, id); err != nil {
		return oom, err
	}
	return oom, e.ready(ctx, id)
}
func (e *engine) ready(ctx context.Context, id string) error {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		state, err := e.inspectSession(ctx, id)
		if err != nil {
			return err
		}
		if state == nil || !state.Running {
			return errors.New("sandbox init exited before readiness")
		}
		_, _, code, _, err := e.execCapture(ctx, id, []string{"python", "-I", "-B", "-c", `s=dict(x.split(':',1) for x in open('/proc/1/status') if ':' in x);raise SystemExit(not (s['Uid'].split()==['1000']*4 and int(s['CapEff'],16)==0 and s['NoNewPrivs'].strip()=='1' and s['Name'].strip()=='sleep'))`}, "/work", 1024)
		if err == nil && code == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("sandbox init readiness: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func validContainerPath(p string) bool {
	return utf8.ValidString(p) && len(p) <= 4096 && (p == "/work" || strings.HasPrefix(p, "/work/")) && !strings.Contains(p, "..") && !strings.ContainsAny(p, "\x00\r\n")
}
func (e *engine) readFile(ctx context.Context, id, p string) ([]byte, error) {
	// Open once, reject procfs/magic/symlink escapes by checking the resulting fd.
	script := `import os,sys,stat
f=os.open(sys.argv[1],os.O_RDONLY|os.O_NONBLOCK)
p=os.readlink('/proc/self/fd/'+str(f))
if not p.startswith('/work/') or not stat.S_ISREG(os.fstat(f).st_mode): raise SystemExit(2)
sys.stdout.buffer.write(os.read(f,1048577))`
	out, errout, code, _, err := e.execCapture(ctx, id, []string{"python", "-I", "-B", "-c", script, p}, "/work", readByteLimit)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("read failed: %s", errout)
	}
	return []byte(out), nil
}
func (e *engine) exec(ctx context.Context, id string, cmd []string) (string, string, int, error) {
	out, errout, code, _, err := e.execCapture(ctx, id, cmd, "/work", outputCap)
	return out, errout, code, err
}
func (e *engine) execCapture(ctx context.Context, id string, cmd []string, cwd string, limit int) (string, string, int, bool, error) {
	// Docker exec changes User independently of the original container's OCI
	// capabilities. Drop and verify credentials BEFORE any model-owned path or
	// code is opened; -I prevents cwd/user-site/PYTHONPATH module injection.
	const dropCaps = `import ctypes,os,sys
libc=ctypes.CDLL(None,use_errno=True)
class Header(ctypes.Structure): _fields_=[('version',ctypes.c_uint32),('pid',ctypes.c_int)]
class Data(ctypes.Structure): _fields_=[('effective',ctypes.c_uint32),('permitted',ctypes.c_uint32),('inheritable',ctypes.c_uint32)]
def checked(value):
 if value!=0: raise OSError(ctypes.get_errno(),'sandbox capability isolation failed')
checked(libc.prctl(38,1,0,0,0))
checked(libc.prctl(47,4,0,0,0))
checked(libc.capset(ctypes.byref(Header(0x20080522,0)),ctypes.byref((Data*2)())))
s=dict(x.split(':',1) for x in open('/proc/self/status') if ':' in x)
if s['Uid'].split()!=['1000']*4 or s['Gid'].split()!=['1000']*4 or any(int(s[x],16) for x in ['CapEff','CapPrm','CapInh','CapAmb']) or s['NoNewPrivs'].strip()!='1': raise SystemExit('sandbox credentials not isolated')
os.execvp(sys.argv[1],sys.argv[1:])`
	cmd = append([]string{"python", "-I", "-B", "-c", dropCaps}, cmd...)
	var created struct {
		ID string `json:"Id"`
	}
	body := map[string]any{"AttachStdout": true, "AttachStderr": true, "Tty": false, "Privileged": false, "User": "1000:1000", "WorkingDir": cwd, "Cmd": cmd}
	if err := e.do(ctx, http.MethodPost, containerURL(id, "/exec"), body, &created); err != nil {
		return "", "", 0, false, err
	}
	if !refPattern.MatchString(created.ID) {
		return "", "", 0, false, errors.New("invalid docker exec id")
	}
	res, err := e.open(ctx, http.MethodPost, apiPrefix+"/exec/"+created.ID+"/start", map[string]any{"Detach": false, "Tty": false})
	if err != nil {
		return "", "", 0, false, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return "", "", 0, false, dockerStatusError(res.StatusCode, raw)
	}
	out, errout, truncated, err := drainOutput(res.Body, limit)
	if err != nil {
		return out, errout, 0, truncated, err
	}
	var inspected struct {
		Running  bool `json:"Running"`
		ExitCode *int `json:"ExitCode"`
	}
	if err = e.do(ctx, http.MethodGet, apiPrefix+"/exec/"+created.ID+"/json", nil, &inspected); err != nil {
		return out, errout, 0, truncated, err
	}
	if inspected.Running || inspected.ExitCode == nil {
		return out, errout, 0, truncated, errors.New("exec completion not confirmed")
	}
	return out, errout, *inspected.ExitCode, truncated, nil
}
func drainOutput(r io.Reader, limit int) (string, string, bool, error) {
	var out, errout bytes.Buffer
	var header [8]byte
	truncated := false
	for {
		_, err := io.ReadFull(r, header[:])
		if err == io.EOF {
			return out.String(), errout.String(), truncated, nil
		}
		if err != nil {
			return out.String(), errout.String(), truncated, err
		}
		if header[0] != 1 && header[0] != 2 {
			return out.String(), errout.String(), truncated, errors.New("invalid Docker output frame")
		}
		n := int64(binary.BigEndian.Uint32(header[4:]))
		remaining := limit - out.Len() - errout.Len()
		take := min(n, int64(remaining))
		dst := &out
		if header[0] == 2 {
			dst = &errout
		}
		if _, err = io.CopyN(dst, r, take); err != nil {
			return out.String(), errout.String(), truncated, err
		}
		if n > take {
			truncated = true
			if _, err = io.CopyN(io.Discard, r, n-take); err != nil {
				return out.String(), errout.String(), truncated, err
			}
		}
	}
}

func (e *engine) ensureNetwork(ctx context.Context) error {
	var created struct {
		ID string `json:"Id"`
	}
	body := map[string]any{"Name": sessionNet, "Driver": "bridge", "EnableIPv6": false, "Options": map[string]string{"com.docker.network.bridge.enable_icc": "false"}}
	err := e.do(ctx, http.MethodPost, apiPrefix+"/networks/create", body, &created)
	var dock *dockerError
	if errors.As(err, &dock) && (dock.status == 409 || strings.Contains(strings.ToLower(dock.message), "already exists")) {
		err = nil
	}
	if err != nil {
		return err
	}
	var inspected struct {
		EnableIPv6 bool              `json:"EnableIPv6"`
		Driver     string            `json:"Driver"`
		Options    map[string]string `json:"Options"`
	}
	if err = e.do(ctx, http.MethodGet, apiPrefix+"/networks/"+sessionNet, nil, &inspected); err != nil {
		return err
	}
	if inspected.EnableIPv6 || inspected.Driver != "bridge" || inspected.Options["com.docker.network.bridge.enable_icc"] != "false" {
		return errors.New("existing sandbox network is unsafe; recreate it manually")
	}
	return nil
}
func (e *engine) inspectSession(ctx context.Context, id string) (*sessionContainerState, error) {
	var inspected struct {
		State *sessionContainerState `json:"State"`
	}
	err := e.do(ctx, http.MethodGet, containerURL(id, "/json"), nil, &inspected)
	var dock *dockerError
	if errors.As(err, &dock) && dock.status == 404 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if inspected.State == nil {
		return nil, errors.New("Docker inspect returned no state")
	}
	return inspected.State, nil
}
func (e *engine) createSession(ctx context.Context, name, id string) (string, error) {
	if !jobIDPattern.MatchString(id) || !refPattern.MatchString(name) {
		return "", errInvalid
	}
	denied, err := e.hostAddresses(ctx)
	if err != nil {
		return "", fmt.Errorf("host egress isolation unavailable: %w", err)
	}
	spec := sandboxSpec(id)
	spec.User = "0:0"
	spec.Cmd = []string{"/usr/local/bin/chatlite-sandbox-init"}
	spec.HostConfig.NetworkMode = sessionNet
	spec.HostConfig.CapAdd = []string{"NET_ADMIN", "SETGID", "SETUID"}
	spec.HostConfig.CapDrop = []string{"ALL"}
	spec.HostConfig.Tmpfs = nil
	spec.HostConfig.Sysctls = map[string]string{"net.ipv6.conf.all.disable_ipv6": "1", "net.ipv6.conf.default.disable_ipv6": "1"}
	base := hostJobsRoot + "/sessions/" + id
	spec.HostConfig.Binds = []string{base + ":/work", base + "/input:/work/input:ro", base + "/.runtime/tmp:/tmp", base + "/.runtime/run:/run"}
	spec.Cmd = append(spec.Cmd, denied...)
	spec.HostConfig.SecurityOpt = append(spec.HostConfig.SecurityOpt, workerSeccomp())
	spec.Labels["chatlite.session"] = id
	var created struct {
		ID string `json:"Id"`
	}
	if err = e.do(ctx, http.MethodPost, apiPrefix+"/containers/create?name="+url.QueryEscape(name), spec, &created); err != nil {
		return "", err
	}
	if !refPattern.MatchString(created.ID) {
		return "", errors.New("Docker create returned invalid id")
	}
	return created.ID, nil
}

func prepareSessionDir(id string) error {
	if !jobIDPattern.MatchString(id) {
		return errInvalid
	}
	if err := os.MkdirAll(sessionRoot, 0755); err != nil {
		return err
	}
	root := filepath.Join(sessionRoot, id)
	if err := os.Mkdir(root, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("unsafe sandbox session directory")
	}
	// Fail closed before granting write access or admitting any process.
	if err = prepareQuota(root, id); err != nil {
		return fmt.Errorf("sandbox storage quota unavailable (requires dedicated XFS/ext4 with enforced project quotas, Linux >=5.14 and broker SYS_ADMIN; ext4 needs project/quota features and prjquota): %w", err)
	}
	if err = os.Chown(root, 0, 0); err != nil {
		return err
	}
	if err = os.Chmod(root, os.ModeSticky|0777); err != nil {
		return err
	}
	for _, d := range []struct {
		name string
		mode os.FileMode
		uid  int
	}{{"input", 0755, 0}, {".runtime", 0755, 0}, {"output", 0777, 0}, {".runtime/tmp", 0777, 0}, {".runtime/run", 0777, 0}, {".runtime/home", 0700, 1000}, {".runtime/cache", 0700, 1000}, {".runtime/go", 0700, 1000}} {
		p := filepath.Join(root, d.name)
		if err = os.Mkdir(p, d.mode); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		info, err = os.Lstat(p)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsafe sandbox directory %s", d.name)
		}
		if err = os.Chown(p, d.uid, d.uid); err != nil {
			return err
		}
		if err = os.Chmod(p, d.mode); err != nil {
			return err
		}
	}
	return nil
}
