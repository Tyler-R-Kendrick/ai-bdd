using System.Globalization;
using Reqnroll.Bindings;
using Reqnroll.Infrastructure;

namespace AiBdd.Reqnroll;

/// <summary>
/// Decorates Reqnroll's step definition match service.
///
/// The native match wins whenever there is one, which is the coexistence guarantee
/// of section 12: user bindings keep working unchanged. When there is no match — or
/// when the native candidates are ambiguous — the service hands back this plugin's
/// catch-all binding, which runs the step on the ai-bdd daemon (act loop, checks and
/// judge included) and reports the ai-bdd status. An ai-bdd ambiguity surfaces as a
/// failure whose message carries STEP_AMBIGUOUS rather than as Reqnroll's
/// AmbiguousSteps, because the daemon is the component that owns ambiguity.
/// </summary>
public sealed class AiBddStepDefinitionMatchService : IStepDefinitionMatchService
{
    private readonly IStepDefinitionMatchService? inner;
    private readonly AiBddRuntime runtime;

    public AiBddStepDefinitionMatchService(IStepDefinitionMatchService? inner, AiBddRuntime runtime)
    {
        this.inner = inner;
        this.runtime = runtime;
    }

    /// <inheritdoc />
    public bool Ready => inner?.Ready ?? true;

    public AiBddRuntime Runtime => runtime;

    /// <inheritdoc />
    public BindingMatch GetBestMatch(
        StepInstance stepInstance,
        CultureInfo bindingCulture,
        out StepDefinitionAmbiguityReason ambiguityReason,
        out List<BindingMatch> candidatingMatches)
    {
        ambiguityReason = StepDefinitionAmbiguityReason.None;
        candidatingMatches = new List<BindingMatch>();
        var native = inner?.GetBestMatch(stepInstance, bindingCulture, out ambiguityReason, out candidatingMatches);
        if (native is not null && native.Success)
        {
            return native;
        }

        var stepText = stepInstance.Text ?? string.Empty;
        var type = stepInstance.StepDefinitionType;
        var context = stepInstance.StepContext;
        var binding = new AiBddStepDefinitionBinding(type, runtime);
        ambiguityReason = StepDefinitionAmbiguityReason.None;
        var match = new BindingMatch(binding, 1, new object[] { stepText }, context);
        candidatingMatches = new List<BindingMatch> { match };
        return match;
    }

    /// <inheritdoc />
    public BindingMatch? Match(
        IStepDefinitionBinding stepDefinitionBinding,
        StepInstance stepInstance,
        CultureInfo bindingCulture,
        bool useRegexMatching,
        bool useParamMatching,
        bool useScopeMatching)
    {
        if (stepDefinitionBinding is AiBddStepDefinitionBinding binding)
        {
            var text = stepInstance.Text ?? string.Empty;
            return new BindingMatch(binding, 1, new object[] { text }, stepInstance.StepContext);
        }

        return inner?.Match(stepDefinitionBinding, stepInstance, bindingCulture, useRegexMatching, useParamMatching, useScopeMatching);
    }

}
