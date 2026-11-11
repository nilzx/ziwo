// Package host serves several memories from one process.
//
// A memory is one file, <name>.ziwo, in the data directory. It holds its own
// event log and the hash of its own access token, so copying the file moves
// the memory whole. Each memory is served at /<name>/mcp and opens only with
// its own token.
package host

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nilzx/ziwo/internal/embed"
	"github.com/nilzx/ziwo/internal/memory"
	"github.com/nilzx/ziwo/internal/sealed"
	"github.com/nilzx/ziwo/internal/server"
	"github.com/nilzx/ziwo/internal/store"
)

// Ext is the file extension of a memory.
const Ext = ".ziwo"

// ErrUnknown is returned for a name that names no memory.
var ErrUnknown = errors.New("no such memory")

var nameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// ValidName reports whether name can name a memory. Names are lower case so
// they mean the same file on every file system, and plain enough to sit in a
// URL path.
func ValidName(name string) error {
	if !nameRE.MatchString(name) || name == "healthz" {
		return fmt.Errorf("invalid memory name %q: use 1 to 32 lower-case letters, digits, - or _, starting with a letter or digit", name)
	}
	return nil
}

// Path returns the file that holds the memory called name.
func Path(dir, name string) string { return filepath.Join(dir, name+Ext) }

// Names lists the memories in dir, sorted.
func Names(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), Ext)
		if ok && !e.IsDir() && ValidName(name) == nil {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

// Create makes a new, empty memory and returns its access token. The token is
// not stored; only its hash is.
func Create(ctx context.Context, dir, name string) (token string, err error) {
	if err := ValidName(name); err != nil {
		return "", err
	}
	path := Path(dir, name)
	if _, err := os.Stat(path); err == nil {
		return "", fmt.Errorf("memory %q already exists at %s", name, path)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	st, err := store.Open(ctx, path, store.Options{Create: true, LogOnly: true})
	if err != nil {
		return "", err
	}
	defer st.Close()
	return setNewToken(ctx, st)
}

// NewToken replaces the access token of an existing memory and returns the
// new one. The old token stops working at once, also on a running server.
func NewToken(ctx context.Context, dir, name string) (token string, err error) {
	st, err := openLog(ctx, dir, name)
	if err != nil {
		return "", err
	}
	defer st.Close()
	return setNewToken(ctx, st)
}

// Describe reports what a memory's event log says about it. Like every way
// of opening a memory, it brings an older log to the current format first.
func Describe(ctx context.Context, dir, name string) (store.LogStats, error) {
	st, err := openLog(ctx, dir, name)
	if err != nil {
		return store.LogStats{}, err
	}
	defer st.Close()
	return st.LogStats(ctx)
}

// Rebuild replays a memory's event log into fresh derived tables and reports
// how many memories and events it holds. Do not run it while a server has the
// memory open with different forgetting parameters.
func Rebuild(ctx context.Context, dir, name string, params store.Params) (memories, events int64, err error) {
	if err := ValidName(name); err != nil {
		return 0, 0, err
	}
	st, err := store.Open(ctx, Path(dir, name), store.Options{Params: params})
	if errors.Is(err, fs.ErrNotExist) {
		return 0, 0, fmt.Errorf("%w: %q", ErrUnknown, name)
	}
	if err != nil {
		return 0, 0, err
	}
	defer st.Close()
	if err := st.Rebuild(ctx); err != nil {
		return 0, 0, err
	}
	return st.Counts(ctx)
}

func openLog(ctx context.Context, dir, name string) (*store.Store, error) {
	if err := ValidName(name); err != nil {
		return nil, err
	}
	st, err := store.Open(ctx, Path(dir, name), store.Options{LogOnly: true})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("%w: %q", ErrUnknown, name)
	}
	return st, err
}

func setNewToken(ctx context.Context, st *store.Store) (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	token := "ziwo_" + base64.RawURLEncoding.EncodeToString(b[:])
	return token, st.SetTokenHash(ctx, hashToken(token))
}

// hashToken is what is stored in place of a token. Tokens are 256 random
// bits, so a plain hash is enough: there is nothing to guess.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Config configures a Host.
type Config struct {
	// Dir is the directory that holds the memory files.
	Dir string
	// Params are the forgetting parameters applied to every memory served.
	Params store.Params
	// Embedder is shared by all memories. Nil means keyword search only.
	Embedder embed.Embedder
	// Memory is passed to each memory's service.
	Memory memory.Config
	// NoAuth serves every memory without checking tokens. Only for a
	// loopback address.
	NoAuth      bool
	BehindProxy bool
	Version     string
	Logger      *slog.Logger
}

// Host keeps memories open and routes requests to them.
type Host struct {
	cfg Config
	log *slog.Logger

	mu     sync.Mutex
	open   map[string]*body
	closed bool
}

type body struct {
	st  *store.Store
	svc *memory.Service
	mcp http.Handler
}

// New returns a Host. It opens nothing until asked.
func New(cfg Config) *Host {
	log := cfg.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Host{cfg: cfg, log: log, open: make(map[string]*body)}
}

// Open opens the memory called name, if it is not open already, and reports
// how many memories it holds in each tier. A memory created after the server
// started is opened on its first request, so this is only needed to find
// problems early.
func (h *Host) Open(ctx context.Context, name string) (store.TierCounts, error) {
	b, err := h.body(ctx, name)
	if err != nil {
		return store.TierCounts{}, err
	}
	clock, err := b.st.Clock(ctx)
	if err != nil {
		return store.TierCounts{}, err
	}
	return b.st.TierCounts(ctx, clock)
}

func (h *Host) body(ctx context.Context, name string) (*body, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, errors.New("shutting down")
	}
	if b := h.open[name]; b != nil {
		return b, nil
	}
	if ValidName(name) != nil {
		return nil, ErrUnknown
	}
	// A request that is cancelled must not leave a memory half open.
	ctx = context.WithoutCancel(ctx)
	st, err := store.Open(ctx, Path(h.cfg.Dir, name), store.Options{Params: h.cfg.Params})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrUnknown
	}
	if err != nil {
		return nil, fmt.Errorf("open memory %q: %w", name, err)
	}
	log := h.log.With("memory", name)
	mcfg := h.cfg.Memory
	mcfg.Logger = log
	svc, err := memory.New(ctx, st, h.cfg.Embedder, mcfg)
	if err != nil {
		st.Close()
		return nil, fmt.Errorf("open memory %q: %w", name, err)
	}
	b := &body{st: st, svc: svc, mcp: server.New(svc, server.Options{
		BehindProxy: h.cfg.BehindProxy, Version: h.cfg.Version, Logger: log,
	})}
	h.open[name] = b
	return b, nil
}

// Handler serves each memory's MCP endpoint at /<name>/mcp and a liveness
// probe at /healthz.
func (h *Host) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/{name}/mcp", func(w http.ResponseWriter, r *http.Request) {
		b, err := h.body(r.Context(), r.PathValue("name"))
		switch {
		case err == nil && h.allowed(r, b):
			b.mcp.ServeHTTP(w, r)
		case err != nil && !errors.Is(err, ErrUnknown):
			h.log.Error("memory unavailable", "err", err)
			http.Error(w, "this memory cannot be opened right now; see the server log", http.StatusServiceUnavailable)
		case err != nil && h.cfg.NoAuth:
			// Nothing is being kept from anyone, so say what is wrong.
			http.Error(w, "no such memory; create it with: ziwo new <name>", http.StatusNotFound)
		default:
			// The same answer for a wrong token and for a name that names
			// nothing, so the names of memories do not leak.
			w.Header().Set("WWW-Authenticate", `Bearer realm="ziwo"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}
	})
	return mux
}

// allowed reports whether the request carries the memory's own token. The
// hash is read from the file each time, so a replaced token takes effect
// without a restart.
func (h *Host) allowed(r *http.Request, b *body) bool {
	if h.cfg.NoAuth {
		return true
	}
	scheme, got, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if !strings.EqualFold(scheme, "Bearer") {
		return false
	}
	want, ok, err := b.st.TokenHash(r.Context())
	if err != nil || !ok {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(hashToken(strings.TrimSpace(got))), []byte(want)) == 1
}

// Close closes every open memory.
func (h *Host) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	var errs []error
	for name, b := range h.open {
		errs = append(errs, b.svc.Close(), b.st.Close())
		delete(h.open, name)
	}
	return errors.Join(errs...)
}

// Export writes the memory called name to file, sealed under the passphrase.
// It can run while the memory is being served. It reports how many events
// the export holds.
func Export(ctx context.Context, dir, name, file, passphrase string) (events int64, err error) {
	st, err := openLog(ctx, dir, name)
	if err != nil {
		return 0, err
	}
	defer st.Close()
	var plain bytes.Buffer
	if events, err = st.Export(ctx, &plain, time.Now()); err != nil {
		return 0, err
	}
	out, err := sealed.Seal(plain.Bytes(), passphrase)
	if err != nil {
		return 0, err
	}
	return events, os.WriteFile(file, out, 0o600)
}

// Import brings the export in file back as a new memory called name.
func Import(ctx context.Context, dir, name, file, passphrase string) (store.ImportStats, error) {
	if err := ValidName(name); err != nil {
		return store.ImportStats{}, err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return store.ImportStats{}, err
	}
	plain, err := sealed.Open(data, passphrase)
	if err != nil {
		return store.ImportStats{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return store.ImportStats{}, err
	}
	return store.Import(ctx, Path(dir, name), bytes.NewReader(plain), time.Now())
}

// Check examines the memory called name and reports what it finds, without
// quoting what any memory says.
func Check(ctx context.Context, dir, name string) (store.Report, error) {
	st, err := openLog(ctx, dir, name)
	if err != nil {
		return store.Report{}, err
	}
	defer st.Close()
	return st.Check(ctx)
}
