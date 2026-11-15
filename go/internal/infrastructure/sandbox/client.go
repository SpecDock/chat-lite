package sandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"time"
)

const SocketPath = "/run/table-sandbox/table-sandbox.sock"
const JobsDir = "/run/table-sandbox/jobs"
const SessionsDir = "/run/table-sandbox/sessions"

const heldMarker = ".sandbox-held"

var jobIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

type Result struct {
	Status              string `json:"status"`
	ExitCode            *int   `json:"exit_code"`
	Stdout              string `json:"stdout"`
	Stderr              string `json:"stderr"`
	DurationMS          int    `json:"duration_ms"`
	TimedOut            bool   `json:"timed_out"`
	Truncated           bool   `json:"truncated"`
	InfrastructureError string `json:"infrastructure_error,omitempty"`
	OOMKilled           bool   `json:"oom_killed,omitempty"`
}

type BashRequest struct {
	Command        string `json:"command"`
	Cwd            string `json:"cwd"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

func ExecBashSession(ctx context.Context, conversationID string, request BashRequest) (Result, error) {
	if runtime.GOOS != "linux" {
		return Result{}, fmt.Errorf("沙箱只在 Linux Docker 运行环境中可用")
	}
	var result Result
	err := postSession(ctx, "/session/bash", map[string]any{"id": conversationID, "command": request.Command, "cwd": request.Cwd, "timeout_seconds": request.TimeoutSeconds}, &result, nil)
	if err != nil {
		// Cancelling HTTP is not evidence that the container has been stopped.
		// Status takes the broker's same-session gate. Never resend the command.
		barrierCtx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
		defer cancel()
		var state SessionState
		barrierErr := postSession(barrierCtx, "/session/status", map[string]any{"id": conversationID}, &state, nil)
		result.Status = "interrupted"
		result.InfrastructureError = "execution outcome unavailable after HTTP failure; command was not retried"
		if barrierErr != nil {
			result.InfrastructureError += "; cleanup pending/unavailable: " + barrierErr.Error()
			return result, fmt.Errorf("%w; %s", err, result.InfrastructureError)
		}
		result.InfrastructureError += "; session cleanup barrier completed"
		return result, fmt.Errorf("%w; %s", err, result.InfrastructureError)
	}
	return result, err
}

func DeleteSession(ctx context.Context, conversationID string) error {
	if !jobIDPattern.MatchString(conversationID) {
		return errors.New("invalid sandbox session")
	}
	if runtime.GOOS != "linux" {
		return nil
	}
	return postSession(ctx, "/session/delete", map[string]any{"id": conversationID}, nil, nil)
}

func Run(ctx context.Context, jobID, code string) (Result, error) {
	if runtime.GOOS != "linux" {
		return Result{}, fmt.Errorf("表格沙箱只在 Linux Docker 运行环境中可用")
	}
	body, _ := json.Marshal(map[string]string{"jobId": jobID, "code": code})
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", SocketPath)
	}}
	client := &http.Client{Transport: transport, Timeout: 70 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost/run", bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		if waitErr := waitUntilReleased(jobID); waitErr != nil {
			return Result{}, waitErr
		}
		return Result{}, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var parsed Result
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return Result{}, fmt.Errorf("表格沙箱返回了无效结果")
	}
	if res.StatusCode != 200 {
		var errBody struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &errBody)
		if errBody.Error == "" {
			errBody.Error = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		return Result{}, fmt.Errorf("表格沙箱不可用：%s", errBody.Error)
	}
	if parsed.Status != "succeeded" && parsed.Status != "failed" && parsed.Status != "timeout" {
		return Result{}, fmt.Errorf("表格沙箱返回了未知状态")
	}
	return parsed, nil
}

type SessionState struct {
	Alive     bool   `json:"alive"`
	ExpiresAt string `json:"expiresAt"`
}

func SessionStatus(ctx context.Context, conversationID string) (SessionState, error) {
	if runtime.GOOS != "linux" {
		return SessionState{}, nil
	}
	var state SessionState
	err := postSession(ctx, "/session/status", map[string]any{"id": conversationID}, &state, nil)
	return state, err
}

func EnsureSession(ctx context.Context, conversationID string, refresh bool) error {
	if runtime.GOOS != "linux" {
		return fmt.Errorf("表格沙箱只在 Linux Docker 运行环境中可用")
	}
	return postSession(ctx, "/session/ensure", map[string]any{"id": conversationID, "refresh": refresh}, nil, nil)
}

func TouchSession(ctx context.Context, conversationID string) error {
	if runtime.GOOS != "linux" {
		return fmt.Errorf("表格沙箱只在 Linux Docker 运行环境中可用")
	}
	return postSession(ctx, "/session/touch", map[string]any{"id": conversationID}, nil, nil)
}

func ExecSession(ctx context.Context, conversationID, path string) (Result, error) {
	if runtime.GOOS != "linux" {
		return Result{}, fmt.Errorf("表格沙箱只在 Linux Docker 运行环境中可用")
	}
	var result Result
	err := postSession(ctx, "/session/exec", map[string]any{"id": conversationID, "path": path}, &result, nil)
	return result, err
}

func ReadSession(ctx context.Context, conversationID, path string) ([]byte, error) {
	if runtime.GOOS != "linux" {
		return nil, fmt.Errorf("表格沙箱只在 Linux Docker 运行环境中可用")
	}
	var body []byte
	err := postSession(ctx, "/session/read", map[string]any{"id": conversationID, "path": path}, nil, &body)
	return body, err
}

func postSession(ctx context.Context, path string, payload any, into any, rawOut *[]byte) error {
	body, _ := json.Marshal(payload)
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", SocketPath)
	}}, Timeout: 340 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost"+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if res.StatusCode == http.StatusServiceUnavailable {
		return fmt.Errorf("沙箱名额已满")
	}
	if res.StatusCode == http.StatusConflict {
		return fmt.Errorf("容器已回收")
	}
	if res.StatusCode != http.StatusOK {
		var errBody struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &errBody)
		if errBody.Error == "" {
			errBody.Error = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		return fmt.Errorf("表格沙箱不可用：%s", errBody.Error)
	}
	if rawOut != nil {
		*rawOut = raw
		return nil
	}
	if into == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return fmt.Errorf("表格沙箱返回了无效结果")
	}
	return nil
}

func waitUntilReleased(jobID string) error {
	if !jobIDPattern.MatchString(jobID) {
		return errors.New("表格沙箱仍在占用作业目录")
	}
	marker := filepath.Join(JobsDir, jobID, heldMarker)
	deadline := time.Now().Add(33 * time.Second)
	grace := time.Now().Add(time.Second)
	for {
		_, err := os.Lstat(marker)
		absent := errors.Is(err, os.ErrNotExist)
		if err != nil && !absent {
			return errors.New("表格沙箱仍在占用作业目录")
		}
		if absent && time.Now().After(grace) {
			return nil
		}
		if time.Now().After(deadline) {
			if absent {
				return nil
			}
			return errors.New("表格沙箱仍在占用作业目录")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
