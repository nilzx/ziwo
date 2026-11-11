package memory

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/nilzx/ziwo/internal/store"
)

// Limits on amending and reflecting.
const (
	MaxReasonRunes     = 300
	MaxPreferenceRunes = 300
	MaxPreferences     = 30
	MaxContextRunes    = 200
	MaxEntries         = 20
	MaxFrom            = 20

	DefaultReflect = 12
	MaxReflect     = 20
)

// AmendActions are the things amend can do.
var AmendActions = []string{"retract", "restore", "pin", "unpin", "reweigh", "correct", "erase", "prefer", "unprefer"}

// EntryKinds are the kinds of memory a round of reflection can write back.
var EntryKinds = []string{store.KindEpisode, store.KindLesson, store.KindImpression, store.KindSelf, store.KindReading}

// AmendRequest asks for a change to how something is remembered.
type AmendRequest struct {
	SessionID  string
	Action     string // one of AmendActions
	ID         string // the memory, or the preference for unprefer
	Reason     string // why, in the words of whoever asked
	Importance float64
	Text       string // prefer: the rule
	// correct: what replaces the old account. Fields left empty keep what
	// the old memory said.
	Gist, Body, Outcome, Lesson string
}

// Amend carries out one amendment and returns a sentence saying what was done.
func (s *Service) Amend(ctx context.Context, req AmendRequest) (string, error) {
	req.SessionID, req.Action, req.ID = strings.TrimSpace(req.SessionID), strings.TrimSpace(req.Action), strings.TrimSpace(req.ID)
	req.Reason, req.Text = strings.TrimSpace(req.Reason), strings.TrimSpace(req.Text)
	if req.SessionID == "" {
		return "", invalid("session_id is required: call get_context first and pass the session id it returns")
	}
	if !contains(AmendActions, req.Action) {
		return "", invalid("action must be one of %s", strings.Join(AmendActions, ", "))
	}
	if n := utf8.RuneCountInString(req.Reason); n > MaxReasonRunes {
		return "", invalid("reason is %d characters, the limit is %d", n, MaxReasonRunes)
	}
	if req.ID == "" && req.Action != "prefer" {
		return "", invalid("id is required for %s", req.Action)
	}
	now := s.cfg.Now()

	var msg string
	var err error
	switch req.Action {
	case "prefer":
		if req.Text == "" {
			return "", invalid("text is required for prefer: the rule, in one or two sentences")
		}
		if n := utf8.RuneCountInString(req.Text); n > MaxPreferenceRunes {
			return "", invalid("text is %d characters, the limit is %d: a preference is a short rule", n, MaxPreferenceRunes)
		}
		var id string
		if id, err = s.st.AddPreference(ctx, now, req.SessionID, req.Text, MaxPreferences); err == nil {
			msg = "preference saved as " + id + "; get_context will show it from now on"
		}

	case "unprefer":
		if err = s.st.RetirePreference(ctx, now, req.SessionID, req.ID, req.Reason); err == nil {
			msg = "preference " + req.ID + " dropped"
		}

	case "reweigh":
		if !(req.Importance > 0 && req.Importance <= 1) {
			return "", invalid("importance is required for reweigh, above 0 and at most 1")
		}
		if err = s.st.Amend(ctx, now, req.SessionID, req.Action, req.ID, req.Importance, req.Reason); err == nil {
			msg = fmt.Sprintf("importance of %s is now %.2g", req.ID, req.Importance)
		}

	case "correct":
		msg, err = s.correct(ctx, now, req)

	case "erase":
		var n int64
		if n, err = s.st.Erase(ctx, now, req.SessionID, req.ID, req.Reason); err == nil {
			s.ix.Remove(n)
			msg = "erased " + req.ID + ": what it said is gone for good. The record keeps only that it existed and that it was erased"
		}

	default: // retract, restore, pin, unpin
		if err = s.st.Amend(ctx, now, req.SessionID, req.Action, req.ID, 0, req.Reason); err == nil {
			msg = map[string]string{
				"retract": "retracted %s: it stays in the record and will not be recalled. restore undoes this",
				"restore": "restored %s: it can be recalled again",
				"pin":     "pinned %s: it will not fade",
				"unpin":   "unpinned %s: it fades like any other memory from here on",
			}[req.Action]
			msg = fmt.Sprintf(msg, req.ID)
			if ms, gerr := s.st.Get(ctx, []string{req.ID}); gerr == nil && len(ms) == 1 && !ms[0].Live() {
				s.ix.Remove(ms[0].N)
			}
			s.wakeEmbedder() // a restored memory needs its vector back
		}
	}
	if err != nil {
		return "", amendError(err, req)
	}
	return msg, nil
}

// correct writes a memory that takes the place of an old one. What the
// request leaves empty is carried over, and the new memory keeps the time the
// thing happened.
func (s *Service) correct(ctx context.Context, now time.Time, req AmendRequest) (string, error) {
	if strings.TrimSpace(req.Gist+req.Body+req.Outcome+req.Lesson) == "" {
		return "", invalid("correct needs what to say instead: give gist, body, outcome or lesson, whichever was wrong")
	}
	olds, err := s.st.Get(ctx, []string{req.ID})
	if err != nil {
		return "", err
	}
	if len(olds) == 0 {
		return "", fmt.Errorf("%w: %q", store.ErrNoMemory, req.ID)
	}
	old := olds[0]
	if old.State == store.StateErased {
		return "", store.ErrErased
	}
	if old.Kind != store.KindFragment && old.Kind != store.KindEpisode && old.Kind != store.KindLesson {
		return "", invalid("%s is a %s: only fragments, episodes and lessons are corrected this way", req.ID, old.Kind)
	}
	in := store.RememberInput{
		SessionID: req.SessionID, Moment: old.Moment, Source: old.Source,
		Importance: old.Importance, Intensity: old.Intensity,
		Gist: old.Gist, Body: old.Body, Outcome: old.Outcome, Feeling: old.Feeling, Lesson: old.Lesson,
		People: old.People, Pointer: old.Pointer,
	}
	for _, f := range []struct {
		to   *string
		from string
	}{
		{&in.Gist, req.Gist}, {&in.Body, req.Body}, {&in.Outcome, req.Outcome}, {&in.Lesson, req.Lesson},
	} {
		if strings.TrimSpace(f.from) != "" {
			*f.to = f.from
		}
	}
	if in, err = cleanText(in); err != nil {
		return "", err
	}
	in.Happened = old.CreatedAt
	id, err := s.st.Correct(ctx, now, req.ID, in)
	if err != nil {
		return "", err
	}
	s.ix.Remove(old.N)
	s.wakeEmbedder()
	return fmt.Sprintf("corrected: %s now stands in place of %s, which stays in the record marked as replaced", id, req.ID), nil
}

func amendError(err error, req AmendRequest) error {
	switch {
	case errors.Is(err, ErrInvalid):
		return err
	case errors.Is(err, store.ErrNoSession):
		return invalid("unknown session_id %q: call get_context and pass the session id it returns", req.SessionID)
	case errors.Is(err, store.ErrNoMemory):
		return invalid("no memory with id %q", req.ID)
	case errors.Is(err, store.ErrErased):
		return invalid("%s has been erased; there is nothing left to amend", req.ID)
	case errors.Is(err, store.ErrSuperseded):
		return invalid("%s has been replaced by a correction (%s): amend that one", req.ID, strings.TrimPrefix(err.Error(), store.ErrSuperseded.Error()+": "))
	case errors.Is(err, store.ErrNoPreference):
		return invalid("no preference in force with id %q", req.ID)
	case errors.Is(err, store.ErrTooManyPreferences):
		return invalid("there are already %d preferences in force: drop one with unprefer, or fold this into an existing one", MaxPreferences)
	}
	return err
}

// ReflectView is what a round of reflection is given to work on.
type ReflectView struct {
	Batch       string         // empty when there is nothing to reflect on
	Fragments   []store.Memory // in full, those nearest to fading first
	Selves      []store.Memory // the statements about oneself that stand
	Impressions []store.Memory // current impressions of the people in the fragments
	Remaining   int64          // fragments still waiting beyond this batch
}

// BeginReflect opens a round of reflection for the session and hands it a
// batch of fragments. Only one round is open at a time.
func (s *Service) BeginReflect(ctx context.Context, session string, limit int) (ReflectView, error) {
	session = strings.TrimSpace(session)
	if session == "" {
		return ReflectView{}, invalid("session_id is required: call get_context first and pass the session id it returns")
	}
	switch {
	case limit <= 0:
		limit = DefaultReflect
	case limit > MaxReflect:
		limit = MaxReflect
	}
	var view ReflectView
	var err error
	if view.Fragments, err = s.st.Pending(ctx, limit); err != nil {
		return ReflectView{}, err
	}
	if len(view.Fragments) == 0 {
		if _, ok, err := s.st.Session(ctx, session); err != nil || !ok {
			return ReflectView{}, amendError(errors.Join(err, store.ErrNoSession), AmendRequest{SessionID: session})
		}
		return view, nil
	}
	now := s.cfg.Now()
	batch, busyUntil, err := s.st.BeginReflect(ctx, now, session, s.cfg.ReflectHold)
	switch {
	case errors.Is(err, store.ErrReflectBusy):
		return ReflectView{}, invalid("another conversation is reflecting right now, so that the same fragments are not put together twice. Its round runs out in %d min at the latest; try again then",
			int((busyUntil.Sub(now)+time.Minute-1)/time.Minute))
	case err != nil:
		return ReflectView{}, amendError(err, AmendRequest{SessionID: session})
	}
	view.Batch = batch
	if view.Selves, err = s.st.Selves(ctx); err != nil {
		return ReflectView{}, err
	}
	var names []string
	for _, f := range view.Fragments {
		for _, p := range f.People {
			if !contains(names, p) {
				names = append(names, p)
			}
		}
	}
	if view.Impressions, err = s.st.Impressions(ctx, names); err != nil {
		return ReflectView{}, err
	}
	total, err := s.st.PendingCount(ctx)
	if err != nil {
		return ReflectView{}, err
	}
	view.Remaining = total - int64(len(view.Fragments))
	return view, nil
}

// FinishReflect writes a round of reflection back and returns the ids of the
// memories it made, in the order of the entries. pass names fragments that
// were looked at and left as they are.
func (s *Service) FinishReflect(ctx context.Context, session, batch string, entries []store.Entry, pass []string) ([]string, error) {
	session, batch = strings.TrimSpace(session), strings.TrimSpace(batch)
	if session == "" {
		return nil, invalid("session_id is required: call get_context first and pass the session id it returns")
	}
	if len(entries) == 0 && len(pass) == 0 {
		return nil, invalid("nothing to write back: give entries, or pass the fragments you are leaving as they are")
	}
	if len(entries) > MaxEntries {
		return nil, invalid("at most %d entries per round", MaxEntries)
	}
	for i := range entries {
		e, err := cleanEntry(entries[i])
		if err != nil {
			return nil, fmt.Errorf("%w (entry %d)", err, i+1)
		}
		entries[i] = e
	}
	pass = tidyIDs(pass)
	ids, err := s.st.FinishReflect(ctx, s.cfg.Now(), session, batch, entries, pass)
	var ee *store.EntryError
	switch {
	case errors.As(err, &ee):
		return nil, invalid("%s. Nothing was written", ee.Error())
	case errors.Is(err, store.ErrNoBatch):
		return nil, invalid("batch %q is not open: it was already written back, or its round ran out and another conversation started one. Nothing was written. Call reflect without a batch to start again", batch)
	case err != nil:
		return nil, amendError(err, AmendRequest{SessionID: session})
	}
	s.wakeEmbedder()
	return ids, nil
}

func tidyIDs(ids []string) []string {
	var out []string
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" && !contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// cleanEntry checks what an entry says. Whether what it rests on allows it
// is checked by the store, against the memory as it stands.
func cleanEntry(e store.Entry) (store.Entry, error) {
	e.Kind, e.Ref = strings.TrimSpace(e.Kind), strings.TrimSpace(e.Ref)
	e.About, e.Context = clip(strings.TrimSpace(e.About), 80), strings.TrimSpace(e.Context)
	if !contains(EntryKinds, e.Kind) {
		return e, invalid("kind must be one of %s", strings.Join(EntryKinds, ", "))
	}
	in, err := cleanText(store.RememberInput{
		Gist: e.Gist, Body: e.Body, Outcome: e.Outcome, Feeling: e.Feeling, Lesson: e.Lesson,
		People: e.People, Pointer: e.Pointer, Importance: e.Importance, Intensity: e.Intensity,
		Moment: "other", Source: "lived",
	})
	if err != nil {
		return e, err
	}
	e.Gist, e.Body, e.Outcome, e.Feeling, e.Lesson = in.Gist, in.Body, in.Outcome, in.Feeling, in.Lesson
	e.People, e.Pointer, e.Importance, e.Intensity = in.People, in.Pointer, in.Importance, in.Intensity
	if (e.Kind == store.KindEpisode || e.Kind == store.KindLesson) && e.Body == "" {
		return e, invalid("body is required for %s", e.Kind)
	}
	if n := utf8.RuneCountInString(e.Context); n > MaxContextRunes {
		return e, invalid("context is %d characters, the limit is %d: name the situation, do not describe it", n, MaxContextRunes)
	}
	e.From = tidyIDs(e.From)
	if len(e.From) > MaxFrom {
		return e, invalid("at most %d ids in from", MaxFrom)
	}
	switch e.Kind {
	case store.KindImpression:
		if e.About == "" {
			return e, invalid("about is required for an impression: the person or thing, by name")
		}
	case store.KindReading:
		if e.Ref == "" {
			return e, invalid("ref is required for a reading: the id of the memory it is about")
		}
	}
	if e.Kind != store.KindImpression {
		e.About = ""
	}
	if e.Kind != store.KindSelf {
		e.Context = ""
	}
	if e.Kind != store.KindSelf && e.Kind != store.KindReading {
		e.Ref = ""
	}
	if e.Kind != store.KindEpisode {
		e.Milestone = false
	}
	return e, nil
}
