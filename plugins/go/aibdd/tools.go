package aibdd

import "encoding/json"

// PluginInfo identifies the calling plugin.
type PluginInfo struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	Language string `json:"language"`
}

// ParamDecl declares one binding parameter.
type ParamDecl struct {
	Name       string   `json:"name"`
	Type       string   `json:"type"`
	EnumValues []string `json:"enumValues,omitempty"`
	Derived    bool     `json:"derived,omitempty"`
}

// BindingDescriptor is a binding as the daemon wants it (no hash fields).
type BindingDescriptor struct {
	ID              string      `json:"id"`
	Provider        string      `json:"provider"`
	Pattern         string      `json:"pattern"`
	PatternKind     string      `json:"patternKind"`
	Kind            string      `json:"kind"`
	Description     string      `json:"description,omitempty"`
	Examples        []string    `json:"examples,omitempty"`
	CounterExamples []string    `json:"counterExamples,omitempty"`
	Params          []ParamDecl `json:"params,omitempty"`
}

// OpenSessionInput opens one scenario session.
type OpenSessionInput struct {
	ScenarioID   string     `json:"scenarioId"`
	ScenarioName string     `json:"scenarioName"`
	Tags         []string   `json:"tags"`
	Driver       string     `json:"driver,omitempty"`
	Plugin       PluginInfo `json:"plugin"`
}

// OpenSessionOutput is the opened session.
type OpenSessionOutput struct {
	SessionID string `json:"sessionId"`
	TraceID   string `json:"traceId"`
	Driver    string `json:"driver"`
}

// RegisterBindingsInput publishes a plugin's bindings.
type RegisterBindingsInput struct {
	SessionID string              `json:"sessionId,omitempty"`
	Provider  string              `json:"provider"`
	Bindings  []BindingDescriptor `json:"bindings"`
}

// RegisterBindingsOutput reports what the daemon accepted.
type RegisterBindingsOutput struct {
	BindingSetHash string `json:"bindingSetHash"`
	Accepted       int    `json:"accepted"`
}

// Step is the step payload shared by the resolve and run tools.
type Step struct {
	Text       string          `json:"text"`
	Keyword    string          `json:"keyword,omitempty"`
	Kind       string          `json:"kind,omitempty"`
	StepID     string          `json:"stepId,omitempty"`
	ScenarioID string          `json:"scenarioId,omitempty"`
	Options    json.RawMessage `json:"options,omitempty"`
}

// Resolution is the daemon's decision for a step.
type Resolution struct {
	Type      string          `json:"type"`
	BindingID string          `json:"bindingId,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Score     float64         `json:"score,omitempty"`
	Message   string          `json:"message,omitempty"`
}

// ResolveStepInput asks the daemon to resolve one step.
type ResolveStepInput struct {
	SessionID string `json:"sessionId"`
	Step      Step   `json:"step"`
}

// ResolveStepOutput says what the plugin must do next.
type ResolveStepOutput struct {
	Resolution Resolution `json:"resolution"`
	Kind       string     `json:"kind"`
	KindSource string     `json:"kindSource"`
	Next       string     `json:"next"`
	Error      *Error     `json:"error,omitempty"`
}

// RunStepInput runs one step inside the daemon.
type RunStepInput struct {
	SessionID string `json:"sessionId"`
	Step      Step   `json:"step"`
}

// StepResult is the daemon's per-step outcome.
type StepResult struct {
	StepID     string     `json:"stepId"`
	Text       string     `json:"text"`
	Kind       string     `json:"kind"`
	KindSource string     `json:"kindSource"`
	Status     string     `json:"status"`
	Resolution Resolution `json:"resolution"`
	Error      *Error     `json:"error,omitempty"`
}

// ReportBindingResultInput reports the outcome of a locally executed binding.
type ReportBindingResultInput struct {
	SessionID  string         `json:"sessionId"`
	Step       Step           `json:"step"`
	BindingID  string         `json:"bindingId"`
	Status     string         `json:"status"`
	DurationMS int            `json:"durationMs"`
	Error      map[string]any `json:"error,omitempty"`
}

// CloseSessionInput closes a session with the scenario's status.
type CloseSessionInput struct {
	SessionID string `json:"sessionId"`
	Status    string `json:"status"`
}

// CloseSessionOutput carries the scenario result.
type CloseSessionOutput struct {
	ScenarioResult struct {
		Status string `json:"status"`
	} `json:"scenarioResult"`
}
