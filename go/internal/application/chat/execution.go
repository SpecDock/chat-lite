package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/infrastructure/sandbox"
	"chatlite/internal/platform/idgen"
)

type SourceSnapshot struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// ExecutionCard is a server-owned projection, never parsed from model prose.
type ExecutionCard struct {
	ExecutionID         string           `json:"executionId"`
	Status              string           `json:"status"`
	Language            string           `json:"language"`
	Code                *string          `json:"code,omitempty"`
	Output              *string          `json:"output,omitempty"`
	ExitCode            *int             `json:"exitCode"`
	DurationMS          int              `json:"durationMs"`
	Truncated           bool             `json:"truncated"`
	InfrastructureError string           `json:"infrastructureError,omitempty"`
	OOMKilled           bool             `json:"oomKilled,omitempty"`
	ShowCode            bool             `json:"showCode"`
	ShowStdout          bool             `json:"showStdout"`
	ShowStderr          bool             `json:"showStderr"`
	SourceSnapshots     []SourceSnapshot `json:"sourceSnapshots,omitempty"`
}

type executionRecord struct {
	ID      string           `json:"execution_id"`
	Command string           `json:"command"`
	Cwd     string           `json:"cwd"`
	Sources []SourceSnapshot `json:"source_snapshots"`
	sandbox.Result
}

var ErrConversationBusy = errors.New("会话正在执行，请稍后重试")

// ConversationLease owns a dedicated connection, never a business-pool slot.
// Its private fields prevent callers from fabricating an acquired lease.
type ConversationLease struct {
	conn           *pgx.Conn
	conversationID string
}

func AcquireConversationLease(ctx context.Context, pool *pgxpool.Pool, conversationID string) (*ConversationLease, error) {
	connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(connectCtx, pool.Config().ConnConfig.Copy())
	if err != nil {
		return nil, err
	}
	var locked bool
	if err = conn.QueryRow(connectCtx, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, "execution:"+conversationID).Scan(&locked); err != nil || !locked {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = conn.Close(closeCtx)
		closeCancel()
		if err == nil {
			err = ErrConversationBusy
		}
		return nil, err
	}
	return &ConversationLease{conn: conn, conversationID: conversationID}, nil
}

func (lease *ConversationLease) Release() {
	if lease == nil || lease.conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Closing this dedicated connection releases its session advisory lock.
	_ = lease.conn.Close(ctx)
}

func (lease *ConversationLease) holds(conversationID string) bool {
	return lease != nil && lease.conn != nil && !lease.conn.IsClosed() && lease.conversationID == conversationID
}

// Called only while the conversation lease is held. A previous running row
// therefore cannot belong to another live generation holding the same lease.
func recoverExecutions(ctx context.Context, pool *pgxpool.Pool, in Input) error {
	_, err := pool.Exec(ctx, `UPDATE execution_records SET status='interrupted',finished_at=$3,infrastructure_error='Previous execution ended without a finalized result' WHERE user_id=$1 AND conversation_id=$2 AND status='running'`, in.UserID, in.ConversationID, idgen.NowISO())
	return err
}

func executionFailure(name string, err error) (string, map[string]any, []Event) {
	return name + " 失败：" + err.Error(), nil, []Event{{Type: "think", Text: "工具调用失败：" + name}}
}

func runBash(ctx context.Context, pool *pgxpool.Pool, in Input, work *scratch, args map[string]any) (string, map[string]any, []Event) {
	if work == nil {
		return executionFailure("bash", errScratch("工作区不可用"))
	}
	command := stringArg(args["command"])
	if strings.TrimSpace(command) == "" || len(command) > 1<<20 {
		return executionFailure("bash", errScratch("command 必填且不能超过 1MB"))
	}
	cwd := stringArg(args["cwd"])
	if cwd == "" {
		cwd = "/work"
	}
	timeout := 60
	if raw := args["timeout_seconds"]; raw != nil {
		n, ok := raw.(float64)
		if !ok || n < 1 || n > 300 || n != float64(int(n)) {
			return executionFailure("bash", errScratch("timeout_seconds 必须为 1 到 300 的整数"))
		}
		timeout = int(n)
	}
	sources := []SourceSnapshot{}
	if raw := args["source_paths"]; raw != nil {
		items, ok := raw.([]any)
		if !ok || len(items) > 5 {
			return executionFailure("bash", errScratch("source_paths 最多包含 5 个路径"))
		}
		for _, item := range items {
			path, ok := item.(string)
			if !ok {
				return executionFailure("bash", errScratch("source_paths 必须为字符串数组"))
			}
			rel := cleanRel(path)
			if rel == "" {
				return executionFailure("bash", errScratch("source_paths 只允许 /work 内的文件"))
			}
			body, err := work.readRegular(rel, 1<<20)
			if err != nil {
				return executionFailure("bash", fmt.Errorf("快照 %s: %w", path, err))
			}
			text, err := textBody(body)
			if err != nil {
				return executionFailure("bash", err)
			}
			sources = append(sources, SourceSnapshot{Path: rel, Content: text})
		}
	}
	record := executionRecord{ID: idgen.NewID("exec"), Command: command, Cwd: cwd, Sources: sources}
	sourceJSON, _ := json.Marshal(sources)
	tag, err := pool.Exec(ctx, `INSERT INTO execution_records(id,user_id,conversation_id,command,cwd,source_snapshots,status,created_at) SELECT $1,$2,$3,$4,$5,$6,'running',$7 WHERE EXISTS(SELECT 1 FROM conversations WHERE id=$3 AND user_id=$2)`, record.ID, in.UserID, in.ConversationID, command, cwd, sourceJSON, idgen.NowISO())
	if err != nil {
		return executionFailure("bash", err)
	}
	if tag.RowsAffected() != 1 {
		return executionFailure("bash", errScratch("会话不存在或不属于当前用户"))
	}
	started := time.Now()
	result, runErr := sandbox.ExecBashSession(ctx, in.ConversationID, sandbox.BashRequest{Command: command, Cwd: cwd, TimeoutSeconds: timeout})
	if result.Status == "" {
		result.Status = "failed"
		if errors.Is(ctx.Err(), context.Canceled) {
			result.Status = "cancelled"
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			result.Status = "timeout"
		}
	}
	switch result.Status {
	case "succeeded", "failed", "timeout", "cancelled", "interrupted", "oom":
	default:
		result.Status = "failed"
	}
	if result.OOMKilled {
		result.Status = "oom"
	}
	if runErr != nil && result.InfrastructureError == "" {
		result.InfrastructureError = runErr.Error()
	}
	if result.DurationMS == 0 {
		result.DurationMS = int(time.Since(started).Milliseconds())
	}
	record.Result = result
	// Broker returns only after task cleanup. Cancellation must not prevent the
	// private record being finalized, nor wait unboundedly on a dead connection.
	finishCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err = pool.Exec(finishCtx, `UPDATE execution_records SET status=$4,exit_code=$5,stdout=$6,stderr=$7,duration_ms=$8,truncated=$9,infrastructure_error=$10,oom_killed=$11,finished_at=$12 WHERE id=$1 AND user_id=$2 AND conversation_id=$3 AND status='running'`, record.ID, in.UserID, in.ConversationID, result.Status, result.ExitCode, result.Stdout, result.Stderr, result.DurationMS, result.Truncated, result.InfrastructureError, result.OOMKilled, idgen.NowISO())
	if err != nil {
		return executionFailure("bash", fmt.Errorf("execution_id=%s 定稿失败: %w", record.ID, err))
	}
	// Publish independently of show_execution, including useful partial outputs
	// from failed commands, but never after an unconfirmed cleanup/infra failure.
	note := ""
	if result.InfrastructureError == "" {
		work.syncBucket("output")
		var saveErr error
		note, saveErr = publishBashOutputs(finishCtx, pool, in, work)
		if saveErr != nil {
			note = "产物发布失败：" + saveErr.Error()
		}
	}
	raw, _ := json.Marshal(record)
	return string(raw) + "\n" + note, nil, []Event{{Type: "think", Text: "bash 执行状态：" + result.Status}}
}

func boolDefault(args map[string]any, key string, fallback bool) bool {
	v, ok := args[key].(bool)
	if !ok {
		return fallback
	}
	return v
}

func showExecution(ctx context.Context, pool *pgxpool.Pool, in Input, args map[string]any) (string, map[string]any, []Event) {
	id := stringArg(args["execution_id"])
	var command, stdout, stderr string
	var sources []byte
	card := ExecutionCard{ExecutionID: id, Language: "bash", ShowCode: boolDefault(args, "show_code", true), ShowStdout: boolDefault(args, "show_stdout", true), ShowStderr: boolDefault(args, "show_stderr", false)}
	err := pool.QueryRow(ctx, `SELECT command,source_snapshots,status,exit_code,stdout,stderr,duration_ms,truncated,infrastructure_error,oom_killed FROM execution_records WHERE id=$1 AND user_id=$2 AND conversation_id=$3`, id, in.UserID, in.ConversationID).Scan(&command, &sources, &card.Status, &card.ExitCode, &stdout, &stderr, &card.DurationMS, &card.Truncated, &card.InfrastructureError, &card.OOMKilled)
	if err != nil {
		return executionFailure("show_execution", errScratch("执行记录不存在或不属于当前用户及会话"))
	}
	if card.ShowCode {
		card.Code = &command
		if err = json.Unmarshal(sources, &card.SourceSnapshots); err != nil {
			return executionFailure("show_execution", err)
		}
	}
	parts := []string{}
	if card.ShowStdout {
		parts = append(parts, "stdout:\n"+stdout)
	}
	if card.ShowStderr {
		parts = append(parts, "stderr:\n"+stderr)
	}
	if len(parts) > 0 {
		output := strings.Join(parts, "\n\n")
		card.Output = &output
	}
	return "已展示 execution_id=" + id + "，真实状态：" + card.Status, nil, []Event{{Type: "execution", Execution: &card}}
}
