package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestComplete(t *testing.T) {
	var got struct {
		Model    string
		Messages []struct{ Role, Content string }
	}
	var auth string
	reply := `{"choices":[{"message":{"role":"assistant","content":"{\"pass\":[]}"}}]}`
	status := http.StatusOK
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(status)
		w.Write([]byte(reply))
	}))
	defer ts.Close()

	c := &Chat{URL: ts.URL, ModelName: "local-model", APIKey: "k"}
	out, err := c.Complete(context.Background(), "the rules", "the batch")
	if err != nil || out != `{"pass":[]}` {
		t.Fatalf("reply = %q, %v", out, err)
	}
	if got.Model != "local-model" || len(got.Messages) != 2 || got.Messages[0].Role != "system" || got.Messages[0].Content != "the rules" ||
		got.Messages[1].Role != "user" || got.Messages[1].Content != "the batch" || auth != "Bearer k" || c.Model() != "local-model" {
		t.Errorf("request: %+v, auth %q", got, auth)
	}

	for name, tc := range map[string]struct {
		status int
		reply  string
		want   string
	}{
		"an error status": {http.StatusTooManyRequests, `{"error":"slow down"}`, "429"},
		"no choices":      {http.StatusOK, `{"choices":[]}`, "no reply"},
		"not JSON":        {http.StatusOK, `<html>`, "not JSON"},
	} {
		status, reply = tc.status, tc.reply
		if _, err := c.Complete(context.Background(), "s", "u"); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want one saying %q", name, err, tc.want)
		}
	}
}
