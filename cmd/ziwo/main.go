// Command ziwo serves autobiographical memories for AIs over MCP.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/nilzx/ziwo/internal/embed"
	"github.com/nilzx/ziwo/internal/host"
	"github.com/nilzx/ziwo/internal/memory"
	"github.com/nilzx/ziwo/internal/store"
)

var version = "dev"

const usage = `ziwo keeps autobiographical memories for AIs and serves them over MCP.

Usage:
  ziwo [serve] [flags]     serve every memory in the data directory
  ziwo new <name>          create a memory and print its access token
  ziwo token <name>        replace a memory's access token and print the new one
  ziwo list                list the memories in the data directory
  ziwo rebuild <name>      rebuild a memory's derived tables from its event log
  ziwo check <name>        look a memory over for problems, without showing what it says
  ziwo export <name>       write a memory to a sealed file, as a backup
  ziwo import <name> <file>   bring an export back as a new memory

Each memory is one file, <name>.ziwo, served at /<name>/mcp.
Run "ziwo <command> -h" for the flags of a command.
`

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return // the flag package has printed the usage that was asked for
		}
		fmt.Fprintln(os.Stderr, "ziwo:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	cmd := "serve"
	switch {
	case len(args) > 0 && !strings.HasPrefix(args[0], "-"):
		cmd, args = args[0], args[1:]
	case len(args) == 1 && (args[0] == "-h" || args[0] == "-help" || args[0] == "--help"):
		cmd = "help"
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch cmd {
	case "serve":
		return serve(ctx, args)
	case "new":
		return newMemory(ctx, args, out)
	case "token":
		return newToken(ctx, args, out)
	case "list":
		return list(ctx, args, out)
	case "rebuild":
		return rebuild(ctx, args, out)
	case "check":
		return check(ctx, args, out)
	case "export":
		return export(ctx, args, out)
	case "import":
		return importMemory(ctx, args, out)
	case "help":
		fmt.Fprint(out, usage)
		return nil
	default:
		return fmt.Errorf("unknown command %q\n\n%s", cmd, usage)
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func newFlags(cmd string) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet("ziwo "+cmd, flag.ContinueOnError)
	dir := fs.String("dir", env("ZIWO_DIR", "."), "directory that holds the memory files")
	return fs, dir
}

// paramFlags registers the flags that say how memories strengthen and fade.
// Changing any of them replays the event log, so the whole memory follows
// the new values.
func paramFlags(fs *flag.FlagSet) *store.Params {
	p := store.DefaultParams()
	fs.Float64Var(&p.BaseStrength, "strength", p.BaseStrength, "strength of an ordinary memory, counted in memories: it fades once about 1.2 times this many newer memories have been written without it coming to mind")
	fs.Float64Var(&p.RecallBoost, "recall-boost", p.RecallBoost, "how much reading a memory in full can strengthen it: strength is multiplied by up to 1 plus this")
	fs.Float64Var(&p.FadeBelow, "fade-below", p.FadeBelow, "retention below which only a memory's gist stays findable")
	fs.Float64Var(&p.ArchiveBelow, "archive-below", p.ArchiveBelow, "retention below which a memory leaves ordinary recall")
	fs.Float64Var(&p.CoreImportance, "core-importance", p.CoreImportance, "importance at or above which a memory never fades")
	fs.Float64Var(&p.CoreFeeling, "core-feeling", p.CoreFeeling, "feeling intensity at or above which a memory never fades")
	return &p
}

// positionals parses flags that may come before, between or after the
// positional arguments, and returns those.
func positionals(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			return pos, nil
		}
		pos, args = append(pos, fs.Arg(0)), fs.Args()[1:]
	}
}

// parseName parses flags that may come before or after one positional name.
func parseName(fs *flag.FlagSet, args []string) (string, error) {
	pos, err := positionals(fs, args)
	switch {
	case err != nil:
		return "", err
	case len(pos) == 0:
		return "", fmt.Errorf("%s: give the memory's name", fs.Name())
	case len(pos) > 1:
		return "", fmt.Errorf("%s: unexpected argument %q", fs.Name(), pos[1])
	}
	return pos[0], nil
}

func newMemory(ctx context.Context, args []string, out io.Writer) error {
	fs, dir := newFlags("new")
	name, err := parseName(fs, args)
	if err != nil {
		return err
	}
	token, err := host.Create(ctx, *dir, name)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "created   %s\nendpoint  /%s/mcp\ntoken     %s\n\nThe token is shown this once. Only its hash is stored.\n",
		host.Path(*dir, name), name, token)
	return nil
}

func newToken(ctx context.Context, args []string, out io.Writer) error {
	fs, dir := newFlags("token")
	name, err := parseName(fs, args)
	if err != nil {
		return err
	}
	token, err := host.NewToken(ctx, *dir, name)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "endpoint  /%s/mcp\ntoken     %s\n\nThe old token no longer works. The new one is shown this once.\n", name, token)
	return nil
}

func list(ctx context.Context, args []string, out io.Writer) error {
	fs, dir := newFlags("list")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("ziwo list: unexpected argument %q", fs.Arg(0))
	}
	names, err := host.Names(*dir)
	if err != nil {
		return err
	}
	if len(names) == 0 {
		fmt.Fprintf(out, "no memories in %s; create one with: ziwo new <name>\n", *dir)
		return nil
	}
	return writeList(ctx, out, *dir, names)
}

func writeList(ctx context.Context, out io.Writer, dir string, names []string) error {
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tMEMORIES\tEVENTS\tLAST EVENT\tTOKEN")
	for _, name := range names {
		st, err := host.Describe(ctx, dir, name)
		if err != nil {
			fmt.Fprintf(w, "%s\t\t\t\t%v\n", name, err)
			continue
		}
		last, token := "never", "not set"
		if !st.LastEventAt.IsZero() {
			last = st.LastEventAt.Format("2006-01-02 15:04Z")
		}
		if st.HasToken {
			token = "set"
		}
		fmt.Fprintf(w, "%s\t%d\t%d\t%s\t%s\n", name, st.Memories, st.Events, last, token)
	}
	return w.Flush()
}

func rebuild(ctx context.Context, args []string, out io.Writer) error {
	fs, dir := newFlags("rebuild")
	params := paramFlags(fs)
	name, err := parseName(fs, args)
	if err != nil {
		return err
	}
	memories, events, err := host.Rebuild(ctx, *dir, name, *params)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "rebuilt %d memories from %d events\n", memories, events)
	return nil
}

func check(ctx context.Context, args []string, out io.Writer) error {
	fs, dir := newFlags("check")
	name, err := parseName(fs, args)
	if err != nil {
		return err
	}
	report, err := host.Check(ctx, *dir, name)
	if err != nil {
		return err
	}
	fmt.Fprint(out, report)
	if n := report.Count(store.LevelProblem); n > 0 {
		return fmt.Errorf("%d problem(s) found in %q", n, name)
	}
	return nil
}

// exportKey reads the passphrase that seals exports. It comes from the
// environment so that it is not left in the shell history.
func exportKey() (string, error) {
	key := os.Getenv("ZIWO_EXPORT_KEY")
	if key == "" {
		return "", errors.New("set ZIWO_EXPORT_KEY to the passphrase for the export; an export is never written in the clear")
	}
	return key, nil
}

func export(ctx context.Context, args []string, out io.Writer) error {
	fs, dir := newFlags("export")
	file := fs.String("o", "", "file to write; default <name>-<date>.ziwo-export in the current directory")
	name, err := parseName(fs, args)
	if err != nil {
		return err
	}
	key, err := exportKey()
	if err != nil {
		return err
	}
	if *file == "" {
		*file = name + "-" + time.Now().Format("20060102-150405") + ".ziwo-export"
	}
	if _, err := os.Stat(*file); err == nil {
		return fmt.Errorf("%s already exists", *file)
	}
	events, err := host.Export(ctx, *dir, name, *file, key)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "exported %d events of %q to %s\nIt opens only with the passphrase in ZIWO_EXPORT_KEY. Keep both.\n", events, name, *file)
	return nil
}

func importMemory(ctx context.Context, args []string, out io.Writer) error {
	fs, dir := newFlags("import")
	pos, err := positionals(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 2 {
		return errors.New("ziwo import: give the new memory's name and the export file")
	}
	name, file := pos[0], pos[1]
	key, err := exportKey()
	if err != nil {
		return err
	}
	st, err := host.Import(ctx, *dir, name, file, key)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "brought back %d memories from %d events, as exported on %s\ncreated   %s\nendpoint  /%s/mcp\n",
		st.Memories, st.Events, st.ExportedAt.Format("2006-01-02 15:04Z"), host.Path(*dir, name), name)
	if st.HasToken {
		fmt.Fprintln(out, "It answers to the token it had when it was exported.")
	} else {
		fmt.Fprintf(out, "It has no token yet: run ziwo token %s\n", name)
	}
	return nil
}

func serve(ctx context.Context, args []string) error {
	fs, dir := newFlags("serve")
	var (
		addr          = fs.String("addr", env("ZIWO_ADDR", "127.0.0.1:8377"), "address to listen on")
		noAuth        = fs.Bool("no-auth", false, "serve without checking tokens; only allowed on a loopback address")
		behindProxy   = fs.Bool("behind-proxy", false, "accept non-localhost Host headers on a loopback listener (set when a reverse proxy on this machine terminates TLS)")
		embedURL      = fs.String("embed-url", env("ZIWO_EMBED_URL", ""), "OpenAI-compatible embeddings endpoint, e.g. http://127.0.0.1:8080/v1/embeddings; empty means keyword search only")
		embedModel    = fs.String("embed-model", env("ZIWO_EMBED_MODEL", ""), "embedding model name")
		queryPrefix   = fs.String("embed-query-prefix", env("ZIWO_EMBED_QUERY_PREFIX", ""), "text the model expects before a query")
		passagePrefix = fs.String("embed-passage-prefix", env("ZIWO_EMBED_PASSAGE_PREFIX", ""), "text the model expects before a stored passage")
		minSimilarity = fs.Float64("min-similarity", 0.35, "drop matches by meaning below this cosine similarity; depends on the embedding model")
	)
	params := paramFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("ziwo serve: unexpected argument %q", fs.Arg(0))
	}
	if err := params.Validate(); err != nil {
		return err
	}
	if *noAuth && !loopback(*addr) {
		return errors.New("-no-auth is only allowed when -addr is a loopback address")
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	var emb embed.Embedder
	search := "keyword"
	if *embedURL != "" {
		if *embedModel == "" {
			return errors.New("-embed-model is required with -embed-url")
		}
		emb = &embed.HTTP{
			URL: *embedURL, ModelName: *embedModel, APIKey: os.Getenv("ZIWO_EMBED_KEY"),
			QueryPrefix: *queryPrefix, PassagePrefix: *passagePrefix,
		}
		search = "keyword + " + *embedModel
	}

	names, err := host.Names(*dir)
	if err != nil {
		return err
	}
	h := host.New(host.Config{
		Dir: *dir, Params: *params, Embedder: emb,
		Memory: memory.Config{MinSimilarity: float32(*minSimilarity)},
		NoAuth: *noAuth, BehindProxy: *behindProxy, Version: version, Logger: log,
	})
	defer h.Close()

	// Open everything now so that a memory that cannot be served is reported
	// at startup, not on its first request. The others are served regardless.
	for _, name := range names {
		tiers, err := h.Open(ctx, name)
		if err != nil {
			log.Error("memory cannot be served", "memory", name, "err", err)
			continue
		}
		log.Info("memory ready", "memory", name, "endpoint", "/"+name+"/mcp", "memories", tiers.Total(),
			"core", tiers.Core, "active", tiers.Active, "faded", tiers.Faded, "archived", tiers.Archived)
	}
	if len(names) == 0 {
		log.Warn("no memories yet; create one with: ziwo new <name>", "dir", *dir)
	}

	httpSrv := &http.Server{Addr: *addr, Handler: h.Handler(), ReadHeaderTimeout: 10 * time.Second}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	log.Info("ziwo listening", "addr", ln.Addr().String(), "dir", *dir, "search", search, "auth", !*noAuth)

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

func loopback(addr string) bool {
	h, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
