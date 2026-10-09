using System.Globalization;
using Reqnroll.Bindings;
using Reqnroll.Infrastructure;
using Xunit;

namespace AiBdd.Reqnroll.Tests;

public class AiBddMatchServiceTests
{
    private sealed class StubInner : IStepDefinitionMatchService
    {
        private readonly BindingMatch? match;

        public StubInner(BindingMatch? match) => this.match = match;

        public bool Ready => true;

        public int Calls { get; private set; }

        public BindingMatch GetBestMatch(
            StepInstance stepInstance,
            CultureInfo bindingCulture,
            out StepDefinitionAmbiguityReason ambiguityReason,
            out List<BindingMatch> candidatingMatches)
        {
            Calls++;
            ambiguityReason = match is null ? StepDefinitionAmbiguityReason.None : StepDefinitionAmbiguityReason.AmbiguousScopes;
            candidatingMatches = new List<BindingMatch>();
            return match!;
        }

        public BindingMatch? Match(
            IStepDefinitionBinding stepDefinitionBinding,
            StepInstance stepInstance,
            CultureInfo bindingCulture,
            bool useRegexMatching,
            bool useParamMatching,
            bool useScopeMatching) => null;
    }

    private static StepInstance Step(string text) => new(
        StepDefinitionType.When,
        StepDefinitionKeyword.When,
        "When ",
        text,
        new StepContext("Feature", "Scenario", Array.Empty<string>(), CultureInfo.InvariantCulture));

    [Fact]
    public void FallsBackToTheCatchAllWhenNoNativeBindingMatches()
    {
        var service = new AiBddStepDefinitionMatchService(new StubInner(null), new AiBddRuntime());
        var match = service.GetBestMatch(
            Step("Open billing settings"),
            CultureInfo.InvariantCulture,
            out var ambiguity,
            out var candidates);

        Assert.IsType<AiBddStepDefinitionBinding>(match.StepBinding);
        Assert.Equal(AiBddStepDefinitionBinding.CatchAllSource, match.StepBinding.SourceExpression);
        Assert.Equal(StepDefinitionAmbiguityReason.None, ambiguity);
        Assert.Single(candidates);
        Assert.Equal("Open billing settings", match.Arguments[0]);
    }

    [Fact]
    public void NeverShadowsANativeBinding()
    {
        var native = new AiBddStepDefinitionBinding(StepDefinitionType.When, new AiBddRuntime());
        var nativeMatch = new BindingMatch(native, 1, new object[] { "text" }, new StepContext("Feature", "Scenario", Array.Empty<string>(), CultureInfo.InvariantCulture));
        var inner = new StubInner(nativeMatch);
        var service = new AiBddStepDefinitionMatchService(inner, new AiBddRuntime());

        var match = service.GetBestMatch(Step("I use my own step"), CultureInfo.InvariantCulture, out _, out _);

        Assert.Same(nativeMatch, match);
        Assert.Equal(1, inner.Calls);
    }

    [Fact]
    public void TheCatchAllBindingDeclaresTheBindingSurface()
    {
        var binding = new AiBddStepDefinitionBinding(StepDefinitionType.Then, new AiBddRuntime());
        Assert.True(binding.IsValid);
        Assert.False(binding.IsScoped);
        Assert.Equal("RegularExpression", binding.ExpressionType);
        Assert.Null(binding.Expression);
        Assert.True(binding.Regex.IsMatch("anything at all"));
        Assert.Equal("RunStep", binding.Method.Name);
        Assert.Single(binding.Method.Parameters);
        Assert.NotNull(binding.BindingScope);
    }
}
