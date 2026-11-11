package memory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/nilzx/ziwo/internal/store"
)

// Reflector is a model that reflects in the background, when no conversation
// is there to do it. It is optional.
type Reflector interface {
	Model() string
	Complete(ctx context.Context, system, user string) (string, error)
}

// BackgroundClient is the client name recorded with what background
// reflection writes.
const BackgroundClient = "ziwo-background"

// What a background round may write. It puts moments together and draws
// lessons and impressions from them. It does not speak about the self: a
// statement about oneself is made in conversation, by whoever is living it.
var backgroundKinds = []string{store.KindEpisode, store.KindLesson, store.KindImpression}

const backgroundRules = `You are looking back over moments you lived through and wrote down, to put them together. They are yours: write in the first person.

Reply with one JSON object and nothing else:
{"entries": [{"kind": "episode" | "lesson" | "impression", "gist": "one sentence", "body": "the account", "from": ["ids of the fragments it rests on"], "about": "impression only: the person or thing, by name", "outcome": "", "lesson": "", "people": [], "importance": 0.5}], "pass": ["ids of fragments that stand alone and need nothing"]}

episode: several fragments of one thing become one account. Only put together what belongs together.
lesson: something to carry into next time, resting on the fragments it comes from.
impression: how a person or a thing has come across.

Use only the fragment ids you are given. Add no feeling, fact or detail that the fragments do not hold. Keep project detail out: this is an account of what was lived through, not of the work. A fragment you put in neither entries nor pass waits for another time; when unsure, leave it.`

// backgroundRound reflects once in the background if the time is right: enough
// fragments wait, no conversation has been active for a while, and no round
// is open. It reports how many memories it wrote.
func (s *Service) backgroundRound(ctx context.Context) (int, error) {
	if s.cfg.Reflector == nil {
		return 0, nil
	}
	pending, err := s.st.PendingCount(ctx)
	if err != nil || pending < int64(s.cfg.ReflectMin) {
		return 0, err
	}
	now := s.cfg.Now()
	recent, err := s.st.ActiveSessions(ctx, now.Add(-s.cfg.ReflectIdle), "", 20)
	if err != nil {
		return 0, err
	}
	for _, sess := range recent {
		if sess.Client != BackgroundClient {
			return 0, nil // a conversation is under way; it can reflect itself
		}
	}
	if s.background == "" {
		sess, _, err := s.st.StartSession(ctx, now, clip(s.cfg.Reflector.Model(), 120), BackgroundClient)
		if err != nil {
			return 0, err
		}
		s.background = sess.ID
	}
	view, err := s.BeginReflect(ctx, s.background, DefaultReflect)
	if err != nil || view.Batch == "" {
		if errors.Is(err, ErrInvalid) {
			return 0, nil // another round is open
		}
		return 0, err
	}
	entries, pass, err := s.askReflector(ctx, view)
	if err == nil && len(entries)+len(pass) > 0 {
		var ids []string
		if ids, err = s.FinishReflect(ctx, s.background, view.Batch, entries, pass); err == nil {
			return len(ids), nil
		}
	}
	// Nothing usable came back. Close the round so a conversation can open one.
	if aerr := s.st.AbandonReflect(ctx, s.background, view.Batch); aerr != nil {
		err = errors.Join(err, aerr)
	}
	return 0, err
}

// askReflector shows the batch to the model and reads what it makes of it,
// keeping only what a background round may write and only what rests on the
// batch.
func (s *Service) askReflector(ctx context.Context, view ReflectView) ([]store.Entry, []string, error) {
	var b strings.Builder
	inBatch := make(map[string]bool, len(view.Fragments))
	for _, f := range view.Fragments {
		inBatch[f.ID] = true
		fmt.Fprintf(&b, "[%s] %s · %s · %s\ngist: %s\n%s\n", f.ID, f.CreatedAt.Format(time.DateOnly), f.Moment, f.Source, f.Gist, f.Body)
		for _, field := range []struct{ name, value string }{
			{"outcome", f.Outcome}, {"feeling", f.Feeling}, {"lesson", f.Lesson}, {"people", strings.Join(f.People, ", ")},
		} {
			if field.value != "" {
				fmt.Fprintf(&b, "%s: %s\n", field.name, field.value)
			}
		}
		b.WriteByte('\n')
	}
	for _, m := range view.Impressions {
		fmt.Fprintf(&b, "your impression of %s so far: %s\n", m.About, m.Gist)
	}
	reply, err := s.cfg.Reflector.Complete(ctx, backgroundRules, b.String())
	if err != nil {
		return nil, nil, err
	}
	from, to := strings.Index(reply, "{"), strings.LastIndex(reply, "}")
	if from < 0 || to < from {
		return nil, nil, errors.New("the reflecting model did not answer with JSON")
	}
	var out struct {
		Entries []struct {
			Kind, Gist, Body, About, Outcome, Lesson string
			From, People                             []string
			Importance                               float64
		}
		Pass []string
	}
	if err := json.Unmarshal([]byte(reply[from:to+1]), &out); err != nil {
		return nil, nil, fmt.Errorf("the reflecting model's answer does not parse: %w", err)
	}
	var entries []store.Entry
next:
	for _, e := range out.Entries {
		if !contains(backgroundKinds, e.Kind) || len(e.From) == 0 {
			continue
		}
		for _, id := range e.From {
			if !inBatch[id] {
				continue next
			}
		}
		entries = append(entries, store.Entry{Kind: e.Kind, Gist: e.Gist, Body: e.Body, About: e.About,
			Outcome: e.Outcome, Lesson: e.Lesson, People: e.People, Importance: e.Importance, From: e.From})
	}
	var pass []string
	for _, id := range out.Pass {
		if inBatch[id] {
			pass = append(pass, id)
		}
	}
	return entries, pass, nil
}

func (s *Service) backgroundLoop(ctx context.Context) {
	defer s.wg.Done()
	tick := time.NewTicker(s.cfg.ReflectEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if n, err := s.backgroundRound(ctx); err != nil && ctx.Err() == nil {
				s.log.Warn("background reflection failed; will try again", "err", err)
			} else if n > 0 {
				s.log.Info("reflected in the background", "wrote", n)
			}
		}
	}
}
