package app

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
	_ "time/tzdata" // コンテナにタイムゾーンDBが無くても Asia/Tokyo を使う
)

// Config は環境変数から読み込む設定。
type Config struct {
	DatabaseURL    string
	Listen         string
	Secret         []byte // トークン導出・現地コード用（32byte以上推奨）
	PublicBaseURL  string // 例 https://festival.example.com
	TrustProxy     bool   // X-Forwarded-For を信頼するか（リバースプロキシ配下のみ true）
	SessionTTL     time.Duration
	CookieSecure   bool
	AllowedOrigins []string
	Wallet         WalletConfig
	BootstrapAdmin string // 初回起動時に作る管理者 login_id
	BootstrapPass  string
}

type WalletConfig struct {
	PassTypeID string
	TeamID     string
	OrgName    string
	CertPath   string // PEM: パス証明書
	KeyPath    string // PEM: 秘密鍵
	WWDRPath   string // PEM: Apple WWDR 中間証明書
	VenueName  string
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func LoadConfig() Config {
	ttl, err := time.ParseDuration(env("SESSION_TTL", "18h"))
	if err != nil {
		ttl = 18 * time.Hour
	}
	var origins []string
	for _, o := range strings.Split(env("ALLOWED_ORIGINS", ""), ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins = append(origins, o)
		}
	}
	return Config{
		DatabaseURL:    env("DATABASE_URL", "postgres://postgres@127.0.0.1:5432/gakusai?sslmode=disable"),
		Listen:         env("LISTEN_ADDR", ":8080"),
		Secret:         []byte(env("APP_SECRET", "")),
		PublicBaseURL:  strings.TrimRight(env("PUBLIC_BASE_URL", "http://localhost:3000"), "/"),
		TrustProxy:     env("TRUST_PROXY", "false") == "true",
		SessionTTL:     ttl,
		CookieSecure:   env("COOKIE_SECURE", "false") == "true",
		AllowedOrigins: origins,
		BootstrapAdmin: env("BOOTSTRAP_ADMIN_LOGIN", ""),
		BootstrapPass:  env("BOOTSTRAP_ADMIN_PASSWORD", ""),
		Wallet: WalletConfig{
			PassTypeID: env("WALLET_PASS_TYPE_ID", ""),
			TeamID:     env("WALLET_TEAM_ID", ""),
			OrgName:    env("WALLET_ORG_NAME", "天文学研究部"),
			CertPath:   env("WALLET_CERT_PATH", ""),
			KeyPath:    env("WALLET_KEY_PATH", ""),
			WWDRPath:   env("WALLET_WWDR_PATH", ""),
			VenueName:  env("WALLET_VENUE_NAME", "プラネタリウム会場"),
		},
	}
}

var jst = loadJST()

func loadJST() *time.Location {
	loc, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		return time.FixedZone("JST", 9*3600)
	}
	return loc
}

// App はAPIサーバー本体。
type App struct {
	DB   *sql.DB
	Cfg  Config
	Hub  *Hub
	Now  func() time.Time
	rate *rateLimiter
}

func New(db *sql.DB, cfg Config) *App {
	return &App{
		DB:   db,
		Cfg:  cfg,
		Hub:  NewHub(),
		Now:  time.Now,
		rate: newRateLimiter(),
	}
}

// today は Asia/Tokyo 基準の営業日（YYYY-MM-DD）。
func (a *App) today() string { return a.Now().In(jst).Format("2006-01-02") }

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	a.routes(mux)
	var h http.Handler = mux
	h = a.csrfMiddleware(h)
	h = a.visitorCookieMiddleware(h)
	h = a.corsMiddleware(h)
	h = securityHeaders(h)
	h = a.logMiddleware(h)
	h = recoverMiddleware(h)
	return h
}

// Bootstrap は初回起動時の管理者作成など。
func (a *App) Bootstrap(ctx context.Context) error {
	if a.Cfg.BootstrapAdmin == "" || a.Cfg.BootstrapPass == "" {
		return nil
	}
	var n int
	if err := a.DB.QueryRowContext(ctx, `SELECT count(*) FROM members`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	hash, err := hashPassword(a.Cfg.BootstrapPass)
	if err != nil {
		return err
	}
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var id string
		if err := tx.QueryRowContext(ctx, `INSERT INTO members(name, login_id, password_hash) VALUES ('管理者',$1,$2) RETURNING id`,
			a.Cfg.BootstrapAdmin, hash).Scan(&id); err != nil {
			return err
		}
		for _, role := range []string{"admin", "treasurer", "cashier", "kitchen", "reception", "member"} {
			if _, err := tx.ExecContext(ctx, `INSERT INTO member_roles(member_id, role) VALUES ($1,$2)`, id, role); err != nil {
				return err
			}
		}
		slog.Info("bootstrap admin created", "login", a.Cfg.BootstrapAdmin)
		return nil
	})
}
