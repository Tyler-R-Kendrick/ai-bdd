using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AiBdd.Reqnroll;

/// <summary>One registered binding: its descriptor, its method and its matcher.</summary>
public sealed record AiBddBinding(string Id, JsonObject Descriptor, MethodInfo Method, Regex? Matcher, IReadOnlyList<string> ParameterNames)
{
    public IReadOnlyList<string> Values(string stepText)
    {
        if (Matcher is null)
        {
            return Array.Empty<string>();
        }

        var match = Matcher.Match(stepText);
        if (!match.Success)
        {
            return Array.Empty<string>();
        }

        var values = new List<string>();
        for (var index = 1; index < match.Groups.Count; index++)
        {
            values.Add(match.Groups[index].Value);
        }

        return values;
    }

    public JsonObject Capture(string stepText)
    {
        var values = Values(stepText);
        var captured = new JsonObject();
        var seen = new Dictionary<string, int>();
        for (var index = 0; index < ParameterNames.Count && index < values.Count; index++)
        {
            var name = ParameterNames[index];
            var occurrence = seen.TryGetValue(name, out var count) ? count + 1 : 1;
            seen[name] = occurrence;
            captured[occurrence == 1 ? name : $"{name}[{occurrence - 1}]"] = values[index];
        }

        return captured;
    }
}

/// <summary>The bindings this plugin owns; the daemon decides which one wins.</summary>
public sealed class AiBddBindings
{
    private readonly string provider;
    private readonly List<AiBddBinding> entries = new();

    public AiBddBindings(string provider = "dotnet:reqnroll") => this.provider = provider;

    public string Provider => provider;

    public string Add(string pattern, string? description, string? kind, MethodInfo method)
    {
        var id = $"{provider}#{Slug(pattern)}-{entries.Count + 1}";
        var descriptor = AiBddClient.Object(
            ("id", id),
            ("provider", provider),
            ("pattern", pattern),
            ("patternKind", pattern.StartsWith('^') ? "regex" : "cucumber-expression"),
            ("kind", string.IsNullOrEmpty(kind) ? "action" : kind),
            ("description", string.IsNullOrEmpty(description) ? null : description));
        entries.Add(new AiBddBinding(id, descriptor, method, Compile(pattern), ParameterNames(pattern)));
        return id;
    }

    public IReadOnlyList<JsonObject> Publish() => entries.Select(entry => entry.Descriptor).ToList();

    public AiBddBinding? Find(string id) => entries.FirstOrDefault(entry => entry.Id == id);

    /// <summary>Finds this plugin's own binding for a step text (a foreign id served here).</summary>
    public AiBddBinding? FindForStep(string stepText) =>
        entries.FirstOrDefault(entry => entry.Matcher is not null && entry.Matcher.IsMatch(stepText));

    /// <summary>Invokes the binding method with the captured values.</summary>
    public object? Invoke(AiBddBinding binding, string stepText)
    {
        var values = binding.Values(stepText);
        var parameters = binding.Method.GetParameters();
        var arguments = new object?[parameters.Length];
        for (var index = 0; index < parameters.Length; index++)
        {
            arguments[index] = index < values.Count ? Convert(values[index], parameters[index].ParameterType) : null;
        }

        var target = binding.Method.IsStatic ? null : Activator.CreateInstance(binding.Method.DeclaringType!);
        try
        {
            return binding.Method.Invoke(target, arguments);
        }
        catch (TargetInvocationException error)
        {
            throw new AiBddException("INTERNAL", error.InnerException?.Message ?? error.Message);
        }
    }

    private static object? Convert(string value, Type type)
    {
        if (type == typeof(string))
        {
            return value;
        }

        if (type == typeof(int))
        {
            return int.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
        }

        if (type == typeof(long))
        {
            return long.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
        }

        if (type == typeof(double))
        {
            return double.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
        }

        if (type == typeof(bool))
        {
            return bool.Parse(value);
        }

        return value;
    }

    /// <summary>Compiles a Cucumber Expression or an anchored regex into a matcher.</summary>
    public static Regex? Compile(string pattern)
    {
        try
        {
            if (pattern.StartsWith('^') && pattern.EndsWith('$'))
            {
                return new Regex(pattern, RegexOptions.CultureInvariant);
            }

            var builder = new System.Text.StringBuilder("^");
            var index = 0;
            foreach (Match placeholder in Placeholder.Matches(pattern))
            {
                builder.Append(Regex.Escape(pattern[index..placeholder.Index]));
                builder.Append(placeholder.Groups[1].Value switch
                {
                    "int" => "(-?\\d+)",
                    "float" => "(-?\\d+(?:\\.\\d+)?)",
                    "word" => "(\\w+)",
                    _ => "(.*?)",
                });
                index = placeholder.Index + placeholder.Length;
            }

            builder.Append(Regex.Escape(pattern[index..])).Append('$');
            return new Regex(builder.ToString(), RegexOptions.CultureInvariant);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static readonly Regex Placeholder = new("\\{([a-zA-Z0-9_]+)\\}", RegexOptions.CultureInvariant);

    public static IReadOnlyList<string> ParameterNames(string pattern) =>
        Placeholder.Matches(pattern).Select(match => match.Groups[1].Value).ToList();

    private static string Slug(string pattern)
    {
        var slug = Regex.Replace(pattern.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
        return slug.Length switch
        {
            0 => "step",
            > 40 => slug[..40],
            _ => slug,
        };
    }
}
