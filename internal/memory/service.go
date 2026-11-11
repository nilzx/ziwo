// Package memory is the behaviour of the memory system: what may be written,
// how memories are found again, and the background work that keeps writes and
// reads fast.
package memory

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nilzx/ziwo/internal/embed"
	"github.com/nilzx/ziwo/internal/store"
	"github.com/nilzx/ziwo/internal/vector"
)

// Limits on what a single memory may hold. A memory is an account of a
// moment, not a transcript, so the limits are deliberately tight.
const (
	MaxGistRunes    = 200
	MaxBodyRunes    = 6000
	MaxFieldRunes   = 1000
	MaxPointerRunes = 500
	MaxPeople       = 16

	DefaultRecall = 5
	MaxRecall     = 20
	MaxExpand     = 10

	// SessionWindow is how long after a session starts a memory written
	// without a session id is still attached to it.
	SessionWindow = 30 * time.Minute

	embedBatchSize = 16

	// relevanceFloor drops results whose relevance is below this share of the
	// best result's. Being returned strengthens a memory, so a memory that
	// only brushes the query must not be returned.
	relevanceFloor = 0.3
)

// Moments are the kinds of occasion worth remembering.
var Moments = []string{"start", "blocked", "corrected", "breakthrough", "finished", "emotion", "other"}

// Sources say how the AI came to know what a memory holds.
var Sources = []string{"lived", "told", "inferred"}

// ErrInvalid marks an error the caller can fix by changing its input.
var ErrInvalid = errors.New("invalid input")

// Config tunes a Service. Zero values pick the defaults.
type Config struct {
	// MinSimilarity drops vector matches whose cosine similarity is lower.
	// The right value depends on the embedding model. Default 0.35.
	MinSimilarity float32
	// QueryTimeout is how long a search waits for the query embedding before
	// answering from keywords alone. Default 2s.
	QueryTimeout time.Duration
	// EmbedMaxRunes truncates the text sent for embedding. Default 1500.
	EmbedMaxRunes int
	// RecentLimit is how many recent memories a new session is shown. Default 8.
	RecentLimit int
	// CoreLimit is how many core memories a new session is shown. Default 12.
	CoreLimit int
	// SweepEvery is how often the vectors of archived memories are dropped.
	// Default one hour.
	SweepEvery time.Duration
	Logger     *slog.Logger
	Now        func() time.Time
}

// Service ties the store, the embedder and the vector index together.
type Service struct {
	st  *store.Store
	emb embed.Embedder // nil: keyword search only
	ix  *vector.Index
	cfg Config
	log *slog.Logger

	stop context.CancelFunc
	wg   sync.WaitGroup
	wake chan struct{}

	embedMu sync.Mutex
	skip    map[int64]bool // memories the embedding server refuses

	mu      sync.Mutex
	bound   map[string]string // MCP connection id -> session id
	pending []store.RecallNote
}

// New loads stored vectors into memory and starts the background workers.
func New(ctx context.Context, st *store.Store, emb embed.Embedder, cfg Config) (*Service, error) {
	if cfg.MinSimilarity == 0 {
		cfg.MinSimilarity = 0.35
	}
	if cfg.QueryTimeout == 0 {
		cfg.QueryTimeout = 2 * time.Second
	}
	if cfg.EmbedMaxRunes == 0 {
		cfg.EmbedMaxRunes = 1500
	}
	if cfg.RecentLimit == 0 {
		cfg.RecentLimit = 8
	}
	if cfg.CoreLimit == 0 {
		cfg.CoreLimit = 12
	}
	if cfg.SweepEvery == 0 {
		cfg.SweepEvery = time.Hour
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	s := &Service{
		st: st, emb: emb, ix: vector.New(), cfg: cfg, log: cfg.Logger,
		wake:  make(chan struct{}, 1),
		skip:  make(map[int64]bool),
		bound: make(map[string]string),
	}
	if emb != nil {
		err := st.Vectors(ctx, emb.Model(), func(n int64, vec []float32) error {
			if err := s.ix.Add(n, vec); err != nil {
				s.log.Warn("skipping stored vector", "memory", n, "err", err)
			}
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("load vectors: %w", err)
		}
	}
	bg, cancel := context.WithCancel(context.Background())
	s.stop = cancel
	s.wg.Add(2)
	go s.recallLoop(bg)
	go s.sweepLoop(bg)
	if emb != nil {
		s.wg.Add(1)
		go s.embedLoop(bg)
	}
	return s, nil
}

// Close stops the background workers and writes out what they were holding.
func (s *Service) Close() error {
	s.stop()
	s.wg.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.flushRecalls(ctx)
}

// Sync finishes all background work that is currently due. Tests and
// maintenance commands use it; normal operation never needs to.
func (s *Service) Sync(ctx context.Context) error {
	if err := s.flushRecalls(ctx); err != nil {
		return err
	}
	if err := s.Sweep(ctx); err != nil {
		return err
	}
	if s.emb == nil {
		return nil
	}
	for {
		n, err := s.embedBatch(ctx)
		if err != nil {
			return err
		}
		if n == 0 {
			return nil
		}
	}
}

// Indexed reports how many memories can be found by meaning.
func (s *Service) Indexed() int { return s.ix.Len() }

// ContextView is what a session is shown when it starts.
type ContextView struct {
	Session store.Session
	Carrier store.CarrierNote
	Core    []store.Memory // memories that never fade, most important first
	Recent  []store.Memory // newest memories not archived and not listed under Core
	Counts  store.TierCounts
	Now     time.Time
}

// Context starts a session for the given carrier and returns what it should
// know before the conversation begins. conn identifies the MCP connection, so
// later writes on it can be attached to this session. Being shown here does
// not count as a recall.
func (s *Service) Context(ctx context.Context, model, client, conn string) (ContextView, error) {
	model, client = clip(model, 120), clip(client, 120)
	now := s.cfg.Now()
	sess, note, err := s.st.StartSession(ctx, now, model, client)
	if err != nil {
		return ContextView{}, err
	}
	s.bind(conn, sess.ID)
	view := ContextView{Session: sess, Carrier: note, Now: now}
	if view.Core, err = s.st.Core(ctx, s.cfg.CoreLimit); err != nil {
		return ContextView{}, err
	}
	shown := make(map[string]bool, len(view.Core))
	for _, m := range view.Core {
		shown[m.ID] = true
	}
	recent, err := s.st.Recent(ctx, now, s.cfg.RecentLimit+len(view.Core))
	if err != nil {
		return ContextView{}, err
	}
	for _, m := range recent {
		if !shown[m.ID] && len(view.Recent) < s.cfg.RecentLimit {
			view.Recent = append(view.Recent, m)
		}
	}
	if view.Counts, err = s.st.TierCounts(ctx, now); err != nil {
		return ContextView{}, err
	}
	return view, nil
}

// RememberRequest is a memory to write, plus what is known about who is writing.
type RememberRequest struct {
	store.RememberInput
	Client string
	Conn   string
}

// Remember validates and stores one memory. It returns the memory's id and
// the session it was attached to. dup is true when the same memory had just
// been written and nothing new was stored.
func (s *Service) Remember(ctx context.Context, req RememberRequest) (id, session string, dup bool, err error) {
	in, err := clean(req.RememberInput)
	if err != nil {
		return "", "", false, err
	}
	now := s.cfg.Now()
	in.SessionID, err = s.resolveSession(ctx, in.SessionID, req.Conn, clip(req.Client, 120), now)
	if err != nil {
		return "", "", false, err
	}
	id, dup, err = s.st.Remember(ctx, now, in)
	if err != nil {
		return "", "", false, err
	}
	if !dup {
		s.wakeEmbedder()
	}
	return id, in.SessionID, dup, nil
}

func clean(in store.RememberInput) (store.RememberInput, error) {
	in.Gist = strings.TrimSpace(in.Gist)
	in.Body = strings.TrimSpace(in.Body)
	in.Outcome = strings.TrimSpace(in.Outcome)
	in.Feeling = strings.TrimSpace(in.Feeling)
	in.Lesson = strings.TrimSpace(in.Lesson)
	in.Pointer = strings.TrimSpace(in.Pointer)
	in.SessionID = strings.TrimSpace(in.SessionID)

	if in.Gist == "" {
		return in, invalid("gist is required: one sentence saying what happened")
	}
	if n := utf8.RuneCountInString(in.Gist); n > MaxGistRunes {
		return in, invalid("gist is %d characters, the limit is %d: keep it to one sentence", n, MaxGistRunes)
	}
	if in.Body == "" {
		return in, invalid("body is required: what happened, in your own words")
	}
	if n := utf8.RuneCountInString(in.Body); n > MaxBodyRunes {
		return in, invalid("body is %d characters, the limit is %d: a memory is an account of what you lived through, not a transcript or project notes", n, MaxBodyRunes)
	}
	for name, v := range map[string]string{"outcome": in.Outcome, "feeling": in.Feeling, "lesson": in.Lesson} {
		if n := utf8.RuneCountInString(v); n > MaxFieldRunes {
			return in, invalid("%s is %d characters, the limit is %d", name, n, MaxFieldRunes)
		}
	}
	if n := utf8.RuneCountInString(in.Pointer); n > MaxPointerRunes {
		return in, invalid("pointer is %d characters, the limit is %d: give a location, not the content", n, MaxPointerRunes)
	}

	if in.Moment == "" {
		in.Moment = "other"
	}
	if !contains(Moments, in.Moment) {
		return in, invalid("moment must be one of %s", strings.Join(Moments, ", "))
	}
	if in.Source == "" {
		in.Source = "lived"
	}
	if !contains(Sources, in.Source) {
		return in, invalid("source must be one of %s", strings.Join(Sources, ", "))
	}
	if in.Importance == 0 {
		in.Importance = 0.5
	}
	if in.Importance < 0 || in.Importance > 1 {
		return in, invalid("importance must be between 0 and 1")
	}
	if in.Intensity < 0 || in.Intensity > 1 {
		return in, invalid("feeling_intensity must be between 0 and 1")
	}
	if in.Intensity > 0 && in.Feeling == "" {
		return in, invalid("feeling_intensity needs a feeling: say what registered, or leave both out")
	}

	var people []string
	for _, p := range in.People {
		if p = clip(strings.TrimSpace(p), 80); p != "" && !contains(people, p) {
			people = append(people, p)
		}
	}
	if len(people) > MaxPeople {
		return in, invalid("at most %d people per memory", MaxPeople)
	}
	in.People = people
	return in, nil
}

// resolveSession decides which session a write belongs to: the one it names,
// else the one this connection started, else a recent one from the same
// client, else a new one. A model that never called get_context still gets
// its memories grouped.
func (s *Service) resolveSession(ctx context.Context, explicit, conn, client string, now time.Time) (string, error) {
	if explicit != "" {
		_, ok, err := s.st.Session(ctx, explicit)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", invalid("unknown session_id %q: leave it out, or call get_context to get one", explicit)
		}
		return explicit, nil
	}
	if id, ok := s.boundTo(conn); ok {
		return id, nil
	}
	sess, ok, err := s.st.LatestSession(ctx, client, now.Add(-SessionWindow))
	if err != nil {
		return "", err
	}
	if !ok {
		if sess, _, err = s.st.StartSession(ctx, now, "", client); err != nil {
			return "", err
		}
	}
	s.bind(conn, sess.ID)
	return sess.ID, nil
}

func (s *Service) bind(conn, session string) {
	if conn == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.bound) >= 4096 {
		clear(s.bound) // connections that lose their binding fall back to the time window
	}
	s.bound[conn] = session
}

func (s *Service) boundTo(conn string) (string, bool) {
	if conn == "" {
		return "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.bound[conn]
	return id, ok
}

// Result is one memory found by Recall.
type Result struct {
	store.Memory
	Tier      store.Tier // at the time of the search, before it counted as a recall
	Score     float64
	ByKeyword bool
	ByMeaning bool
}

// Recall searches by keyword and, when an embedder is configured, by meaning,
// and returns the best matches.
//
// An ordinary search finds active and core memories by anything they say and
// faded ones by their gist or their meaning. A deep search also reads the
// details of faded memories and reaches archived ones.
//
// Every memory returned counts as recalled: it is strengthened and, if it had
// faded, becomes active again. That write happens after the answer is returned.
func (s *Service) Recall(ctx context.Context, query string, limit int, deep bool, conn string) ([]Result, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, invalid("query is required")
	}
	query = clip(query, 500)
	switch {
	case limit <= 0:
		limit = DefaultRecall
	case limit > MaxRecall:
		limit = MaxRecall
	}
	depth := max(4*limit, 20)
	now := s.cfg.Now()

	// Embedding the query is the slow part, so it runs alongside the keyword search.
	var byMeaning chan []vector.Hit
	if s.emb != nil && s.ix.Len() > 0 {
		byMeaning = make(chan []vector.Hit, 1)
		go func() {
			ectx, cancel := context.WithTimeout(ctx, s.cfg.QueryTimeout)
			defer cancel()
			vecs, err := s.emb.Embed(ectx, embed.Query, []string{query})
			if err != nil || len(vecs) != 1 {
				s.log.Warn("query embedding failed; answering from keywords only", "err", err)
				byMeaning <- nil
				return
			}
			byMeaning <- s.ix.Search(vecs[0], depth, s.cfg.MinSimilarity)
		}()
	}

	byKeyword, err := s.st.SearchText(ctx, query, now, deep, depth)
	if err != nil {
		return nil, err
	}

	// Each way of searching scores a memory between 0 and 1: keyword matches
	// relative to the best keyword match, matches by meaning by their cosine
	// similarity. Relevance is the average over the ways that found anything,
	// so a memory found both ways outranks one found by a single way.
	type cand struct {
		keyword, meaning   float64
		byKeyword, byMeans bool
	}
	cands := make(map[int64]*cand)
	get := func(n int64) *cand {
		c := cands[n]
		if c == nil {
			c = &cand{}
			cands[n] = c
		}
		return c
	}
	ways := 0
	if len(byKeyword) > 0 {
		ways++
		best := byKeyword[0].Score
		for _, h := range byKeyword {
			c := get(h.N)
			c.byKeyword = true
			c.keyword = 1
			if best > 0 {
				c.keyword = h.Score / best
			}
		}
	}
	if byMeaning != nil {
		hits := <-byMeaning
		if len(hits) > 0 {
			ways++
		}
		for _, h := range hits {
			c := get(h.Key)
			c.byMeans = true
			c.meaning = float64(h.Score)
		}
	}
	if len(cands) == 0 {
		return nil, nil
	}

	ns := make([]int64, 0, len(cands))
	for n := range cands {
		ns = append(ns, n)
	}
	found, err := s.st.ByN(ctx, ns)
	if err != nil {
		return nil, err
	}
	type scored struct {
		Result
		relevance float64
	}
	var kept []scored
	var top float64
	for n, m := range found {
		tier := m.Tier(now)
		if tier == store.TierArchived && !deep {
			continue // its vector has not been swept yet
		}
		c := cands[n]
		relevance := (c.keyword + c.meaning) / float64(ways)
		top = max(top, relevance)
		kept = append(kept, scored{relevance: relevance, Result: Result{
			Memory: m,
			Tier:   tier,
			// Relevance leads. Importance and how well the memory has been
			// retained scale it by at most a factor of three between them.
			Score:     relevance * (0.7 + 0.3*m.Importance) * (0.5 + 0.5*m.Retention(now)),
			ByKeyword: c.byKeyword,
			ByMeaning: c.byMeans,
		}})
	}
	results := make([]Result, 0, len(kept))
	for _, k := range kept {
		if k.relevance >= relevanceFloor*top {
			results = append(results, k.Result)
		}
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].Score != results[j].Score {
			return results[i].Score > results[j].Score
		}
		return results[i].N > results[j].N
	})
	if len(results) > limit {
		results = results[:limit]
	}
	if len(results) == 0 {
		return nil, nil
	}

	ids := make([]string, len(results))
	for i, r := range results {
		ids[i] = r.ID
	}
	s.noteRecall(now, conn, query, ids)
	return results, nil
}

// Expand returns memories in full, whatever tier they are in. Reading a
// memory in full counts as recalling it.
func (s *Service) Expand(ctx context.Context, ids []string, conn string) ([]Result, error) {
	var want []string
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" && !contains(want, id) {
			want = append(want, id)
		}
	}
	if len(want) == 0 {
		return nil, invalid("ids is required")
	}
	if len(want) > MaxExpand {
		return nil, invalid("at most %d ids per call", MaxExpand)
	}
	ms, err := s.st.Get(ctx, want)
	if err != nil || len(ms) == 0 {
		return nil, err
	}
	now := s.cfg.Now()
	out := make([]Result, len(ms))
	found := make([]string, len(ms))
	for i, m := range ms {
		out[i] = Result{Memory: m, Tier: m.Tier(now)}
		found[i] = m.ID
	}
	s.noteRecall(now, conn, "", found)
	return out, nil
}

func (s *Service) noteRecall(at time.Time, conn, query string, ids []string) {
	session, _ := s.boundTo(conn)
	s.mu.Lock()
	s.pending = append(s.pending, store.RecallNote{At: at, Session: session, Query: query, IDs: ids})
	s.mu.Unlock()
}

func (s *Service) recallLoop(ctx context.Context) {
	defer s.wg.Done()
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := s.flushRecalls(ctx); err != nil && ctx.Err() == nil {
				s.log.Warn("recording recalls failed; will retry", "err", err)
			}
		}
	}
}

func (s *Service) flushRecalls(ctx context.Context) error {
	s.mu.Lock()
	notes := s.pending
	s.pending = nil
	s.mu.Unlock()
	if len(notes) == 0 {
		return nil
	}
	if err := s.st.LogRecalls(ctx, notes); err != nil {
		s.mu.Lock()
		s.pending = append(notes, s.pending...)
		s.mu.Unlock()
		return err
	}
	// A recalled memory that had been archived has no vector any more.
	s.wakeEmbedder()
	return nil
}

func (s *Service) sweepLoop(ctx context.Context) {
	defer s.wg.Done()
	tick := time.NewTicker(s.cfg.SweepEvery)
	defer tick.Stop()
	for {
		if err := s.Sweep(ctx); err != nil && ctx.Err() == nil {
			s.log.Warn("sweep failed; will retry", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// Sweep drops the vectors of memories that have been archived. Fading and
// archiving themselves need no sweep: a memory's tier is read off the clock.
func (s *Service) Sweep(ctx context.Context) error {
	dropped, err := s.st.DropArchivedVectors(ctx, s.cfg.Now())
	if err != nil {
		return err
	}
	for _, n := range dropped {
		s.ix.Remove(n)
	}
	if len(dropped) > 0 {
		s.log.Info("archived memories left the vector index", "count", len(dropped))
	}
	return nil
}

func (s *Service) wakeEmbedder() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Service) embedLoop(ctx context.Context) {
	defer s.wg.Done()
	backoff := time.Second
	for {
		n, err := s.embedBatch(ctx)
		switch {
		case ctx.Err() != nil:
			return
		case err != nil:
			s.log.Warn("embedding failed; will retry", "err", err, "in", backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(2*backoff, time.Minute)
		case n > 0:
			backoff = time.Second
		default:
			backoff = time.Second
			select {
			case <-ctx.Done():
				return
			case <-s.wake:
			}
		}
	}
}

// embedBatch embeds up to one batch of memories that have no vector yet and
// reports how many it finished.
func (s *Service) embedBatch(ctx context.Context) (int, error) {
	s.embedMu.Lock()
	defer s.embedMu.Unlock()

	fetched, err := s.st.Unembedded(ctx, s.emb.Model(), s.cfg.Now(), embedBatchSize+len(s.skip))
	if err != nil {
		return 0, err
	}
	var batch []store.Memory
	for _, m := range fetched {
		if !s.skip[m.N] && len(batch) < embedBatchSize {
			batch = append(batch, m)
		}
	}
	if len(batch) == 0 {
		return 0, nil
	}
	texts := make([]string, len(batch))
	for i, m := range batch {
		texts[i] = clip(m.Gist+"\n"+m.Body, s.cfg.EmbedMaxRunes)
	}

	vecs, err := s.emb.Embed(ctx, embed.Passage, texts)
	if err == nil {
		for i, m := range batch {
			if err := s.keep(ctx, m.N, vecs[i]); err != nil {
				return i, err
			}
		}
		return len(batch), nil
	}
	if len(batch) == 1 || ctx.Err() != nil {
		return 0, err
	}

	// The batch failed. Try each text alone: if some go through, the ones
	// that do not are refused for what they contain, and waiting will not
	// change that, so they are set aside rather than blocking the queue.
	done := 0
	var refused []store.Memory
	for i, m := range batch {
		one, oneErr := s.emb.Embed(ctx, embed.Passage, texts[i:i+1])
		if oneErr != nil {
			refused = append(refused, m)
			continue
		}
		if err := s.keep(ctx, m.N, one[0]); err != nil {
			return done, err
		}
		done++
	}
	if done == 0 {
		return 0, err // nothing works: the server is down, not the texts
	}
	for _, m := range refused {
		s.skip[m.N] = true
		s.log.Warn("embedding server refuses this memory; it stays findable by keyword only", "memory", m.ID)
	}
	return done, nil
}

func (s *Service) keep(ctx context.Context, n int64, vec []float32) error {
	if err := s.ix.Add(n, vec); err != nil {
		return err
	}
	return s.st.SaveVector(ctx, n, s.emb.Model(), vec)
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// clip shortens s to at most n runes.
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
