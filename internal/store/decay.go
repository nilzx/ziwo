package store

import (
	"fmt"
	"math"
	"time"
)

// Forgetting follows one curve. A memory has a strength S, in days. After t
// days without being recalled, the chance it comes to mind is
//
//	R = exp(-t / S)
//
// Recalling it resets t and raises S by a factor of 1 + boost*(1 - R), so a
// memory recalled after a long gap is strengthened more than one recalled
// again right away.
//
// Nothing is rewritten as time passes. When a memory is written or recalled,
// the two moments at which R will cross the fade and archive thresholds are
// worked out and stored. A memory's tier is then a comparison against the
// clock at the time of asking.

// Params tune how memories strengthen and fade. They are part of how the
// derived tables are computed, so changing them rebuilds those tables.
type Params struct {
	// BaseStrengthDays is the strength of an ordinary memory: lived,
	// importance 0.5, no feeling recorded.
	BaseStrengthDays float64
	// RecallBoost is how much one recall can strengthen a memory. The
	// strength is multiplied by 1 + RecallBoost*(1 - R).
	RecallBoost float64
	// FadeBelow is the R below which only a memory's gist stays findable.
	FadeBelow float64
	// ArchiveBelow is the R below which a memory leaves ordinary search.
	ArchiveBelow float64
	// CoreImportance is the importance at or above which a memory never fades.
	CoreImportance float64
	// CoreFeeling is the feeling intensity at or above which a memory never fades.
	CoreFeeling float64
}

// DefaultParams are starting values, not measured ones. With them an
// ordinary memory fades after about 36 days without recall and is archived
// after about 90.
func DefaultParams() Params {
	return Params{
		BaseStrengthDays: 30,
		RecallBoost:      2,
		FadeBelow:        0.3,
		ArchiveBelow:     0.05,
		CoreImportance:   0.9,
		CoreFeeling:      0.9,
	}
}

func (p Params) validate() error {
	switch {
	case !(p.BaseStrengthDays > 0):
		return fmt.Errorf("base strength must be positive, got %v days", p.BaseStrengthDays)
	case !(p.RecallBoost >= 0):
		return fmt.Errorf("recall boost must not be negative, got %v", p.RecallBoost)
	case !(p.ArchiveBelow > 0 && p.ArchiveBelow < p.FadeBelow && p.FadeBelow < 1):
		return fmt.Errorf("need 0 < archive threshold < fade threshold < 1, got archive %v, fade %v", p.ArchiveBelow, p.FadeBelow)
	case !(p.CoreImportance > 0 && p.CoreFeeling > 0):
		return fmt.Errorf("core thresholds must be positive, got importance %v, feeling %v", p.CoreImportance, p.CoreFeeling)
	}
	return nil
}

const (
	msPerDay = 24 * 60 * 60 * 1000
	// Strength is kept within these bounds so the stored moments stay finite.
	// The lower bound is a fraction of a second, which lets a trial run with a
	// tiny -strength-days watch memories fade in real time.
	minStrengthDays = 1e-6
	maxStrengthDays = 36500
)

// initialStrength is the strength a memory starts with, in days. Importance
// moves it by up to a factor of four either way, a strong feeling up to
// doubles it, and what was only told or inferred starts weaker than what was
// lived.
func (p Params) initialStrength(importance, intensity float64, source string) float64 {
	s := p.BaseStrengthDays * math.Pow(4, 2*importance-1) * (1 + intensity)
	switch source {
	case "told":
		s *= 0.7
	case "inferred":
		s *= 0.4
	}
	return clampStrength(s)
}

// reinforced is the strength after a recall at retention r.
func (p Params) reinforced(strength, r float64) float64 {
	return clampStrength(strength * (1 + p.RecallBoost*(1-r)))
}

// isCore reports whether a memory with these marks never fades.
func (p Params) isCore(importance, intensity float64) bool {
	return importance >= p.CoreImportance || intensity >= p.CoreFeeling
}

// crossings returns the moments, in unix milliseconds, at which a memory last
// recalled at lastMs with the given strength fades and is archived.
func (p Params) crossings(lastMs int64, strength float64) (fadeAt, archiveAt int64) {
	fadeAt = lastMs + int64(strength*math.Log(1/p.FadeBelow)*msPerDay)
	archiveAt = lastMs + int64(strength*math.Log(1/p.ArchiveBelow)*msPerDay)
	return fadeAt, archiveAt
}

func clampStrength(s float64) float64 {
	return math.Min(math.Max(s, minStrengthDays), maxStrengthDays)
}

// retention is R after elapsedMs milliseconds at the given strength.
func retention(strength float64, elapsedMs int64) float64 {
	if elapsedMs <= 0 {
		return 1
	}
	return math.Exp(-float64(elapsedMs) / msPerDay / strength)
}

// Tier is how reachable a memory is at a given moment.
type Tier string

const (
	// TierCore memories never fade.
	TierCore Tier = "core"
	// TierActive memories are found by anything they say.
	TierActive Tier = "active"
	// TierFaded memories are found by their gist only, unless the search is deep.
	TierFaded Tier = "faded"
	// TierArchived memories are found by deep search only.
	TierArchived Tier = "archived"
)

// Tier reports how reachable the memory is at now.
func (m Memory) Tier(now time.Time) Tier {
	switch {
	case m.Core:
		return TierCore
	case !now.Before(m.ArchiveAt):
		return TierArchived
	case !now.Before(m.FadeAt):
		return TierFaded
	default:
		return TierActive
	}
}

// Retention is R at now: 1 right after a recall, falling towards 0.
func (m Memory) Retention(now time.Time) float64 {
	if m.Core {
		return 1
	}
	return retention(m.Strength, now.Sub(m.LastRecalledAt).Milliseconds())
}

// TierCounts says how many memories are in each tier.
type TierCounts struct {
	Core, Active, Faded, Archived int64
}

// Total is the number of memories in all tiers.
func (c TierCounts) Total() int64 { return c.Core + c.Active + c.Faded + c.Archived }
