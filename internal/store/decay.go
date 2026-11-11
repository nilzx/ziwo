package store

import (
	"fmt"
	"math"
)

// Forgetting is driven by experience, not by the calendar. The clock is the
// number of memories written so far: it advances by one each time a memory is
// written and stands still otherwise. An AI lives through nothing between
// conversations, so a gap of three months forgets nothing; a week of dense
// work does.
//
// A memory has a strength S, counted in memories. When n memories have been
// written since it last came to mind, the chance that it comes to mind again is
//
//	R = exp(-n / S)
//
// A memory comes to mind in two ways, and they differ:
//
//   - Being listed by a search only restarts n. The memory stays reachable but
//     grows no stronger, so a memory cannot strengthen itself merely by being
//     easy to find.
//   - Being read in full multiplies S by 1 + boost*(1 - R), where R is taken
//     over the memories written since it was last read. A memory read after a
//     long gap is strengthened more than one read again right away.
//
// Nothing is rewritten as the clock advances. When a memory is written or
// comes to mind, the clock values at which R will cross the fade and archive
// thresholds are worked out and stored. A memory's tier is then a comparison
// against the clock at the time of asking.

// Params tune how memories strengthen and fade. They are part of how the
// derived tables are computed, so changing them rebuilds those tables.
type Params struct {
	// BaseStrength is the strength of an ordinary memory (lived, importance
	// 0.5, no feeling recorded), counted in memories.
	BaseStrength float64
	// RecallBoost is how much one reading can strengthen a memory. The
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
// ordinary memory fades once about 120 newer memories have been written
// without it coming to mind, and is archived after about 300.
func DefaultParams() Params {
	return Params{
		BaseStrength:   100,
		RecallBoost:    2,
		FadeBelow:      0.3,
		ArchiveBelow:   0.05,
		CoreImportance: 0.9,
		CoreFeeling:    0.9,
	}
}

// Validate reports the first thing wrong with the parameters, if anything.
func (p Params) Validate() error {
	switch {
	case !(p.BaseStrength > 0 && p.BaseStrength <= maxStrength):
		return fmt.Errorf("base strength must be positive and at most %g, got %v", float64(maxStrength), p.BaseStrength)
	case !(p.RecallBoost >= 0):
		return fmt.Errorf("recall boost must not be negative, got %v", p.RecallBoost)
	case !(p.ArchiveBelow > 0 && p.ArchiveBelow < p.FadeBelow && p.FadeBelow < 1):
		return fmt.Errorf("need 0 < archive threshold < fade threshold < 1, got archive %v, fade %v", p.ArchiveBelow, p.FadeBelow)
	case !(p.CoreImportance > 0 && p.CoreFeeling > 0):
		return fmt.Errorf("core thresholds must be positive, got importance %v, feeling %v", p.CoreImportance, p.CoreFeeling)
	}
	return nil
}

// Strength is kept within these bounds so the stored crossings stay finite.
const (
	minStrength = 0.01
	maxStrength = 1e9
)

// initialStrength is the strength a memory starts with. Importance moves it
// by up to a factor of four either way, a strong feeling up to doubles it,
// and what was only told or inferred starts weaker than what was lived.
func (p Params) initialStrength(importance, intensity float64, source string) float64 {
	s := p.BaseStrength * math.Pow(4, 2*importance-1) * (1 + intensity)
	switch source {
	case "told":
		s *= 0.7
	case "inferred":
		s *= 0.4
	}
	return clampStrength(s)
}

// reinforced is the strength after a reading at retention r.
func (p Params) reinforced(strength, r float64) float64 {
	return clampStrength(strength * (1 + p.RecallBoost*(1-r)))
}

// isCore reports whether a memory with these marks never fades.
func (p Params) isCore(importance, intensity float64) bool {
	return importance >= p.CoreImportance || intensity >= p.CoreFeeling
}

// crossings returns the clock values at which a memory that last came to mind
// at clock value touched, with the given strength, fades and is archived.
func (p Params) crossings(touched int64, strength float64) (fadeAt, archiveAt float64) {
	fadeAt = float64(touched) + strength*math.Log(1/p.FadeBelow)
	archiveAt = float64(touched) + strength*math.Log(1/p.ArchiveBelow)
	return fadeAt, archiveAt
}

func clampStrength(s float64) float64 {
	return math.Min(math.Max(s, minStrength), maxStrength)
}

// retention is R once n memories have been written, at the given strength.
func retention(strength float64, n int64) float64 {
	if n <= 0 {
		return 1
	}
	return math.Exp(-float64(n) / strength)
}

// Tier is how reachable a memory is at a given point.
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

// Tier reports how reachable the memory is when the clock reads clock.
func (m Memory) Tier(clock int64) Tier {
	switch {
	case m.Core:
		return TierCore
	case float64(clock) >= m.ArchiveAt:
		return TierArchived
	case float64(clock) >= m.FadeAt:
		return TierFaded
	default:
		return TierActive
	}
}

// Retention is R when the clock reads clock: 1 right after the memory came to
// mind, falling towards 0 as more memories are written.
func (m Memory) Retention(clock int64) float64 {
	if m.Core {
		return 1
	}
	return retention(m.Strength, clock-m.TouchedOrd)
}

// TierCounts says how many memories are in each tier.
type TierCounts struct {
	Core, Active, Faded, Archived int64
}

// Total is the number of memories in all tiers.
func (c TierCounts) Total() int64 { return c.Core + c.Active + c.Faded + c.Archived }
