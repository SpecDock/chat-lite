package chat

import "testing"

func TestPlanReminderEveryFifthRound(t *testing.T) {
	for _, round := range []int{0, 1, 4, 6, 9, 11} {
		if planReminderDue(round) {
			t.Fatalf("round %d should not remind", round)
		}
	}
	for _, round := range []int{5, 10, 50} {
		if !planReminderDue(round) {
			t.Fatalf("round %d should remind", round)
		}
	}
}

func TestTodoWriteSendsThinkAndKeepsPlan(t *testing.T) {
	text, image, events := runTodo(map[string]any{"todos": []any{
		map[string]any{"content": "查资料", "status": "completed"},
		map[string]any{"content": "计算结果", "status": "in_progress"},
	}})
	if image != nil {
		t.Fatal("plan tool must not attach an image")
	}
	if len(events) != 1 || events[0].Type != "think" || events[0].Text != "规划：已完成 查资料；进行中 计算结果" {
		t.Fatalf("think chunk = %#v", events)
	}
	if text == "" || text == planReminderText {
		t.Fatal("tool result must be the plan, not the automatic reminder")
	}
}

func TestTodoWriteRejectsBadPlan(t *testing.T) {
	_, _, events := runTodo(map[string]any{"todos": []any{map[string]any{"content": "", "status": "later"}}})
	if len(events) != 1 || events[0].Type != "think" {
		t.Fatal("invalid plan must still report a think chunk")
	}
}
