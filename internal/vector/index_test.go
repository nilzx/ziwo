package vector

import (
	"math/rand"
	"testing"
)

func TestSearchRanksByCosine(t *testing.T) {
	ix := New()
	add := func(key int64, v ...float32) {
		t.Helper()
		if err := ix.Add(key, v); err != nil {
			t.Fatalf("add %d: %v", key, err)
		}
	}
	add(1, 1, 0, 0)
	add(2, 0, 5, 0)     // length must not matter
	add(3, 0.9, 0.1, 0) // close to 1
	add(4, -1, 0, 0)    // opposite

	hits := ix.Search([]float32{2, 0, 0}, 10, 0)
	if len(hits) != 3 || hits[0].Key != 1 || hits[1].Key != 3 || hits[2].Key != 2 {
		t.Fatalf("hits = %+v, want keys 1, 3, 2", hits)
	}
	if hits[0].Score < 0.999 || hits[0].Score > 1.001 {
		t.Errorf("identical direction scored %v, want 1", hits[0].Score)
	}

	if hits := ix.Search([]float32{1, 0, 0}, 1, 0); len(hits) != 1 || hits[0].Key != 1 {
		t.Errorf("k=1: %+v", hits)
	}
	if hits := ix.Search([]float32{1, 0, 0}, 10, 0.95); len(hits) != 2 {
		t.Errorf("min 0.95: %+v, want keys 1 and 3", hits)
	}
}

func TestAddReplacesAndChecksShape(t *testing.T) {
	ix := New()
	if err := ix.Add(1, []float32{1, 0}); err != nil {
		t.Fatal(err)
	}
	if err := ix.Add(1, []float32{0, 1}); err != nil {
		t.Fatal(err)
	}
	if ix.Len() != 1 {
		t.Fatalf("len = %d, want 1", ix.Len())
	}
	if hits := ix.Search([]float32{0, 1}, 1, 0.9); len(hits) != 1 {
		t.Errorf("replaced vector not found: %+v", hits)
	}
	if err := ix.Add(2, []float32{1, 0, 0}); err == nil {
		t.Error("added a vector of the wrong dimension")
	}
	if err := ix.Add(3, []float32{0, 0}); err == nil {
		t.Error("added a zero vector")
	}
	if err := ix.Add(4, nil); err == nil {
		t.Error("added an empty vector")
	}
	if hits := ix.Search([]float32{1, 0, 0}, 5, 0); hits != nil {
		t.Errorf("query of the wrong dimension matched %+v", hits)
	}
	if hits := New().Search([]float32{1}, 5, 0); hits != nil {
		t.Errorf("empty index matched %+v", hits)
	}
}

func TestSearchAgreesWithBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	const n, dim, k = 500, 37, 7
	ix := New()
	vecs := make([][]float32, n)
	for i := range vecs {
		vecs[i] = randVec(rng, dim)
		if err := ix.Add(int64(i), vecs[i]); err != nil {
			t.Fatal(err)
		}
	}
	q := randVec(rng, dim)
	qn, _ := normalize(q)

	best := make([]Hit, 0, n)
	for i, v := range vecs {
		vn, _ := normalize(v)
		var s float32
		for j := range vn {
			s += qn[j] * vn[j]
		}
		best = append(best, Hit{Key: int64(i), Score: s})
	}
	for i := 0; i < k; i++ { // selection sort of the top k
		for j := i + 1; j < n; j++ {
			if best[j].Score > best[i].Score {
				best[i], best[j] = best[j], best[i]
			}
		}
	}
	hits := ix.Search(q, k, -1)
	if len(hits) != k {
		t.Fatalf("got %d hits, want %d", len(hits), k)
	}
	for i := range hits {
		if hits[i].Key != best[i].Key {
			t.Errorf("rank %d: key %d, want %d", i, hits[i].Key, best[i].Key)
		}
	}
}

func randVec(rng *rand.Rand, dim int) []float32 {
	v := make([]float32, dim)
	for i := range v {
		v[i] = float32(rng.NormFloat64())
	}
	return v
}

func benchmarkSearch(b *testing.B, n, dim int) {
	rng := rand.New(rand.NewSource(1))
	ix := New()
	for i := 0; i < n; i++ {
		if err := ix.Add(int64(i), randVec(rng, dim)); err != nil {
			b.Fatal(err)
		}
	}
	q := randVec(rng, dim)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ix.Search(q, 20, 0.35)
	}
}

func BenchmarkSearch1k(b *testing.B)   { benchmarkSearch(b, 1_000, 1024) }
func BenchmarkSearch10k(b *testing.B)  { benchmarkSearch(b, 10_000, 1024) }
func BenchmarkSearch100k(b *testing.B) { benchmarkSearch(b, 100_000, 1024) }

func TestRemove(t *testing.T) {
	ix := New()
	for key, v := range map[int64][]float32{1: {1, 0, 0}, 2: {0, 1, 0}, 3: {0, 0, 1}} {
		if err := ix.Add(key, v); err != nil {
			t.Fatal(err)
		}
	}
	ix.Remove(1)
	ix.Remove(1)  // already gone
	ix.Remove(99) // never there
	if ix.Len() != 2 {
		t.Fatalf("len = %d, want 2", ix.Len())
	}
	if hits := ix.Search([]float32{1, 0, 0}, 3, 0.5); len(hits) != 0 {
		t.Errorf("removed vector still found: %+v", hits)
	}
	// The vectors that stayed are still under their own keys.
	for key, q := range map[int64][]float32{2: {0, 1, 0}, 3: {0, 0, 1}} {
		if hits := ix.Search(q, 3, 0.5); len(hits) != 1 || hits[0].Key != key {
			t.Errorf("after a removal, key %d: %+v", key, hits)
		}
	}
	ix.Remove(3)
	ix.Remove(2)
	if ix.Len() != 0 || len(ix.Search([]float32{0, 1, 0}, 3, 0)) != 0 {
		t.Errorf("index not empty after removing everything")
	}
	if err := ix.Add(4, []float32{0, 1, 0}); err != nil {
		t.Errorf("add after emptying: %v", err)
	}
}
