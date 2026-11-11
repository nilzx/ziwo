// Package vector is an in-memory nearest-neighbour index.
//
// It scans every vector on each search. An autobiography grows by a few
// memories per conversation, so the whole set stays small enough for a full
// scan to take well under the time it takes to embed the query.
package vector

import (
	"fmt"
	"math"
	"sort"
	"sync"
)

// Hit is one search result.
type Hit struct {
	Key   int64
	Score float32 // cosine similarity
}

// Index holds unit-length vectors of one dimension, keyed by int64.
// It is safe for concurrent use.
type Index struct {
	mu   sync.RWMutex
	dim  int
	keys []int64
	data []float32 // len(keys) * dim
	pos  map[int64]int
}

// New returns an empty index. Its dimension is fixed by the first vector added.
func New() *Index {
	return &Index{pos: make(map[int64]int)}
}

// Len reports how many vectors the index holds.
func (ix *Index) Len() int {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return len(ix.keys)
}

// Add stores a copy of v under key, replacing any vector already there.
func (ix *Index) Add(key int64, v []float32) error {
	unit, err := normalize(v)
	if err != nil {
		return err
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.dim == 0 {
		ix.dim = len(unit)
	}
	if len(unit) != ix.dim {
		return fmt.Errorf("vector has %d dimensions, index has %d", len(unit), ix.dim)
	}
	if i, ok := ix.pos[key]; ok {
		copy(ix.data[i*ix.dim:], unit)
		return nil
	}
	ix.pos[key] = len(ix.keys)
	ix.keys = append(ix.keys, key)
	ix.data = append(ix.data, unit...)
	return nil
}

// Remove forgets the vector stored under key, if there is one.
func (ix *Index) Remove(key int64) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	i, ok := ix.pos[key]
	if !ok {
		return
	}
	last := len(ix.keys) - 1
	if i != last {
		// Fill the hole with the last vector, so the data stays dense.
		copy(ix.data[i*ix.dim:(i+1)*ix.dim], ix.data[last*ix.dim:])
		ix.keys[i] = ix.keys[last]
		ix.pos[ix.keys[i]] = i
	}
	ix.keys = ix.keys[:last]
	ix.data = ix.data[:last*ix.dim]
	delete(ix.pos, key)
}

// Search returns up to k vectors closest to q, best first, leaving out any
// whose cosine similarity is below min. A query of the wrong dimension, or a
// zero query, matches nothing.
func (ix *Index) Search(q []float32, k int, min float32) []Hit {
	unit, err := normalize(q)
	if err != nil || k <= 0 {
		return nil
	}
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	if len(unit) != ix.dim {
		return nil
	}
	top := make([]Hit, 0, k+1)
	for i, key := range ix.keys {
		score := dot(unit, ix.data[i*ix.dim:(i+1)*ix.dim])
		if score < min || (len(top) == k && score <= top[k-1].Score) {
			continue
		}
		at := sort.Search(len(top), func(j int) bool { return top[j].Score < score })
		top = append(top, Hit{})
		copy(top[at+1:], top[at:])
		top[at] = Hit{Key: key, Score: score}
		if len(top) > k {
			top = top[:k]
		}
	}
	return top
}

func normalize(v []float32) ([]float32, error) {
	if len(v) == 0 {
		return nil, fmt.Errorf("empty vector")
	}
	var sum float64
	for _, x := range v {
		sum += float64(x) * float64(x)
	}
	if sum == 0 || math.IsNaN(sum) || math.IsInf(sum, 0) {
		return nil, fmt.Errorf("vector has no direction")
	}
	inv := float32(1 / math.Sqrt(sum))
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = x * inv
	}
	return out, nil
}

// dot assumes len(a) == len(b). Four accumulators let the CPU overlap the
// multiply-adds; Go does not vectorise this loop on its own.
func dot(a, b []float32) float32 {
	b = b[:len(a)]
	var s0, s1, s2, s3 float32
	i := 0
	for ; i+4 <= len(a); i += 4 {
		s0 += a[i] * b[i]
		s1 += a[i+1] * b[i+1]
		s2 += a[i+2] * b[i+2]
		s3 += a[i+3] * b[i+3]
	}
	for ; i < len(a); i++ {
		s0 += a[i] * b[i]
	}
	return s0 + s1 + s2 + s3
}
