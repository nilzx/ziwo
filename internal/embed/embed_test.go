package embed

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestHTTPEmbed(t *testing.T) {
	var gotAuth string
	var gotBody struct {
		Model string   `json:"model"`
		Input []string `json:"input"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode request: %v", err)
		}
		// Answer out of order: the index field is what counts.
		w.Write([]byte(`{"data":[{"index":1,"embedding":[3,4]},{"index":0,"embedding":[1,2]}]}`))
	}))
	defer srv.Close()

	h := &HTTP{URL: srv.URL, ModelName: "m", APIKey: "k", QueryPrefix: "query: ", PassagePrefix: "passage: "}
	vecs, err := h.Embed(context.Background(), Passage, []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if want := [][]float32{{1, 2}, {3, 4}}; !reflect.DeepEqual(vecs, want) {
		t.Errorf("vectors = %v, want %v", vecs, want)
	}
	if gotAuth != "Bearer k" || gotBody.Model != "m" {
		t.Errorf("auth = %q, model = %q", gotAuth, gotBody.Model)
	}
	if want := []string{"passage: a", "passage: b"}; !reflect.DeepEqual(gotBody.Input, want) {
		t.Errorf("input = %v, want %v", gotBody.Input, want)
	}

	if _, err := h.Embed(context.Background(), Query, []string{"a", "b"}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"query: a", "query: b"}; !reflect.DeepEqual(gotBody.Input, want) {
		t.Errorf("query input = %v, want %v", gotBody.Input, want)
	}
}

func TestHTTPEmbedRejectsBadAnswers(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
		want   string
	}{
		"server error":   {500, `model not loaded`, "model not loaded"},
		"too few":        {200, `{"data":[{"index":0,"embedding":[1]}]}`, "1 vectors for 2 texts"},
		"repeated index": {200, `{"data":[{"index":0,"embedding":[1]},{"index":0,"embedding":[2]}]}`, "bad index"},
		"uneven":         {200, `{"data":[{"index":0,"embedding":[1]},{"index":1,"embedding":[1,2]}]}`, "uneven"},
		"empty":          {200, `{"data":[{"index":0,"embedding":[]},{"index":1,"embedding":[]}]}`, "uneven"},
		"not json":       {200, `<html>`, "embedding response"},
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			_, err := (&HTTP{URL: srv.URL, ModelName: "m"}).Embed(context.Background(), Passage, []string{"a", "b"})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}
