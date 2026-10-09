package rag

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"chatlite/internal/domain/visibility"
	"chatlite/internal/platform/idgen"
)

var (
	thinkOpenRE     = regexp.MustCompile(`(?is)<think>[\s\S]*?(</think>|$)`)
	imageMDRE       = regexp.MustCompile(`!\[[^\]]*\]\([^)]+\)`)
	fenceBlockRE    = regexp.MustCompile("(?s)```[\\s\\S]*?```")
	tagRE           = regexp.MustCompile(`<[^>]+>`)
	trailingSpaceRE = regexp.MustCompile(`[ \t]+\n`)
	leadingSpaceRE  = regexp.MustCompile(`\n[ \t]+`)
	multiSpaceRE    = regexp.MustCompile(`[ \t]{2,}`)
	multiNLRE       = regexp.MustCompile(`\n{3,}`)
	wordRE          = regexp.MustCompile(`[a-z0-9][a-z0-9._-]*`)
)

type Hit struct {
	MessageID      string
	ConversationID string
	Role           string
	Text           string
	Importance     float64
	Score          float64
}

type IndexInput struct {
	UserID         string
	ConversationID string
	MessageID      string
	Role           string
	Content        string
	Status         string
	CreatedAt      string
}

func envBool(name string, fallback bool) bool {
	raw, ok := os.LookupEnv(name)
	if !ok {
		return fallback
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func envInt(name string, fallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || n < 0 {
		return fallback
	}
	return n
}

func envFloat(name string, fallback float64) float64 {
	n, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(name)), 64)
	if err != nil {
		return fallback
	}
	return n
}

func writeEnabled() bool { return envBool("RAG_WRITE_ENABLED", false) }
func readEnabled() bool  { return envBool("RAG_READ_ENABLED", false) }
func shadowEnabled() bool {
	return envBool("RAG_SHADOW_ENABLED", false)
}
func readActive() bool { return readEnabled() || shadowEnabled() }

func Available() bool { return writeEnabled() || readActive() }

func IndexChatMessage(pool *pgxpool.Pool, input IndexInput) {
	if pool == nil || !Available() {
		return
	}
	status := input.Status
	if status == "" {
		status = "completed"
	}
	if !visibility.IsModelVisible(input.Role, input.Content, status) {
		DeleteMessage(context.Background(), pool, input.UserID, input.MessageID)
		return
	}
	if !writeEnabled() {
		return
	}
	input.Content = visibility.StripThinkBlocks(input.Content)
	input.Status = status
	go func() {
		if err := indexOne(context.Background(), pool, input); err != nil {
			log.Printf("[rag] index failed: %v", err)
		}
	}()
}

func indexOne(ctx context.Context, pool *pgxpool.Pool, input IndexInput) error {
	if input.Role != "user" && input.Role != "assistant" {
		return nil
	}
	maxChars := envInt("RAG_CONTENT_MAX_CHARS", 1200)
	cleaned := CleanForIndexing(input.Content, maxChars)
	if utf8.RuneCountInString(cleaned) < 8 && len(cleaned) < 8 {
		return nil
	}
	if len([]rune(cleaned)) < 8 {
		return nil
	}
	chunks := SplitIndexedChunks(cleaned)
	if len(chunks) == 0 {
		return nil
	}
	createdAt := input.CreatedAt
	if createdAt == "" {
		createdAt = idgen.NowISO()
	}
	dims := envInt("EMBEDDING_DIMENSIONS", 1536)
	type prepared struct {
		chunk Chunk
		vec   []float32
	}
	var items []prepared
	embeddingFailed := false
	useEmb := embeddingConfigured() && dims > 0
	for _, chunk := range chunks {
		var vec []float32
		if useEmb {
			v, err := embedText(ctx, chunk.Text)
			if err != nil || v == nil {
				embeddingFailed = true
			} else {
				vec = v
			}
		}
		items = append(items, prepared{chunk: chunk, vec: vec})
	}
	if useEmb && embeddingFailed {
		var exists int
		_ = pool.QueryRow(ctx, `SELECT 1 FROM rag_items WHERE user_id=$1 AND message_id=$2 LIMIT 1`, input.UserID, input.MessageID).Scan(&exists)
		if exists == 1 {
			log.Printf("[rag] embedding incomplete; preserving existing index for %s", input.MessageID)
			return nil
		}
	}
	if _, err := DeleteMessage(ctx, pool, input.UserID, input.MessageID); err != nil {
		return err
	}
	embedded := 0
	for i, item := range items {
		var emb any
		var embeddedAt any
		var dim any
		if item.vec != nil {
			emb = vectorLiteral(item.vec)
			embeddedAt = idgen.NowISO()
			dim = len(item.vec)
			embedded++
		}
		hash := contentHash(item.chunk.Text)
		_, err := pool.Exec(ctx, `INSERT INTO rag_items (id,user_id,conversation_id,message_id,role,chunk_index,chunk_text,parent_text,chunk_type,importance,created_at,embedded_at,embedding_dim,content_hash,embedding)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector)
			ON CONFLICT (conversation_id, content_hash) DO NOTHING`,
			fmt.Sprintf("rag_%s_%d_%s", input.MessageID, i, idgen.NewID("c")[len("c_"):]),
			input.UserID, input.ConversationID, input.MessageID, input.Role, i, item.chunk.Text, item.chunk.ParentText, item.chunk.Type, item.chunk.Importance, createdAt, embeddedAt, dim, hash, emb)
		if err != nil {
			_, err = pool.Exec(ctx, `INSERT INTO rag_items (id,user_id,conversation_id,message_id,role,chunk_index,chunk_text,parent_text,chunk_type,importance,created_at,embedded_at,embedding_dim,content_hash)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
				ON CONFLICT (conversation_id, content_hash) DO NOTHING`,
				fmt.Sprintf("rag_%s_%d_%s", input.MessageID, i, idgen.NewID("c")[2:]),
				input.UserID, input.ConversationID, input.MessageID, input.Role, i, item.chunk.Text, item.chunk.ParentText, item.chunk.Type, item.chunk.Importance, createdAt, embeddedAt, dim, hash)
			if err != nil {
				return err
			}
		}
	}
	log.Printf("[rag] indexed %s chunks=%d embedded=%d role=%s", input.MessageID, len(chunks), embedded, input.Role)
	return nil
}

func contentHash(text string) string {
	normalized := strings.ToLower(strings.Join(strings.Fields(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")), " "))
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])
}

func DeleteMessage(ctx context.Context, pool *pgxpool.Pool, userID, messageID string) (int, error) {
	if pool == nil {
		return 0, nil
	}
	tag, err := pool.Exec(ctx, `DELETE FROM rag_items WHERE user_id=$1 AND message_id=$2`, userID, messageID)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

func DeleteConversation(ctx context.Context, pool *pgxpool.Pool, conversationID string) {
	if pool == nil || conversationID == "" {
		return
	}
	_, _ = pool.Exec(ctx, `DELETE FROM rag_items WHERE conversation_id=$1`, conversationID)
}

func Retrieve(ctx context.Context, pool *pgxpool.Pool, userID, query, conversationID string) ([]Hit, error) {
	if pool == nil || !readActive() || strings.TrimSpace(query) == "" || conversationID == "" {
		return nil, nil
	}
	topK := envInt("RAG_TOP_K", 3)
	if topK <= 0 {
		return nil, nil
	}
	overFetch := 15
	var embedding []float32
	if embeddingConfigured() {
		if v, err := embedText(ctx, query); err == nil {
			embedding = v
		}
	}
	type cand struct {
		id         string
		distance   float64
		vectorRank int
		keyword    int
		item       itemRow
	}
	union := map[string]*cand{}
	if embedding != nil {
		rows, err := pool.Query(ctx, `SELECT id, chunk_text, parent_text, message_id, conversation_id, role, importance, created_at, (embedding <=> $1::vector) AS distance
			FROM rag_items WHERE conversation_id=$2 AND embedding IS NOT NULL
			ORDER BY embedding <=> $1::vector LIMIT $3`, vectorLiteral(embedding), conversationID, overFetch)
		if err == nil {
			i := 0
			maxDistance := envFloat("RAG_MAX_DISTANCE", 0.4)
			if maxDistance <= 0 {
				maxDistance = math.Inf(1)
			}
			vectorRank := 0
			for rows.Next() {
				row, distance, err := scanVectorRow(rows)
				if err != nil {
					continue
				}
				i++
				if distance > maxDistance {
					continue
				}
				vectorRank++
				union[row.ID] = &cand{id: row.ID, distance: distance, vectorRank: vectorRank, item: row}
			}
			rows.Close()
			_ = i
		}
	}
	kw, err := pool.Query(ctx, `SELECT id, chunk_text, parent_text, message_id, conversation_id, role, importance, created_at
		FROM rag_items WHERE conversation_id=$1 AND (chunk_text % $2 OR word_similarity($2, chunk_text) > 0.2 OR chunk_text ILIKE $3)
		ORDER BY word_similarity($2, chunk_text) DESC LIMIT $4`, conversationID, query, "%"+escapeLike(query)+"%", overFetch)
	if err == nil {
		rank := 0
		for kw.Next() {
			row, err := scanItemRow(kw)
			if err != nil {
				continue
			}
			rank++
			if current, ok := union[row.ID]; ok {
				current.keyword = rank
			} else {
				union[row.ID] = &cand{id: row.ID, keyword: rank, item: row}
			}
		}
		kw.Close()
	}
	type ranked struct {
		cand
		score float64
	}
	maximum := 1.0 / 61.0
	var list []ranked
	for _, c := range union {
		score := 0.0
		if c.vectorRank > 0 {
			score += 0.7 / float64(60+c.vectorRank)
		}
		if c.keyword > 0 {
			score += 0.3 / float64(60+c.keyword)
		}
		list = append(list, ranked{cand: *c, score: score / maximum})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].score > list[j].score })
	embeddings := map[string][]float32{}
	if len(list) > 0 {
		ids := make([]any, len(list))
		for i := range list {
			ids[i] = list[i].id
		}
		ph := make([]string, len(ids))
		for i := range ids {
			ph[i] = fmt.Sprintf("$%d", i+1)
		}
		erows, err := pool.Query(ctx, `SELECT id, embedding::text FROM rag_items WHERE id IN (`+strings.Join(ph, ",")+`) AND embedding IS NOT NULL`, ids...)
		if err == nil {
			for erows.Next() {
				var id, text string
				if err := erows.Scan(&id, &text); err == nil {
					embeddings[id] = parseVector(text)
				}
			}
			erows.Close()
		}
	}
	parent := make([]int, len(list))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		if parent[i] != i {
			parent[i] = find(parent[i])
		}
		return parent[i]
	}
	for i := 0; i < len(list); i++ {
		for j := 0; j < i; j++ {
			a := embeddings[list[i].id]
			b := embeddings[list[j].id]
			if len(a) > 0 && len(a) == len(b) && cosine(a, b) >= 0.95 && jaccard(list[i].item.Chunk, list[j].item.Chunk) >= 0.85 {
				parent[find(i)] = find(j)
			}
		}
	}
	groups := map[int][]int{}
	for i := range list {
		g := find(i)
		groups[g] = append(groups[g], i)
	}
	var deduped []ranked
	for _, group := range groups {
		best := group[0]
		maxScore := list[group[0]].score
		for _, idx := range group[1:] {
			if preferred(list[idx].item, list[best].item) {
				best = idx
			}
			if list[idx].score > maxScore {
				maxScore = list[idx].score
			}
		}
		item := list[best]
		item.score = maxScore
		deduped = append(deduped, item)
	}
	sort.Slice(deduped, func(i, j int) bool { return deduped[i].score > deduped[j].score })
	seen := map[string]struct{}{}
	var hits []Hit
	for _, item := range deduped {
		text := strings.Join(strings.Fields(recall(item.item)), " ")
		if _, ok := seen[text]; ok {
			continue
		}
		seen[text] = struct{}{}
		hits = append(hits, Hit{MessageID: item.item.MessageID, ConversationID: item.item.ConversationID, Role: item.item.Role, Text: recall(item.item), Importance: item.item.Importance, Score: item.score})
		if len(hits) >= topK {
			break
		}
	}
	if len(hits) > 0 {
		ids := make([]any, len(hits))
		for i, hit := range hits {
			_ = pool.QueryRow(ctx, `SELECT id FROM rag_items WHERE message_id=$1 AND conversation_id=$2 AND chunk_text=$3 LIMIT 1`, hit.MessageID, hit.ConversationID, "").Scan(new(string))
			ids[i] = hit.MessageID
		}
		now := idgen.NowISO()
		for _, hit := range hits {
			_, _ = pool.Exec(ctx, `UPDATE rag_items SET hit_count=hit_count+1, last_hit_at=$1 WHERE message_id=$2 AND conversation_id=$3 AND (parent_text=$4 OR chunk_text=$4)`, now, hit.MessageID, hit.ConversationID, hit.Text)
			if readEnabled() {
				_, _ = pool.Exec(ctx, `UPDATE rag_items SET last_injected_at=$1 WHERE message_id=$2 AND conversation_id=$3 AND (parent_text=$4 OR chunk_text=$4)`, now, hit.MessageID, hit.ConversationID, hit.Text)
			}
		}
	}
	if shadowEnabled() {
		log.Printf("[rag] shadow retrieve user=%s conversation=%s final=%d", userID, conversationID, len(hits))
	}
	return hits, nil
}

func FormatHits(hits []Hit) string {
	if len(hits) == 0 || !readEnabled() {
		return ""
	}
	limit := envInt("RAG_CONTENT_MAX_CHARS", 1200)
	if limit <= 0 {
		limit = 1200
	}
	var blocks []string
	for i, hit := range hits {
		text := visibility.StripThinkBlocks(hit.Text)
		if text == "" {
			continue
		}
		if len([]rune(text)) > limit {
			text = string([]rune(text)[:limit]) + "…"
		}
		role := "助手"
		if hit.Role == "user" {
			role = "用户"
		}
		blocks = append(blocks, fmt.Sprintf("[%d] (%s, 相关度=%.2f) %s", i+1, role, hit.Score, text))
	}
	if len(blocks) == 0 {
		return ""
	}
	return "可能相关的历史记忆（仅在相关时使用）：\n" + strings.Join(blocks, "\n")
}

type itemRow struct {
	ID, Chunk, Parent, MessageID, ConversationID, Role, CreatedAt string
	Importance                                                     float64
}

func recall(item itemRow) string {
	if strings.TrimSpace(item.Parent) != "" {
		return strings.TrimSpace(item.Parent)
	}
	return item.Chunk
}

func preferred(a, b itemRow) bool {
	if a.CreatedAt != b.CreatedAt {
		return a.CreatedAt > b.CreatedAt
	}
	if a.Importance != b.Importance {
		return a.Importance > b.Importance
	}
	return a.Role == "user"
}

type rowScanner interface{ Scan(dest ...any) error }

func scanItemRow(scanner rowScanner) (itemRow, error) {
	var row itemRow
	var parent *string
	err := scanner.Scan(&row.ID, &row.Chunk, &parent, &row.MessageID, &row.ConversationID, &row.Role, &row.Importance, &row.CreatedAt)
	if parent != nil {
		row.Parent = *parent
	}
	return row, err
}

func scanVectorRow(scanner rowScanner) (itemRow, float64, error) {
	var row itemRow
	var parent *string
	var distance float64
	err := scanner.Scan(&row.ID, &row.Chunk, &parent, &row.MessageID, &row.ConversationID, &row.Role, &row.Importance, &row.CreatedAt, &distance)
	if parent != nil {
		row.Parent = *parent
	}
	return row, distance, err
}

func cosine(a, b []float32) float64 {
	var dot, aa, bb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		aa += float64(a[i]) * float64(a[i])
		bb += float64(b[i]) * float64(b[i])
	}
	if aa == 0 || bb == 0 {
		return 0
	}
	return dot / (math.Sqrt(aa) * math.Sqrt(bb))
}

func jaccard(a, b string) float64 {
	tokens := func(text string) map[string]struct{} {
		normalized := strings.ToLower(strings.Join(strings.Fields(text), " "))
		values := map[string]struct{}{}
		for _, word := range wordRE.FindAllString(normalized, -1) {
			values["w:"+word] = struct{}{}
		}
		compact := strings.ReplaceAll(normalized, " ", "")
		rs := []rune(compact)
		for i := 0; i+2 < len(rs); i++ {
			values["t:"+string(rs[i:i+3])] = struct{}{}
		}
		return values
	}
	left, right := tokens(a), tokens(b)
	shared := 0
	for value := range left {
		if _, ok := right[value]; ok {
			shared++
		}
	}
	den := len(left) + len(right) - shared
	if den == 0 {
		return 0
	}
	return float64(shared) / float64(den)
}

func embeddingConfigured() bool {
	return os.Getenv("EMBEDDING_API_KEY") != "" && (os.Getenv("EMBEDDING_MODEL") != "" || true) && envInt("EMBEDDING_DIMENSIONS", 1536) > 0 && os.Getenv("EMBEDDING_API_KEY") != "" && envModel() != ""
}

func envModel() string {
	if v := os.Getenv("EMBEDDING_MODEL"); v != "" {
		return v
	}
	return "text-embedding-3-small"
}

func embedText(ctx context.Context, text string) ([]float32, error) {
	if os.Getenv("EMBEDDING_API_KEY") == "" {
		return nil, nil
	}
	base := os.Getenv("EMBEDDING_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	base = strings.TrimRight(base, "/") + "/embeddings"
	body, _ := json.Marshal(map[string]any{"model": envModel(), "input": text})
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, base, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+os.Getenv("EMBEDDING_API_KEY"))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("embedding status %d", res.StatusCode)
	}
	var payload struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || len(payload.Data) == 0 {
		return nil, err
	}
	vec := make([]float32, len(payload.Data[0].Embedding))
	for i, n := range payload.Data[0].Embedding {
		vec[i] = float32(n)
	}
	want := envInt("EMBEDDING_DIMENSIONS", 1536)
	if want > 0 && len(vec) != want {
		return nil, fmt.Errorf("embedding dim %d", len(vec))
	}
	return vec, nil
}

func vectorLiteral(v []float32) string {
	parts := make([]string, len(v))
	for i, n := range v {
		parts[i] = strconv.FormatFloat(float64(n), 'f', -1, 32)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func parseVector(text string) []float32 {
	text = strings.Trim(text, "[]")
	if text == "" {
		return nil
	}
	parts := strings.Split(text, ",")
	out := make([]float32, 0, len(parts))
	for _, part := range parts {
		n, err := strconv.ParseFloat(strings.TrimSpace(part), 32)
		if err != nil {
			return nil
		}
		out = append(out, float32(n))
	}
	return out
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

func ContextForPrompt(ctx context.Context, pool *pgxpool.Pool, userID, query, conversationID string) string {
	hits, err := Retrieve(ctx, pool, userID, query, conversationID)
	if err != nil || !readEnabled() {
		return ""
	}
	return FormatHits(hits)
}

var _ = pgx.ErrNoRows
