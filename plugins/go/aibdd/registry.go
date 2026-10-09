package aibdd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// StepFunction is a local step implementation.
//
// The first parameter is the step context (godog passes its `context.Context`),
// which keeps the table usable by every Go integration.
type StepFunction func(ctx context.Context, params map[string]string) error

// StepOptions carries the semantics the resolver needs.
type StepOptions struct {
	Description     string
	Examples        []string
	CounterExamples []string
	Kind            string
	Params          []ParamDecl
}

// LocalBindings holds the step functions this process owns.
//
// The daemon decides which binding wins; only the plugin can call the function.
type LocalBindings struct {
	mu       sync.Mutex
	provider string
	entries  []bindingEntry
}

type bindingEntry struct {
	descriptor BindingDescriptor
	function   StepFunction
	regexp     *regexp.Regexp
}

// NewLocalBindings creates an empty table for one provider.
func NewLocalBindings(provider string) *LocalBindings {
	if provider == "" {
		provider = "go:godog"
	}
	return &LocalBindings{provider: provider}
}

// Add registers one step. The pattern is a Cucumber Expression or an anchored regexp.
func (b *LocalBindings) Add(pattern string, fn StepFunction, options StepOptions) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	kind := options.Kind
	if kind == "" {
		kind = "action"
	}
	descriptor := BindingDescriptor{
		ID:              fmt.Sprintf("%s#%s-%d", b.provider, slug(pattern), len(b.entries)+1),
		Provider:        b.provider,
		Pattern:         pattern,
		PatternKind:     "cucumber-expression",
		Kind:            kind,
		Description:     options.Description,
		Examples:        options.Examples,
		CounterExamples: options.CounterExamples,
		Params:          options.Params,
	}
	b.entries = append(b.entries, bindingEntry{descriptor: descriptor, function: fn, regexp: compile(pattern)})
	return descriptor.ID
}

// Publish returns the descriptors the daemon should know about.
func (b *LocalBindings) Publish() []BindingDescriptor {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]BindingDescriptor, 0, len(b.entries))
	for _, entry := range b.entries {
		out = append(out, entry.descriptor)
	}
	return out
}

// Find returns the function registered for a binding id.
func (b *LocalBindings) Find(id string) (StepFunction, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, entry := range b.entries {
		if entry.descriptor.ID == id {
			return entry.function, true
		}
	}
	return nil, false
}

// FindForStep returns this table's own function for a step text.
//
// The daemon may name a binding from another provider; a plugin only ever runs
// functions it owns, so the sentence is matched against the local patterns.
func (b *LocalBindings) FindForStep(text string) (StepFunction, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, entry := range b.entries {
		if entry.regexp != nil && entry.regexp.MatchString(text) {
			return entry.function, true
		}
	}
	return nil, false
}

// Locate finds this table's own binding for a step text and returns its function
// with the captured parameters.
//
// It is the fallback for a daemon answer that names a binding from another
// provider: a plugin only ever runs functions it owns, so the sentence decides.
func (b *LocalBindings) Locate(text string) (StepFunction, map[string]string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, entry := range b.entries {
		if entry.regexp == nil {
			continue
		}
		matches := entry.regexp.FindStringSubmatch(text)
		if matches == nil {
			continue
		}
		params := map[string]string{}
		for index, name := range parameterNames(entry.descriptor.Pattern) {
			if index+1 < len(matches) {
				params[name] = matches[index+1]
			}
		}
		return entry.function, params, true
	}
	return nil, nil, false
}

// Fingerprint is a stable hash of the published set, used in tests.
func (b *LocalBindings) Fingerprint() string {
	hash := sha256.New()
	for _, descriptor := range b.Publish() {
		hash.Write([]byte(descriptor.ID))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

var parameterPattern = regexp.MustCompile(`\{([a-zA-Z0-9_]+)\}`)

// compile turns a Cucumber Expression (or an anchored regexp) into a matcher.
// Parameter placeholders become lazy capturing groups so several placeholders in
// one sentence still split correctly.
func compile(pattern string) *regexp.Regexp {
	if strings.HasPrefix(pattern, "^") && strings.HasSuffix(pattern, "$") {
		if compiled, err := regexp.Compile(pattern); err == nil {
			return compiled
		}
		return nil
	}

	var builder strings.Builder
	builder.WriteString("^")
	index := 0
	for _, match := range parameterPattern.FindAllStringSubmatchIndex(pattern, -1) {
		builder.WriteString(regexp.QuoteMeta(pattern[index:match[0]]))
		switch pattern[match[2]:match[3]] {
		case "int":
			builder.WriteString(`(-?\d+)`)
		case "float":
			builder.WriteString(`(-?\d+(?:\.\d+)?)`)
		case "word":
			builder.WriteString(`(\w+)`)
		default:
			builder.WriteString(`(.*?)`)
		}
		index = match[1]
	}
	builder.WriteString(regexp.QuoteMeta(pattern[index:]))
	builder.WriteString("$")
	compiled, err := regexp.Compile(builder.String())
	if err != nil {
		return nil
	}
	return compiled
}

func slug(pattern string) string {
	cleaned := regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(pattern), "-")
	cleaned = strings.Trim(cleaned, "-")
	if len(cleaned) > 40 {
		cleaned = cleaned[:40]
	}
	if cleaned == "" {
		cleaned = "step"
	}
	return cleaned
}

// Capture returns the parameters a compiled pattern captured, in order.
func (b *LocalBindings) Capture(id string, text string) map[string]string {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, entry := range b.entries {
		if entry.descriptor.ID != id || entry.regexp == nil {
			continue
		}
		matches := entry.regexp.FindStringSubmatch(text)
		params := map[string]string{}
		names := parameterNames(entry.descriptor.Pattern)
		for index, name := range names {
			if index+1 < len(matches) {
				params[name] = matches[index+1]
			}
		}
		return params
	}
	return map[string]string{}
}

func parameterNames(pattern string) []string {
	matches := parameterPattern.FindAllStringSubmatch(pattern, -1)
	names := make([]string, 0, len(matches))
	for _, match := range matches {
		names = append(names, match[1])
	}
	return names
}
