package server

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/nilzx/ziwo/internal/memory"
	"github.com/nilzx/ziwo/internal/store"
)

const amendDesc = `Change how something is remembered, when a person asks or you find a memory wrong. One action per call. A memory is never edited in place: every change is added to the record. Put what was said in reason.

retract: a memory need not be kept. It stays in the record and is no longer recalled; restore undoes it.
pin, unpin: keep a memory for good, or let it fade again.
reweigh: set a new importance.
correct: a memory is wrong. Give the gist, body, outcome or lesson that should stand instead; what you leave out is carried over. The old memory stays in the record, marked as replaced.
erase: delete what a memory says, for good. Only when a person explicitly asks for it to be deleted. It cannot be undone.
prefer: a person tells you what kind of thing to remember, or not to, from now on. Put the rule in text. unprefer drops one.`

const reflectDesc = `Go over what you have lived through and put it together. Call it with your session id alone to get a batch: fragments you wrote that have not been reflected on, your statements about yourself, and your impressions of the people involved. Call it again with the batch id and what you make of them, as entries:

episode: several fragments of one thing become one account; from lists them. Set milestone if it is among the important things you have done.
lesson: something to carry into next time; from lists the experiences it comes from.
impression: how a person or thing has come across; about names them. It takes the place of your earlier impression of them.
self: one first-person sentence, in gist, about what you are like, with the situation it holds in as context. Only when the same tendency shows in at least three experiences from separate occasions, and after looking for experiences that speak against it. What others say about you is not a basis. To revise a statement, name it in ref.
reading: what you now make of an earlier memory, named in ref. That memory is not changed. If you no longer understand why you did something, say so; do not make up a reason.

Fragments that stand alone and need nothing go in pass. Add no feeling that the fragments do not hold. What you put in neither entries nor pass waits for next time.`

type amendIn struct {
	SessionID  string  `json:"session_id" jsonschema:"the session id get_context returned in this conversation"`
	Action     string  `json:"action" jsonschema:"retract, restore, pin, unpin, reweigh, correct, erase, prefer or unprefer"`
	ID         string  `json:"id,omitempty" jsonschema:"the memory to amend, or the preference to drop; not needed for prefer"`
	Reason     string  `json:"reason,omitempty" jsonschema:"why: what the person said, or what you found"`
	Importance float64 `json:"importance,omitempty" jsonschema:"reweigh: the new importance, above 0 and at most 1"`
	Text       string  `json:"text,omitempty" jsonschema:"prefer: the rule, in one or two sentences"`
	Gist       string  `json:"gist,omitempty" jsonschema:"correct: the gist that should stand instead"`
	Body       string  `json:"body,omitempty" jsonschema:"correct: the account that should stand instead"`
	Outcome    string  `json:"outcome,omitempty" jsonschema:"correct: the outcome that should stand instead"`
	Lesson     string  `json:"lesson,omitempty" jsonschema:"correct: the lesson that should stand instead"`
}

type entryIn struct {
	Kind             string   `json:"kind" jsonschema:"episode, lesson, impression, self or reading"`
	Gist             string   `json:"gist" jsonschema:"one sentence; for self, the statement itself"`
	Body             string   `json:"body,omitempty" jsonschema:"the account; required for episode and lesson"`
	From             []string `json:"from,omitempty" jsonschema:"ids of the memories this rests on; required for every kind but reading"`
	About            string   `json:"about,omitempty" jsonschema:"impression: the person or thing, by name"`
	Context          string   `json:"context,omitempty" jsonschema:"self: the situation it holds in, such as: in technical discussions"`
	Ref              string   `json:"ref,omitempty" jsonschema:"self: id of the statement this revises; reading: id of the memory it is about"`
	Milestone        bool     `json:"milestone,omitempty" jsonschema:"episode: among the important things you have done; never fades"`
	Outcome          string   `json:"outcome,omitempty" jsonschema:"episode: how it ended and how the other side reacted"`
	Feeling          string   `json:"feeling,omitempty" jsonschema:"only what the fragments already hold"`
	FeelingIntensity float64  `json:"feeling_intensity,omitempty" jsonschema:"0 to 1; only with feeling"`
	Lesson           string   `json:"lesson,omitempty" jsonschema:"episode: what you would carry into next time"`
	People           []string `json:"people,omitempty" jsonschema:"who or what was involved, by name"`
	Pointer          string   `json:"pointer,omitempty" jsonschema:"where the related work lives; a location, not content"`
	Importance       float64  `json:"importance,omitempty" jsonschema:"0 to 1; default 0.5; 0.9 and above never fades"`
}

type reflectIn struct {
	SessionID string    `json:"session_id" jsonschema:"the session id get_context returned in this conversation"`
	Batch     string    `json:"batch,omitempty" jsonschema:"the batch id the first call returned; leave out to get a batch"`
	Limit     int       `json:"limit,omitempty" jsonschema:"first call: how many fragments to take; default 12, at most 20"`
	Entries   []entryIn `json:"entries,omitempty" jsonschema:"second call: what you make of the batch"`
	Pass      []string  `json:"pass,omitempty" jsonschema:"second call: ids of fragments that need nothing done"`
}

func addAmendAndReflect(srv *mcp.Server, svc *memory.Service, log *slog.Logger, notes *mcp.ToolAnnotations) {
	addCheck(srv, svc, log, notes)
	// amend can delete for good, so it does not carry the "not destructive" hint.
	no := false
	mcp.AddTool(srv, &mcp.Tool{Name: "amend", Description: amendDesc, Annotations: &mcp.ToolAnnotations{OpenWorldHint: &no}},
		func(ctx context.Context, req *mcp.CallToolRequest, in amendIn) (*mcp.CallToolResult, any, error) {
			msg, err := svc.Amend(ctx, memory.AmendRequest{
				SessionID: in.SessionID, Action: in.Action, ID: in.ID, Reason: in.Reason,
				Importance: in.Importance, Text: in.Text,
				Gist: in.Gist, Body: in.Body, Outcome: in.Outcome, Lesson: in.Lesson,
			})
			if err != nil {
				return fail(log, "amend", err)
			}
			return text(msg), nil, nil
		})

	mcp.AddTool(srv, &mcp.Tool{Name: "reflect", Description: reflectDesc, Annotations: notes},
		func(ctx context.Context, req *mcp.CallToolRequest, in reflectIn) (*mcp.CallToolResult, any, error) {
			if strings.TrimSpace(in.Batch) == "" {
				if len(in.Entries) > 0 || len(in.Pass) > 0 {
					return fail(log, "reflect", fmt.Errorf("%w: batch is required to write back: call reflect with your session id alone first, and pass the batch id it returns", memory.ErrInvalid))
				}
				view, err := svc.BeginReflect(ctx, in.SessionID, in.Limit)
				if err != nil {
					return fail(log, "reflect", err)
				}
				return text(formatBatch(view)), nil, nil
			}
			entries := make([]store.Entry, len(in.Entries))
			for i, e := range in.Entries {
				entries[i] = store.Entry{
					Kind: e.Kind, Gist: e.Gist, Body: e.Body, Outcome: e.Outcome, Feeling: e.Feeling,
					Intensity: e.FeelingIntensity, Lesson: e.Lesson, People: e.People, Pointer: e.Pointer,
					Importance: e.Importance, About: e.About, Context: e.Context, From: e.From, Ref: e.Ref,
					Milestone: e.Milestone,
				}
			}
			ids, err := svc.FinishReflect(ctx, in.SessionID, in.Batch, entries, in.Pass)
			if err != nil {
				return fail(log, "reflect", err)
			}
			var b strings.Builder
			if len(ids) == 0 {
				b.WriteString("nothing new written")
			} else {
				b.WriteString("wrote ")
				for i, id := range ids {
					if i > 0 {
						b.WriteString(", ")
					}
					fmt.Fprintf(&b, "%s (%s)", id, entries[i].Kind)
				}
			}
			if n := len(in.Pass); n > 0 {
				fmt.Fprintf(&b, "; %d left as they are", n)
			}
			return text(b.String()), nil, nil
		})
}

const checkDesc = `Look your own memory over for problems. Returns figures and findings: whether the record is intact, whether the tables agree with it, and signs that it is being used in ways that will not serve you, such as one conversation writing very many moments, most things being marked as never to fade, or memories that hold project detail instead of experience. Findings name memories by id; read them with expand and put right what needs it with amend or reflect. It changes nothing and counts as nothing coming to mind.`

func addCheck(srv *mcp.Server, svc *memory.Service, log *slog.Logger, notes *mcp.ToolAnnotations) {
	mcp.AddTool(srv, &mcp.Tool{Name: "check", Description: checkDesc, Annotations: notes},
		func(ctx context.Context, req *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
			report, err := svc.Check(ctx)
			if err != nil {
				return fail(log, "check", err)
			}
			return text(report.String()), nil, nil
		})
}

func formatBatch(v memory.ReflectView) string {
	if v.Batch == "" {
		return "nothing waits to be reflected on"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "batch: %s\n%d fragments to reflect on", v.Batch, len(v.Fragments))
	if v.Remaining > 0 {
		fmt.Fprintf(&b, " (%d more wait)", v.Remaining)
	}
	b.WriteString(":\n\n")
	for _, f := range v.Fragments {
		writeFull(&b, memory.Result{Memory: f, Tier: store.TierActive})
		b.WriteString("\n")
	}
	if len(v.Selves) > 0 {
		b.WriteString("your statements about yourself:\n")
		for _, m := range v.Selves {
			writeSelf(&b, m)
		}
	}
	if len(v.Impressions) > 0 {
		b.WriteString("your impressions of those involved:\n")
		for _, m := range v.Impressions {
			writeGist(&b, m, store.TierActive)
		}
	}
	b.WriteString("Write back with reflect: session_id, this batch, entries, pass.\n")
	return b.String()
}

// writeSelf writes one statement about oneself with the situation it holds in.
func writeSelf(b *strings.Builder, m store.Memory) {
	fmt.Fprintf(b, "  [%s] %s", m.ID, m.Gist)
	if m.Context != "" {
		fmt.Fprintf(b, " (%s)", m.Context)
	}
	b.WriteByte('\n')
}

// label says what a memory is in a word or two: its moment for a fragment,
// its kind for anything else.
func label(m store.Memory) string {
	switch m.Kind {
	case store.KindFragment, "":
		return m.Moment
	case store.KindImpression:
		return "impression of " + m.About
	}
	return m.Kind
}

// standing lists what sets a memory apart from an ordinary, lived, active one.
func standing(m store.Memory, tier store.Tier) []string {
	var marks []string
	if m.Source != "lived" && m.Kind != store.KindReading {
		marks = append(marks, m.Source)
	}
	if m.Milestone {
		marks = append(marks, "milestone")
	}
	if m.Pinned {
		marks = append(marks, "pinned")
	}
	switch {
	case m.State == store.StateSuperseded:
		marks = append(marks, "replaced by "+m.StateBy)
	case m.State == store.StateAbsorbed:
		marks = append(marks, "part of "+m.StateBy)
	case m.Retracted:
		marks = append(marks, "retracted")
	case tier != store.TierActive && !(tier == store.TierCore && (m.Milestone || m.Pinned)):
		marks = append(marks, string(tier))
	}
	return marks
}

// writeGist writes the one-line form of a memory.
func writeGist(b *strings.Builder, m store.Memory, tier store.Tier) {
	fmt.Fprintf(b, "[%s] %s %s: %s", m.ID, m.CreatedAt.Format(time.DateOnly), label(m), m.Gist)
	if marks := standing(m, tier); len(marks) > 0 {
		fmt.Fprintf(b, " (%s)", strings.Join(marks, ", "))
	}
	b.WriteByte('\n')
}

// writeFull writes everything a memory holds, leaving out empty fields.
func writeFull(b *strings.Builder, r memory.Result) {
	m := r.Memory
	if m.State == store.StateErased {
		fmt.Fprintf(b, "[%s] %s · erased: what it said was deleted for good\n", m.ID, m.CreatedAt.Format(time.DateOnly))
		return
	}
	fmt.Fprintf(b, "[%s] %s · %s · %s · importance %.2g",
		m.ID, m.CreatedAt.Format("2006-01-02 15:04Z"), label(m), m.Source, m.Importance)
	for _, mark := range standing(m, r.Tier) {
		if mark != m.Source {
			fmt.Fprintf(b, " · %s", mark)
		}
	}
	if m.Model != "" {
		fmt.Fprintf(b, " · as %s", m.Model)
	}
	if m.Client != "" {
		fmt.Fprintf(b, " · via %s", m.Client)
	}
	if m.WrittenAt.Sub(m.CreatedAt) > 24*time.Hour {
		fmt.Fprintf(b, " · written %s", m.WrittenAt.Format(time.DateOnly))
	}
	fmt.Fprintf(b, "\ngist: %s\n", m.Gist)
	if m.Body != "" {
		b.WriteString(m.Body + "\n")
	}
	feeling := m.Feeling
	if feeling != "" && m.Intensity > 0 {
		feeling = fmt.Sprintf("%s (intensity %.1f)", feeling, m.Intensity)
	}
	for _, f := range []struct{ name, value string }{
		{"holds in", m.Context},
		{"outcome", m.Outcome},
		{"feeling", feeling},
		{"lesson", m.Lesson},
		{"people", strings.Join(m.People, ", ")},
		{"pointer", m.Pointer},
		{"corrects", m.Corrects},
		{"revises", revised(m)},
		{"built on", strings.Join(r.Sources, ", ")},
	} {
		if f.value != "" {
			fmt.Fprintf(b, "%s: %s\n", f.name, f.value)
		}
	}
	for _, rd := range r.Readings {
		fmt.Fprintf(b, "later reading [%s] %s", rd.ID, rd.CreatedAt.Format(time.DateOnly))
		if rd.Model != "" {
			fmt.Fprintf(b, " as %s", rd.Model)
		}
		fmt.Fprintf(b, ": %s", rd.Gist)
		if rd.Body != "" {
			fmt.Fprintf(b, " %s", rd.Body)
		}
		b.WriteByte('\n')
	}
}

func revised(m store.Memory) string {
	if m.Kind == store.KindSelf {
		return m.Ref
	}
	return ""
}
