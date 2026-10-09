# Concepts

ai-bdd runs **behavior specs** against a real UI and produces **evidence** for every step.
This page defines the vocabulary; the other pages go deep on one area each.

## The pieces

| Term | Meaning |
| --- | --- |
| Spec | One Gauge markdown file (`*.spec.md`) or one `.feature` file. |
| Scenario | One executable sequence of steps. Each data row / outline row is its own scenario instance. |
| Step | One bullet (`* ...`) or one Gherkin step line, after concept expansion and parameter substitution. |
| Step kind | `setup` (arrange state), `action` (change the UI), `assertion` (check an outcome). |
| Binding | A registered step implementation: a pattern, a natural-language description, a kind, examples and counter-examples, and a function in some language runtime. |
| Binding provider | The runtime that owns binding functions, e.g. `ts:local`, `python:behave`, `java:cucumber-jvm`. |
| Resolution | The decision for a step: `exact`, `semantic`, `agent`, `ambiguous`, or `unbound`. |
| Lockfile | `ai-bdd.lock.json`: the committed record of every non-exact resolution, for PR review. |
| ActProgram | A recorded, replayable sequence of driver actions for an action step, plus an effect signature. |
| CheckProgram | A declarative, driver-evaluated predicate set for an assertion step. Never arbitrary code. |
| Judge | A model call over before/after evidence and the criterion text only. It returns a score and a verdict. |
| Settled | The screen is stable: consecutive observations are identical within tolerance. |
| Evidence | Content-addressed artifacts: screenshots, observations, video, judge request/response, action log, check results. |
| Driver | An adapter that observes and controls one UI surface through a session. |
| Orchestrator / daemon | The long-lived process (`ai-bdd serve`) that owns resolution, execution, caches, the judge and evidence. |
| Plugin | A thin per-language integration that forwards steps to the daemon and executes local bindings. |
| Healed | An action step whose cached replay failed partway and was completed by the agent. Reported distinctly, never as a plain pass. |
| Tainted | An observation captured after a secret was filled. Its pixels are withheld from models. |

## Why the resolution chain looks like this

A naive "AI runs your tests" design fails in three ways: it is slow, it is non-deterministic,
and a confident wrong answer is indistinguishable from a right one. ai-bdd addresses each:

1. **Exact bindings first.** Existing step code keeps working and costs nothing.
2. **Semantic matching with guards.** Embedding similarity alone is not enough: a threshold,
   a top-1/top-2 margin, polarity/quantity/number guards, kind compatibility,
   counter-examples, and deterministic validation of model-extracted parameters.
3. **Agent fallback that caches.** The first run may need the model; the recording is
   replayed and **effect-verified** on later runs, and a replay that diverges is *healed*,
   which is a distinct status in every reporter.
4. **Assertions prefer determinism.** A generated check must be discriminative — true on the
   after state and false on the before state — before it is trusted. The judge is the
   second layer, and it never sees what the acting agent did or thought.

## The invariant that matters most

> A step passes only if every configured layer passes, and no layer may see another layer's
> reasoning.

Concretely: the judge input type (`JudgeRequest`) has no field that can carry an agent
transcript, and a test injects canary tokens into the act transcript to prove the judge
prompt never contains them.

## Next

- [Gauge format](gauge-format.md) · [Gherkin dialect](gherkin-dialect.md) · [Directives](directives.md)
- [Resolution and lockfile review](resolution-and-lockfile.md)
- [Assertions and judge calibration](assertions-and-judge.md)
- [Caching and invalidation](caching.md) · [Evidence and verification](evidence.md)
- [Security model](security.md)
