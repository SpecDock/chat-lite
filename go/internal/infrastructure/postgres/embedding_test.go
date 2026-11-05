package postgres

import "testing"

func TestEmbeddingAlignDoesNotTouchStoredVectors(t *testing.T) {
	if EmbeddingAlignPlan(1536, 1024, 3) != "keep-mismatch" {
		t.Fatal("stored vectors must not be altered")
	}
	if EmbeddingAlignPlan(1536, 1024, 0) != "alter" {
		t.Fatal("empty column should be aligned")
	}
	if EmbeddingAlignPlan(1024, 1024, 0) != "keep" {
		t.Fatal("matching column should stay")
	}
	if vectorDim("vector(1536)") != 1536 || vectorDim("vector(1024)") != 1024 {
		t.Fatal("dimension parse failed")
	}
}
