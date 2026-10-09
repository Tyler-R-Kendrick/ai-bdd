using System.Reflection;
using System.Text.RegularExpressions;
using CucumberExpressions;
using Reqnroll.Bindings;
using Reqnroll.Bindings.Reflection;

namespace AiBdd.Reqnroll;

/// <summary>
/// The step definition binding the match service hands back when no native binding
/// matches: it matches every step text and runs the step on the daemon.
///
/// Reqnroll resolves a binding's invocation through <see cref="IBindingMethod"/>, so the
/// binding carries a description of the method that would run; this plugin's own
/// invocation happens in <see cref="Execute"/>, which the match service calls through
/// <see cref="AiBddStepDefinitionMatchService"/>.
/// </summary>
public sealed class AiBddStepDefinitionBinding : IStepDefinitionBinding
{
    private readonly AiBddRuntime runtime;

    public AiBddStepDefinitionBinding(StepDefinitionType type, AiBddRuntime runtime)
    {
        StepDefinitionType = type;
        this.runtime = runtime;
        Method = new AiBddBindingMethod();
        BindingScope = new BindingScope(null, null, null);
    }

    /// <inheritdoc />
    public StepDefinitionType StepDefinitionType { get; }

    /// <inheritdoc />
    public string SourceExpression => CatchAllSource;

    /// <inheritdoc />
    public string ExpressionType => "RegularExpression";

    /// <inheritdoc />
    public bool IsValid => true;

    /// <inheritdoc />
    public string? ErrorMessage => null;

    /// <inheritdoc />
    public Regex Regex { get; } = new("^(.*)$", RegexOptions.CultureInvariant);

    /// <inheritdoc />
    public IExpression? Expression => null;

    /// <inheritdoc />
    public IBindingMethod Method { get; }

    /// <inheritdoc />
    public bool IsScoped => false;

    /// <inheritdoc />
    public BindingScope BindingScope { get; }

    /// <summary>The catch-all pattern, exposed for tests.</summary>
    public const string CatchAllSource = "^(.*)$";

    /// <summary>Runs the step through the daemon, marking the scenario failed on error.</summary>
    public AiBddStepOutcome Execute(string stepText)
    {
        try
        {
            return runtime.RunStep(stepText);
        }
        catch (AiBddException)
        {
            runtime.MarkFailed();
            throw;
        }
    }

    /// <summary>A binding method describing the ai-bdd catch-all.</summary>
    private sealed class AiBddBindingMethod : IBindingMethod
    {
        public string Name => "RunStep";

        public IEnumerable<IBindingParameter> Parameters => new[] { new AiBddParameter("text") };

        public IBindingType ReturnType { get; } = new AiBddType(typeof(AiBddStepOutcome));

        public IBindingType Type { get; } = new AiBddType(typeof(AiBddStepDefinitionBinding));
    }

    private sealed class AiBddParameter : IBindingParameter
    {
        public AiBddParameter(string name) => ParameterName = name;

        public string ParameterName { get; }

        public IBindingType Type { get; } = new AiBddType(typeof(string));
    }

    private sealed class AiBddType : IBindingType
    {
        public AiBddType(Type type)
        {
            Name = type.Name;
            FullName = type.FullName ?? type.Name;
            AssemblyName = type.Assembly.GetName().Name ?? "AiBdd.Reqnroll";
        }

        public string Name { get; }

        public string FullName { get; }

        public string AssemblyName { get; }
    }
}
