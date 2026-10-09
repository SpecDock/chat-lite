package sandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"runtime"
	"time"
)

const SocketPath = "/run/table-sandbox/table-sandbox.sock"
const JobsDir = "/run/table-sandbox/jobs"

type Result struct {
	Status     string `json:"status"`
	ExitCode   *int   `json:"exit_code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMS int    `json:"duration_ms"`
	TimedOut   bool   `json:"timed_out"`
}

func Run(ctx context.Context, jobID, code string) (Result, error) {
	if runtime.GOOS != "linux" {
		return Result{}, fmt.Errorf("表格沙箱只在 Linux Docker 运行环境中可用")
	}
	body, _ := json.Marshal(map[string]string{"jobId": jobID, "code": code})
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", SocketPath)
	}}
	client := &http.Client{Transport: transport, Timeout: 35 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost/run", bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
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
