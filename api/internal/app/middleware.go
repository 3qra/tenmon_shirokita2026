package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"time"
)

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// redactPath は秘密トークンを含むパスをログに残さない。
func redactPath(p string) string {
	for _, prefix := range []string{"/api/v1/public/orders/by-token/", "/api/v1/public/reservations/by-token/",
		"/api/v1/public/coupons/by-token/", "/api/v1/staff/coupons/verify/"} {
		if strings.HasPrefix(p, prefix) {
			return prefix + "***"
		}
	}
	return p
}

func (a *App) logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		if r.URL.Path == "/healthz" {
			return
		}
		slog.Info("http", "method", r.Method, "path", redactPath(r.URL.Path), "status", rec.status,
			"ms", time.Since(start).Milliseconds())
	})
}

func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				if p == http.ErrAbortHandler {
					panic(p)
				}
				slog.Error("panic", "panic", p, "stack", string(debug.Stack()))
				writeJSON(w, 500, map[string]any{"error": errf(500, "internal", "サーバーでエラーが発生しました")})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func (a *App) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && slices.Contains(a.Cfg.AllowedOrigins, origin) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-Requested-With, X-Client-Id, X-Client-Kind")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			h.Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// visitorCookieMiddleware は来場者向けAPIの閲覧時に識別Cookieを発行しておく。
// 注文・予約の初回送信より前に識別が決まるため、二重送信の判定（冪等性キー）が安定する。
func (a *App) visitorCookieMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v1/public/") &&
			r.Header.Get("X-Client-Id") == "" && len(cookieValue(r, clientCookie)) < 16 {
			http.SetCookie(w, &http.Cookie{Name: clientCookie, Value: randomToken(), Path: "/", HttpOnly: true,
				Secure: a.Cfg.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: 60 * 60 * 24 * 30})
		}
		next.ServeHTTP(w, r)
	})
}

// csrfMiddleware: Cookie認証で状態を変える要求には独自ヘッダを必須にする。
// 独自ヘッダは他サイトのフォーム送信では付与できないため、CSRFを防げる。
func (a *App) csrfMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") &&
				r.Header.Get("X-Requested-With") == "" {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": errf(403, "csrf", "不正なリクエストです")})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------
// 認証済みスタッフ
// ---------------------------------------------------------------

type Staff struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Login string   `json:"login_id"`
	Roles []string `json:"roles"`
}

func (s *Staff) Has(roles ...string) bool {
	if s == nil {
		return false
	}
	for _, want := range roles {
		if slices.Contains(s.Roles, want) {
			return true
		}
	}
	return false
}

type ctxKey int

const staffKey ctxKey = 1

const sessionCookie = "gs_session"

func sessionTokenFrom(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	if c, err := r.Cookie(sessionCookie); err == nil {
		return c.Value
	}
	return ""
}

func (a *App) loadStaff(ctx context.Context, token string) (*Staff, error) {
	if token == "" {
		return nil, nil
	}
	var s Staff
	var roles []byte
	err := a.DB.QueryRowContext(ctx, `
		UPDATE staff_sessions ss SET last_seen_at = now()
		FROM members m
		WHERE ss.token_hash = $1 AND ss.expires_at > now() AND m.id = ss.member_id AND m.active
		RETURNING m.id, m.name, m.login_id,
		  COALESCE((SELECT json_agg(role ORDER BY role) FROM member_roles WHERE member_id = m.id), '[]')`,
		hashToken("session", token)).Scan(&s.ID, &s.Name, &s.Login, &roles)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Roles = parseStringArray(roles)
	return &s, nil
}

// staffOnly はログイン必須＋いずれかの権限を要求する。roles が空ならログインのみ要求。
func (a *App) staffOnly(roles []string, h func(w http.ResponseWriter, r *http.Request, s *Staff) error) http.Handler {
	return handler(func(w http.ResponseWriter, r *http.Request) error {
		s, err := a.loadStaff(r.Context(), sessionTokenFrom(r))
		if err != nil {
			return err
		}
		if s == nil {
			return errUnauthorized
		}
		if len(roles) > 0 && !s.Has(roles...) {
			return forbidden("この操作の権限がありません")
		}
		return h(w, r.WithContext(context.WithValue(r.Context(), staffKey, s)), s)
	})
}

// staffIdem は認証・権限確認の後に冪等性キーを処理する（未認証要求の記録を残さない）。
func (a *App) staffIdem(scope string, roles []string, h func(w http.ResponseWriter, r *http.Request, s *Staff) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, err := a.loadStaff(r.Context(), sessionTokenFrom(r))
		if err != nil {
			writeError(w, r, err)
			return
		}
		if s == nil {
			writeError(w, r, errUnauthorized)
			return
		}
		if len(roles) > 0 && !s.Has(roles...) {
			writeError(w, r, forbidden("この操作の権限がありません"))
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), staffKey, s))
		a.idempotent(scope, handler(func(w http.ResponseWriter, r *http.Request) error { return h(w, r, s) })).ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------
// 簡易レート制限（プロセス内トークンバケット）
// ---------------------------------------------------------------

type bucket struct {
	tokens float64
	last   time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

func newRateLimiter() *rateLimiter {
	rl := &rateLimiter{buckets: map[string]*bucket{}}
	go func() {
		for range time.Tick(5 * time.Minute) {
			rl.mu.Lock()
			for k, b := range rl.buckets {
				if time.Since(b.last) > 30*time.Minute {
					delete(rl.buckets, k)
				}
			}
			rl.mu.Unlock()
		}
	}()
	return rl
}

// allow は key ごとに perMinute 回/分、最大 burst 回までの要求を許可する。
func (rl *rateLimiter) allow(key string, perMinute float64, burst float64) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	b, ok := rl.buckets[key]
	if !ok {
		b = &bucket{tokens: burst, last: now}
		rl.buckets[key] = b
	}
	b.tokens += now.Sub(b.last).Minutes() * perMinute
	if b.tokens > burst {
		b.tokens = burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (a *App) rateLimit(r *http.Request, kind string, perMinute, burst float64) error {
	key := kind + ":" + clientIP(r, a.Cfg.TrustProxy)
	if !a.rate.allow(key, perMinute, burst) {
		return errf(http.StatusTooManyRequests, "rate_limited", "操作が多すぎます。しばらく待ってからお試しください")
	}
	return nil
}
