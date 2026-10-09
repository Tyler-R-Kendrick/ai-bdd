// Package godogbdd is the ai-bdd plugin for godog.
//
// Minimum glue: one line at the end of InitializeScenario.
//
//	func InitializeScenario(sc *godog.ScenarioContext) {
//		godogbdd.Register(sc)
//	}
//
// godog matches steps in registration order and, in non-strict mode, the first
// match wins, so the catch-all is registered by Register and your own
// sc.Step(...) calls made *before* it keep winning. In Strict mode godog turns
// multiple matches into ErrAmbiguous, so every binding must go through
// BindStep, which registers against the ai-bdd daemon instead of godog.
package godogbdd

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/cucumber/godog"

	"github.com/ai-bdd/ai-bdd-go/aibdd"
)

// Plugin identifies this integration to the daemon.
var Plugin = aibdd.PluginInfo{Name: "ai-bdd-go/godogbdd", Version: "0.1.0", Language: "go"}

// Provider is the binding provider name reported to the daemon.
const Provider = "go:godog"

// StepFunc is a Go step function. The context carries the scenario state.
type StepFunc = aibdd.StepFunction

// StepOptions carries the semantics the resolver needs.
type StepOptions = aibdd.StepOptions

type stateKey struct{}

type scenarioState struct {
	client  *aibdd.Client
	local   *aibdd.LocalBindings
	session string
	healed  []string
}

var errNoState = errors.New("ai-bdd: no scenario state; call godogbdd.Register in InitializeScenario")

// Register installs the catch-all step plus the session hooks.
//
// Call it **last** in InitializeScenario so that ctx.Step registrations made by
// the project win in non-strict mode.
func Register(sc *godog.ScenarioContext) {
	sc.Before(func(ctx context.Context, scenario *godog.Scenario) (context.Context, error) {
		local := aibdd.NewLocalBindings(Provider)
		state := &scenarioState{client: aibdd.NewClient(""), local: local}
		for _, registration := range pending(sc) {
			local.Add(registration.pattern, registration.fn, registration.options)
		}
		if err := state.open(scenario.Name, tagsOf(scenario)); err != nil {
			return ctx, err
		}
		return context.WithValue(ctx, stateKey{}, state), nil
	})

	sc.After(func(ctx context.Context, scenario *godog.Scenario, scenarioErr error) (context.Context, error) {
		state, err := lookup(ctx)
		if err != nil {
			return ctx, scenarioErr
		}
		status := "passed"
		if scenarioErr != nil {
			status = "failed"
		}
		if closeErr := state.close(status); closeErr != nil && scenarioErr == nil {
			return ctx, closeErr
		}
		return ctx, scenarioErr
	})

	sc.Step("^(.*)$", func(ctx context.Context, text string) error {
		state, err := lookup(ctx)
		if err != nil {
			return err
		}
		return state.run(text, ctx)
	})
}

// BindStep publishes a Go step to the daemon. Use it instead of sc.Step in
// strict mode, or when you want semantic matching to target the step.
func BindStep(sc *godog.ScenarioContext, pattern string, options StepOptions, fn StepFunc) {
	if options.Kind == "" {
		options.Kind = "action"
	}
	pendingByScenario[sc] = append(pendingByScenario[sc], registration{pattern: pattern, options: options, fn: fn})
}

// Bind is BindStep with only a description.
func Bind(sc *godog.ScenarioContext, pattern string, description string, fn StepFunc) {
	BindStep(sc, pattern, StepOptions{Description: description}, fn)
}

// Healed lists the steps this scenario's agent completed after a cache divergence.
func Healed(ctx context.Context) []string {
	state, err := lookup(ctx)
	if err != nil {
		return nil
	}
	return state.healed
}

type registration struct {
	pattern string
	options StepOptions
	fn      StepFunc
}

var pendingByScenario = map[*godog.ScenarioContext][]registration{}

func pending(sc *godog.ScenarioContext) []registration { return pendingByScenario[sc] }

func lookup(ctx context.Context) (*scenarioState, error) {
	state, ok := ctx.Value(stateKey{}).(*scenarioState)
	if !ok {
		return nil, errNoState
	}
	return state, nil
}

func (s *scenarioState) open(name string, tags []string) error {
	opened := aibdd.OpenSessionOutput{}
	if err := s.client.Call("open_session", aibdd.OpenSessionInput{
		ScenarioID:   fmt.Sprintf("godog#%s", name),
		ScenarioName: name,
		Tags:         tags,
		Plugin:       Plugin,
	}, &opened); err != nil {
		return err
	}
	s.session = opened.SessionID
	if descriptors := s.local.Publish(); len(descriptors) > 0 {
		return s.client.Call("register_bindings", aibdd.RegisterBindingsInput{
			SessionID: s.session,
			Provider:  Provider,
			Bindings:  descriptors,
		}, nil)
	}
	return nil
}

func (s *scenarioState) close(status string) error {
	if s.session == "" {
		return nil
	}
	err := s.client.Call("close_session", aibdd.CloseSessionInput{SessionID: s.session, Status: status}, nil)
	s.session = ""
	return err
}

func (s *scenarioState) run(text string, ctx context.Context) error {
	resolved := aibdd.ResolveStepOutput{}
	if err := s.client.Call("resolve_step", aibdd.ResolveStepInput{SessionID: s.session, Step: aibdd.Step{Text: text}}, &resolved); err != nil {
		return err
	}
	if resolved.Next == "fail" {
		return failure(text, &resolved)
	}

	if resolved.Next == "invoke-local" && (resolved.Resolution.Type == "exact" || resolved.Resolution.Type == "semantic") {
		fn, ok := s.local.Find(resolved.Resolution.BindingID)
		params := s.local.Capture(resolved.Resolution.BindingID, text)
		if !ok {
			var located bool
			fn, params, located = s.local.Locate(text)
			if !located {
				return fmt.Errorf("the plugin has no function for %s", resolved.Resolution.BindingID)
			}
		}
		started := time.Now()
		status := "passed"
		var detail map[string]any
		if err := fn(ctx, params); err != nil {
			status = "failed"
			detail = map[string]any{"message": err.Error()}
		}
		return s.client.Call("report_binding_result", aibdd.ReportBindingResultInput{
			SessionID:  s.session,
			Step:       aibdd.Step{Text: text},
			BindingID:  resolved.Resolution.BindingID,
			Status:     status,
			DurationMS: int(time.Since(started).Milliseconds()),
			Error:      detail,
		}, nil)
	}

	result := aibdd.StepResult{}
	if err := s.client.Call("run_step", aibdd.RunStepInput{SessionID: s.session, Step: aibdd.Step{Text: text}}, &result); err != nil {
		return err
	}
	switch result.Status {
	case "passed":
		return nil
	case "healed":
		// A heal is a pass here; the ai-bdd reporters still show `healed` (R-K22).
		s.healed = append(s.healed, text)
		return nil
	default:
		code, message := result.Status, text
		if result.Error != nil {
			code, message = result.Error.Code, result.Error.Message
		}
		return fmt.Errorf("%s: %s", code, message)
	}
}

func failure(text string, resolved *aibdd.ResolveStepOutput) error {
	code, message := "FAILED", text
	if resolved.Error != nil {
		code, message = resolved.Error.Code, resolved.Error.Message
	} else {
		switch resolved.Resolution.Type {
		case "ambiguous":
			code, message = "STEP_AMBIGUOUS", resolved.Resolution.Message
		case "unbound":
			code, message = "SETUP_UNBOUND", resolved.Resolution.Message
		}
	}
	return fmt.Errorf("%s: %s", code, message)
}

func tagsOf(scenario *godog.Scenario) []string {
	tags := make([]string, 0, len(scenario.Tags))
	for _, tag := range scenario.Tags {
		tags = append(tags, tag.Name)
	}
	return tags
}
