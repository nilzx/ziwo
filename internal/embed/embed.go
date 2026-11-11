// Package embed turns text into vectors by calling an embedding server.
package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Kind says what a text is for. Many embedding models expect queries and the
// passages they are matched against to be marked differently.
type Kind int

const (
	Passage Kind = iota
	Query
)

// Embedder turns texts into vectors.
type Embedder interface {
	// Model names the embedding model. Vectors from different models are
	// never compared with each other.
	Model() string
	// Embed returns one vector per text, in order.
	Embed(ctx context.Context, kind Kind, texts []string) ([][]float32, error)
}

// HTTP calls an OpenAI-compatible embeddings endpoint, which is what
// llama.cpp's server, Ollama, vLLM and others expose.
type HTTP struct {
	URL           string // full endpoint, e.g. http://127.0.0.1:8080/v1/embeddings
	ModelName     string
	APIKey        string // optional
	QueryPrefix   string // prepended to queries, e.g. "query: "
	PassagePrefix string // prepended to stored text, e.g. "passage: "
	Client        *http.Client
}

var defaultClient = &http.Client{Timeout: 60 * time.Second}

func (h *HTTP) Model() string { return h.ModelName }

func (h *HTTP) Embed(ctx context.Context, kind Kind, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	prefix := h.PassagePrefix
	if kind == Query {
		prefix = h.QueryPrefix
	}
	input := make([]string, len(texts))
	for i, t := range texts {
		input[i] = prefix + t
	}
	body, err := json.Marshal(struct {
		Model string   `json:"model"`
		Input []string `json:"input"`
	}{h.ModelName, input})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if h.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+h.APIKey)
	}
	client := h.Client
	if client == nil {
		client = defaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embedding request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("embedding server answered %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	var out struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("embedding response: %w", err)
	}
	if len(out.Data) != len(texts) {
		return nil, fmt.Errorf("embedding server returned %d vectors for %d texts", len(out.Data), len(texts))
	}
	vecs := make([][]float32, len(texts))
	for _, d := range out.Data {
		if d.Index < 0 || d.Index >= len(vecs) || vecs[d.Index] != nil {
			return nil, fmt.Errorf("embedding server returned a bad index %d", d.Index)
		}
		if len(d.Embedding) == 0 || len(d.Embedding) != len(out.Data[0].Embedding) {
			return nil, fmt.Errorf("embedding server returned vectors of uneven length")
		}
		vecs[d.Index] = d.Embedding
	}
	return vecs, nil
}
