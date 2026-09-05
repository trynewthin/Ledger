package main

import (
	"context"
	"ledger/internal/ledger"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func main() {
	path := env("LEDGER_DB", "data/ledger.db")
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		log.Fatal(e)
	}
	s, e := ledger.Open(path)
	if e != nil {
		log.Fatal(e)
	}
	defer s.DB.Close()
	password := os.Getenv("LEDGER_ADMIN_PASSWORD")
	if p := os.Getenv("LEDGER_ADMIN_PASSWORD_FILE"); p != "" {
		b, e := os.ReadFile(p)
		if e != nil {
			log.Fatal(e)
		}
		password = strings.TrimSpace(string(b))
	}
	if e = s.Bootstrap(os.Getenv("LEDGER_ADMIN_USER"), password); e != nil {
		log.Fatal(e)
	}
	origin := os.Getenv("LEDGER_ORIGIN")
	if e = ledger.ValidateOrigin(origin); e != nil {
		log.Fatal(e)
	}
	app := ledger.NewServer(s, origin, env("LEDGER_WEB", "web/dist"))
	srv := &http.Server{Addr: env("LEDGER_ADDR", ":8080"), Handler: app.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 120 * time.Second, MaxHeaderBytes: 32 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	log.Printf("Ledger listening on %s", srv.Addr)
	if e = srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}
