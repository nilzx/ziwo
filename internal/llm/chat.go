// Package llm talks to a chat model over an OpenAI-compatible endpoint. Only
// background reflection uses it; nothing on the path of a read or a write does.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Chat is a client for a /v1/chat/completions endpoint.
type Chat struct {
	URL       string // full URL of the endpoint
	ModelName string
	APIKey    string       // sent as a bearer token when set
	Client    *http.Client // default: one with a five-minute timeout
}

// Model returns the name of the model, as it is recorded with what it writes.
func (c *Chat) Model() string { return c.ModelName }

// Complete sends one system and one user message and returns the reply.
func (c *Chat) Complete(ctx context.Context, system, user string) (string, error) {
	type message struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	body, err := json.Marshal(map[string]any{
		"model":    c.ModelName,
		"messages": []message{{"system", system}, {"user", user}},
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("chat endpoint answered %s: %.200s", resp.Status, raw)
	}
	var out struct {
		Choices []struct {
			Message message `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("chat endpoint sent something that is not JSON: %w", err)
	}
	if len(out.Choices) == 0 || out.Choices[0].Message.Content == "" {
		return "", errors.New("chat endpoint sent no reply")
	}
	return out.Choices[0].Message.Content, nil
}
