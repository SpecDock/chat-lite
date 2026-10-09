package httpapi

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

type eventClient struct {
	userID string
	ch     chan []byte
}

var (
	eventMu      sync.Mutex
	eventClients = map[string]map[*eventClient]struct{}{}
)

func emitToUser(userID, event string, data map[string]any) {
	if data == nil {
		data = map[string]any{}
	}
	body, err := json.Marshal(data)
	if err != nil {
		return
	}
	payload := []byte("event: " + event + "\ndata: " + string(body) + "\n\n")
	eventMu.Lock()
	set := eventClients[userID]
	clients := make([]*eventClient, 0, len(set))
	for client := range set {
		clients = append(clients, client)
	}
	eventMu.Unlock()
	for _, client := range clients {
		select {
		case client.ch <- payload:
		default:
		}
	}
}

func (a *App) registerEvents(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/events", a.withAuth(a.events))
}

func (a *App) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	user := authFrom(r)
	client := &eventClient{userID: user.UserID, ch: make(chan []byte, 16)}
	eventMu.Lock()
	set := eventClients[user.UserID]
	if set == nil {
		set = map[*eventClient]struct{}{}
		eventClients[user.UserID] = set
	}
	set[client] = struct{}{}
	eventMu.Unlock()
	defer func() {
		eventMu.Lock()
		delete(eventClients[user.UserID], client)
		if len(eventClients[user.UserID]) == 0 {
			delete(eventClients, user.UserID)
		}
		eventMu.Unlock()
	}()
	_, _ = w.Write([]byte("event: connected\ndata: {\"ok\":true}\n\n"))
	flusher.Flush()
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case payload := <-client.ch:
			_, _ = w.Write(payload)
			flusher.Flush()
		case <-ticker.C:
			_, _ = w.Write([]byte(": ping\n\n"))
			flusher.Flush()
		}
	}
}
