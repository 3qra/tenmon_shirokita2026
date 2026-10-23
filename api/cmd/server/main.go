package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/3qra/tenmon_shirokita2026/api/internal/app"
	"github.com/3qra/tenmon_shirokita2026/api/migrations"
	_ "github.com/lib/pq"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg := app.LoadConfig()
	if len(cfg.Secret) < 32 {
		slog.Error("APP_SECRET を32文字以上で設定してください")
		os.Exit(1)
	}
	db, err := sql.Open("postgres", cfg.DatabaseURL)
	if err != nil {
		slog.Error("db open", "err", err)
		os.Exit(1)
	}
	db.SetMaxOpenConns(30)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(30 * time.Minute)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// DBの起動待ち
	for i := 0; ; i++ {
		if err := db.PingContext(ctx); err == nil {
			break
		} else if i > 60 {
			slog.Error("db not reachable", "err", err)
			os.Exit(1)
		}
		time.Sleep(time.Second)
	}
	if err := app.Migrate(ctx, db, migrations.FS); err != nil {
		slog.Error("migrate", "err", err)
		os.Exit(1)
	}
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		slog.Info("migrations done")
		return
	}
	a := app.New(db, cfg)
	if err := a.Bootstrap(ctx); err != nil {
		slog.Error("bootstrap", "err", err)
		os.Exit(1)
	}
	if len(os.Args) > 1 && os.Args[1] == "seed" {
		if err := a.SeedDemo(ctx); err != nil {
			slog.Error("seed", "err", err)
			os.Exit(1)
		}
		slog.Info("seed done")
		return
	}
	go a.Listen(ctx)
	go a.RunJobs(ctx)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           a.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	slog.Info("listening", "addr", cfg.Listen)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server", "err", err)
		os.Exit(1)
	}
}
