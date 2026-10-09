package godogbdd_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cucumber/godog"

	"github.com/ai-bdd/ai-bdd-go/aibdd"
	"github.com/ai-bdd/ai-bdd-go/godogbdd"
)

// repoRoot walks up until the monorepo root is found.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find the repository root")
		}
		dir = parent
	}
}

// scriptedDaemon starts `ai-bdd serve --fake-script` for the whole test binary.
func scriptedDaemon(t *testing.T) (url string, token string) {
	t.Helper()
	root := repoRoot(t)
	cli := filepath.Join(root, "packages", "cli", "dist", "bin.js")
	if _, err := os.Stat(cli); err != nil {
		t.Skipf("the CLI is not built: %v", err)
	}
	project := t.TempDir()
	command := exec.Command("node", cli, "serve", "--fake-script", "--port", "0") // #nosec G204 - fixed argv
	command.Dir = project
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		t.Fatalf("could not start the scripted daemon: %v", err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
	})

	daemonFile := filepath.Join(project, ".ai-bdd", "daemon.json")
	for attempt := 0; attempt < 100; attempt++ {
		if raw, err := os.ReadFile(daemonFile); err == nil {
			var payload struct {
				URL   string `json:"url"`
				Token string `json:"token"`
			}
			if err := json.Unmarshal(raw, &payload); err == nil && payload.URL != "" {
				return payload.URL, payload.Token
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("the scripted daemon never wrote daemon.json: %s", output.String())
	return "", ""
}

type expectedCase struct {
	Feature string `json:"feature"`
	Steps   []struct {
		Text       string `json:"text"`
		Status     string `json:"status"`
		ErrorCode  string `json:"errorCode"`
		Resolution string `json:"resolution"`
	} `json:"steps"`
}

type cucumberReport []struct {
	Elements []struct {
		Steps []struct {
			Result struct {
				Status string `json:"status"`
			} `json:"result"`
		} `json:"steps"`
	} `json:"elements"`
}

func TestPluginConformance(t *testing.T) {
	root := repoRoot(t)
	kit := filepath.Join(root, "packages", "conformance", "plugin")
	url, token := scriptedDaemon(t)
	// The plugin discovers the daemon through the environment or daemon.json.
	t.Setenv("AI_BDD_DAEMON_URL", url)
	t.Setenv("AI_BDD_DAEMON_TOKEN", token)

	// The alias file carries a `_comment` string next to the alias arrays.
	aliases := map[string][]string{}
	if raw, err := os.ReadFile(filepath.Join(kit, "status-aliases.json")); err == nil {
		var document map[string]json.RawMessage
		if err := json.Unmarshal(raw, &document); err != nil {
			t.Fatalf("status-aliases.json is not readable: %v", err)
		}
		for key, value := range document {
			if strings.HasPrefix(key, "_") {
				continue
			}
			var list []string
			if err := json.Unmarshal(value, &list); err != nil {
				t.Fatalf("status-aliases.json[%s] is not a list: %v", key, err)
			}
			aliases[key] = list
		}
	}

	entries, err := os.ReadDir(filepath.Join(kit, "expected"))
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		t.Fatal("the kit has no expected results")
	}

	for _, name := range names {
		name := name
		t.Run(strings.TrimSuffix(name, ".json"), func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(kit, "expected", name))
			if err != nil {
				t.Fatal(err)
			}
			var expected expectedCase
			if err := json.Unmarshal(raw, &expected); err != nil {
				t.Fatal(err)
			}

			feature := filepath.Join(kit, "features", expected.Feature)
			var report bytes.Buffer
			suite := godog.TestSuite{
				Name: "ai-bdd plugin conformance",
				ScenarioInitializer: func(sc *godog.ScenarioContext) {
					registerUserSteps(sc)
					godogbdd.Register(sc)
				},
				Options: &godog.Options{
					Paths:    []string{feature},
					Format:   "cucumber",
					Output: &report,
					// No TestingT: the kit contains intentionally failing scenarios, and the
					// assertion below is about the reported status, not go test's verdict.
					Strict: false,
				},
			}
			suite.Run()

			statuses, err := parseStatuses(report.Bytes())
			if err != nil {
				t.Fatalf("could not parse the cucumber report: %v\n%s", err, report.String())
			}
			if len(statuses) != len(expected.Steps) {
				t.Fatalf("expected %d step(s), godog reported %d: %v", len(expected.Steps), len(statuses), statuses)
			}
			for index, step := range expected.Steps {
				got := statuses[index]
				if !statusMatches(step.Status, got, aliases) {
					t.Errorf("step %d: expected %s, godog reported %s", index, step.Status, got)
				}
			}
		})
	}
}

func parseStatuses(raw []byte) ([]string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("the report is empty")
	}
	var report cucumberReport
	if err := json.Unmarshal(trimmed, &report); err != nil {
		// godog may emit one JSON document per feature.
		var single struct {
			Elements []struct {
				Steps []struct {
					Result struct {
						Status string `json:"status"`
					} `json:"result"`
				} `json:"steps"`
			} `json:"elements"`
		}
		if err := json.Unmarshal(trimmed, &single); err != nil {
			return nil, err
		}
		report = cucumberReport{single}
	}
	statuses := []string{}
	for _, feature := range report {
		for _, element := range feature.Elements {
			for _, step := range element.Steps {
				statuses = append(statuses, step.Result.Status)
			}
		}
	}
	return statuses, nil
}

func statusMatches(want string, got string, aliases map[string][]string) bool {
	if want == got {
		return true
	}
	for _, candidate := range aliases[want] {
		if candidate == got {
			return true
		}
	}
	return false
}

// registerUserSteps registers the project's own steps for the kit sentences.
func registerUserSteps(sc *godog.ScenarioContext) {
	godogbdd.BindStep(sc, `Seed a workspace {string} on the {string} plan`, aibdd.StepOptions{
		Description: "Seeds a workspace with a name and a plan tier",
		Kind:        "setup",
	}, func(_ context.Context, params map[string]string) error {
		if params["string"] == "" {
			return fmt.Errorf("the seed step needs a name")
		}
		return nil
	})
	godogbdd.BindStep(sc, `there's a free-tier workspace called {word}`, aibdd.StepOptions{
		Description: "Seeds a workspace with a name and a plan tier",
		Kind:        "setup",
	}, func(_ context.Context, _ map[string]string) error { return nil })
	godogbdd.BindStep(sc, `Seed invoices from the table`, aibdd.StepOptions{Description: "Seeds the invoices listed in the step table"}, func(_ context.Context, _ map[string]string) error { return nil })
	godogbdd.BindStep(sc, `Seed a workspace from a document`, aibdd.StepOptions{Description: "Seeds a workspace from a docstring"}, func(_ context.Context, _ map[string]string) error { return nil })
}
