package httpapi

import "testing"

func TestStopPlanDoesNotCancelForeignConversation(t *testing.T) {
	cancel, code := stopPlan(false, "owner-a", "owner-b")
	if cancel || code != 404 {
		t.Fatalf("foreign conversation cancel=%t code=%d", cancel, code)
	}
	cancel, code = stopPlan(true, "owner-a", "owner-b")
	if cancel || code != 403 {
		t.Fatalf("foreign live generation cancel=%t code=%d", cancel, code)
	}
	cancel, code = stopPlan(true, "owner-a", "owner-a")
	if !cancel || code != 200 {
		t.Fatalf("owner cancel=%t code=%d", cancel, code)
	}
	cancel, code = stopPlan(true, "", "owner-a")
	if !cancel || code != 200 {
		t.Fatalf("no live generation cancel=%t code=%d", cancel, code)
	}
}

func TestGenerationOwnerDoesNotStop(t *testing.T) {
	const id = "conv_stop_probe"
	_, gen, done := beginGeneration(id, "asst_stop_probe", "owner-a")
	defer done()
	if generationOwner(id) != "owner-a" {
		t.Fatal("owner mismatch")
	}
	gen.mu.Lock()
	stopped := gen.stopped
	gen.mu.Unlock()
	if stopped {
		t.Fatal("reading the owner cancelled the generation")
	}
}
