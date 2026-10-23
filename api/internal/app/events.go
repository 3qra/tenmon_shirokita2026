package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/lib/pq"
)

// Hub はSSE購読者に「どのトピックが変わったか」だけを配信する。
// 受信側は通知を受けたら最新状態をAPIで取り直す（通知＝業務成功ではない）。
type Hub struct {
	mu   sync.Mutex
	subs map[chan string]struct{}
}

func NewHub() *Hub { return &Hub{subs: map[chan string]struct{}{}} }

func (h *Hub) subscribe() chan string {
	ch := make(chan string, 64)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *Hub) unsubscribe(ch chan string) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *Hub) broadcast(topic string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- topic:
		default: // 遅い購読者は取りこぼしてよい（再取得で整合）
		}
	}
}

// publish はトランザクション内で呼ぶ。コミットされたときだけ通知が届く。
func publish(ctx context.Context, q queryer, topics ...string) error {
	for _, t := range topics {
		if _, err := q.ExecContext(ctx, `SELECT pg_notify('gs_events', $1)`, t); err != nil {
			return err
		}
	}
	return nil
}

// Listen はPostgreSQLの通知を受けてHubへ流す。複数APIインスタンスでも整合する。
func (a *App) Listen(ctx context.Context) {
	l := pq.NewListener(a.Cfg.DatabaseURL, time.Second, 30*time.Second, func(ev pq.ListenerEventType, err error) {
		if err != nil {
			slog.Warn("listener", "err", err)
		}
		if ev == pq.ListenerEventReconnected {
			a.Hub.broadcast("resync")
		}
	})
	if err := l.Listen("gs_events"); err != nil {
		slog.Error("listen failed", "err", err)
		return
	}
	defer l.Close()
	for {
		select {
		case <-ctx.Done():
			return
		case n := <-l.Notify:
			if n == nil {
				a.Hub.broadcast("resync")
				continue
			}
			a.Hub.broadcast(n.Extra)
		case <-time.After(60 * time.Second):
			go l.Ping()
		}
	}
}

// handleEvents: GET /api/v1/events?topics=orders,screenings
// SSE。接続直後に "hello" を送り、15秒ごとに ping。切断されたらクライアントは再接続＋全件再取得する。
func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) error {
	flusher, ok := w.(http.Flusher)
	if !ok {
		if u, ok2 := w.(interface{ Unwrap() http.ResponseWriter }); ok2 {
			flusher, ok = u.Unwrap().(http.Flusher)
		}
	}
	if !ok {
		return errf(500, "no_stream", "ストリーミングに対応していません")
	}
	want := map[string]bool{}
	for _, t := range strings.Split(r.URL.Query().Get("topics"), ",") {
		if t = strings.TrimSpace(t); t != "" {
			want[t] = true
		}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	fmt.Fprintf(w, "event: hello\ndata: %d\n\n", a.Now().Unix())
	flusher.Flush()

	ch := a.Hub.subscribe()
	defer a.Hub.unsubscribe(ch)
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return nil
		case <-ping.C:
			fmt.Fprintf(w, "event: ping\ndata: %d\n\n", a.Now().Unix())
			flusher.Flush()
		case topic := <-ch:
			base := topic
			if i := strings.Index(topic, ":"); i > 0 {
				base = topic[:i]
			}
			if len(want) > 0 && !want[base] && !want[topic] && topic != "resync" {
				continue
			}
			fmt.Fprintf(w, "event: change\ndata: %s\n\n", topic)
			flusher.Flush()
		}
	}
}
