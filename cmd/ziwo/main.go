// Command ziwo serves an AI's autobiographical memory over MCP.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nilzx/ziwo/internal/embed"
	"github.com/nilzx/ziwo/internal/memory"
	"github.com/nilzx/ziwo/internal/server"
	"github.com/nilzx/ziwo/internal/store"
)

var version = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "ziwo:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		addr          = flag.String("addr", env("ZIWO_ADDR", "127.0.0.1:8377"), "address to listen on")
		dbPath        = flag.String("db", env("ZIWO_DB", "ziwo.db"), "path of the SQLite database")
		noAuth        = flag.Bool("no-auth", false, "serve without a token; only allowed on a loopback address")
		behindProxy   = flag.Bool("behind-proxy", false, "accept non-localhost Host headers on a loopback listener (set when a reverse proxy on this machine terminates TLS)")
		rebuild       = flag.Bool("rebuild", false, "rebuild the derived tables from the event log, then exit")
		embedURL      = flag.String("embed-url", env("ZIWO_EMBED_URL", ""), "OpenAI-compatible embeddings endpoint, e.g. http://127.0.0.1:8080/v1/embeddings; empty means keyword search only")
		embedModel    = flag.String("embed-model", env("ZIWO_EMBED_MODEL", ""), "embedding model name")
		queryPrefix   = flag.String("embed-query-prefix", env("ZIWO_EMBED_QUERY_PREFIX", ""), "text the model expects before a query")
		passagePrefix = flag.String("embed-passage-prefix", env("ZIWO_EMBED_PASSAGE_PREFIX", ""), "text the model expects before a stored passage")
		minSimilarity = flag.Float64("min-similarity", 0.35, "drop matches by meaning below this cosine similarity; depends on the embedding model")
	)
	flag.Parse()
	if flag.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", flag.Arg(0))
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, *dbPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", *dbPath, err)
	}
	defer st.Close()

	if *rebuild {
		if err := st.Rebuild(ctx); err != nil {
			return err
		}
		memories, events, err := st.Counts(ctx)
		if err != nil {
			return err
		}
		fmt.Printf("rebuilt %d memories from %d events\n", memories, events)
		return nil
	}

	// The token comes from the environment only, so it never shows up in the
	// process list.
	token := os.Getenv("ZIWO_TOKEN")
	switch {
	case token == "" && !*noAuth:
		return errors.New("set ZIWO_TOKEN, or pass -no-auth for local testing")
	case token != "" && *noAuth:
		return errors.New("ZIWO_TOKEN and -no-auth are both set; choose one")
	case *noAuth && !loopback(*addr):
		return errors.New("-no-auth is only allowed when -addr is a loopback address")
	}

	var emb embed.Embedder
	if *embedURL != "" {
		if *embedModel == "" {
			return errors.New("-embed-model is required with -embed-url")
		}
		emb = &embed.HTTP{
			URL: *embedURL, ModelName: *embedModel, APIKey: os.Getenv("ZIWO_EMBED_KEY"),
			QueryPrefix: *queryPrefix, PassagePrefix: *passagePrefix,
		}
	}

	svc, err := memory.New(ctx, st, emb, memory.Config{MinSimilarity: float32(*minSimilarity), Logger: log})
	if err != nil {
		return err
	}
	defer svc.Close()

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           server.New(svc, server.Options{Token: token, BehindProxy: *behindProxy, Version: version, Logger: log}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}

	memories, _, err := st.Counts(ctx)
	if err != nil {
		return err
	}
	search := "keyword"
	if emb != nil {
		search = "keyword + " + emb.Model()
	}
	log.Info("ziwo listening", "addr", ln.Addr().String(), "endpoint", "/mcp", "db", *dbPath,
		"memories", memories, "search", search, "auth", token != "")

	served := make(chan error, 1)
	go func() { served <- httpSrv.Serve(ln) }()
	select {
	case err := <-served:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		// Long-lived event streams do not end on their own.
		httpSrv.Close()
	}
	return nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func loopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
