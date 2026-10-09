namespace AiBdd.Reqnroll;

/// <summary>
/// Marks a public method as an ai-bdd binding.
///
/// The method is published to the daemon (so semantic matching and the lockfile see
/// it) and stays in this process: the daemon answers <c>invoke-local</c> and the
/// plugin invokes the method.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class AiBddStepAttribute : Attribute
{
    public AiBddStepAttribute(string pattern, string? description = null, string? kind = null)
    {
        Pattern = pattern;
        Description = description;
        Kind = kind;
    }

    /// <summary>A Cucumber Expression or an anchored regular expression.</summary>
    public string Pattern { get; }

    /// <summary>The natural-language description the resolver embeds.</summary>
    public string? Description { get; }

    /// <summary>setup, action or assertion.</summary>
    public string? Kind { get; }
}
