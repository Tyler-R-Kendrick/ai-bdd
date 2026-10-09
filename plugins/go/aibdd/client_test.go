package aibdd_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/ai-bdd/ai-bdd-go/aibdd"
)

func TestClientReportsAMissingDaemon(t *testing.T) {
	client := aibdd.NewClient(t.TempDir())
	if client.Available() {
		t.Fatal("a fresh directory must not report an available daemon")
	}
	err := client.Call("health", map[string]any{}, nil)
	var daemonErr *aibdd.Error
	if !asError(err, &daemonErr) || daemonErr.Code != "DAEMON_UNAUTHORIZED" {
		t.Fatalf("expected DAEMON_UNAUTHORIZED, got %v", err)
	}
}

func TestClientReadsDaemonJSON(t *testing.T) {
	dir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/health" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("authorization") != "Bearer token-from-file" {
			t.Errorf("missing bearer token: %q", r.Header.Get("authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "protocol": 1})
	}))
	defer server.Close()

	if err := os.MkdirAll(filepath.Join(dir, ".ai-bdd"), 0o755); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]string{"url": server.URL, "token": "token-from-file"})
	if err := os.WriteFile(filepath.Join(dir, ".ai-bdd", "daemon.json"), payload, 0o600); err != nil {
		t.Fatal(err)
	}

	client := aibdd.NewClient(dir)
	if !client.Available() {
		t.Fatal("daemon.json should make the daemon available")
	}
	var health struct {
		OK       bool `json:"ok"`
		Protocol int  `json:"protocol"`
	}
	if err := client.Call("health", map[string]any{}, &health); err != nil {
		t.Fatal(err)
	}
	if !health.OK || health.Protocol != 1 {
		t.Fatalf("unexpected health payload: %+v", health)
	}
}

func TestClientSurfacesTheErrorPayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": "NO_SESSION", "message": "unknown session", "retryable": false},
		})
	}))
	defer server.Close()

	client := aibdd.NewClient(t.TempDir())
	client.SetConnection(server.URL, "token")
	err := client.Call("resolve_step", map[string]any{}, nil)
	var daemonErr *aibdd.Error
	if !asError(err, &daemonErr) || daemonErr.Code != "NO_SESSION" {
		t.Fatalf("expected NO_SESSION, got %v", err)
	}
}

func TestRegistryPublishesAndMatches(t *testing.T) {
	bindings := aibdd.NewLocalBindings("go:test")
	called := 0
	id := bindings.Add("Seed a workspace {string} on the {string} plan", func(_ context.Context, params map[string]string) error {
		called++
		return nil
	}, aibdd.StepOptions{Description: "Seeds a workspace", Kind: "setup"})

	published := bindings.Publish()
	if len(published) != 1 || published[0].Kind != "setup" || published[0].Description != "Seeds a workspace" {
		t.Fatalf("unexpected descriptor: %+v", published)
	}
	if published[0].ID != id {
		t.Fatalf("descriptor id mismatch: %s != %s", published[0].ID, id)
	}

	function, ok := bindings.FindForStep(`Seed a workspace "Acme" on the "free" plan`)
	if !ok {
		t.Fatal("the pattern should match the step text")
	}
	if err := function(nil, map[string]string{}); err != nil {
		t.Fatal(err)
	}
	if called != 1 {
		t.Fatalf("the function ran %d times", called)
	}

	params := bindings.Capture(id, `Seed a workspace "Acme" on the "free" plan`)
	if params["string"] == "" {
		t.Fatalf("expected captured parameters, got %+v", params)
	}
	if bindings.Fingerprint() == "" {
		t.Fatal("the fingerprint should be stable and non-empty")
	}
}

// asError is errors.As without the import noise at every call site.
func asError(err error, target **aibdd.Error) bool {
	if err == nil {
		return false
	}
	if typed, ok := err.(*aibdd.Error); ok {
		*target = typed
		return true
	}
	return false
}
