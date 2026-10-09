using System.Reflection;
using Xunit;

namespace AiBdd.Reqnroll.Tests;

public class AiBddBindingsTests
{
    private sealed class Steps
    {
        public static string? LastName;

        [AiBddStep("Seed a workspace {string} on the {string} plan", "Seeds a workspace", "setup")]
        public bool SeedWorkspace(string name, string plan)
        {
            LastName = name;
            return !string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(plan);
        }

        [AiBddStep("Seed {int} unpaid invoices for {string}")]
        public bool SeedInvoices(int count, string name) => count > 0 && !string.IsNullOrEmpty(name);
    }

    private static AiBddBindings Bindings()
    {
        var bindings = new AiBddBindings("dotnet:test");
        foreach (var method in typeof(Steps).GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            var annotation = method.GetCustomAttribute<AiBddStepAttribute>();
            if (annotation is not null)
            {
                bindings.Add(annotation.Pattern, annotation.Description, annotation.Kind, method);
            }
        }

        return bindings;
    }

    [Fact]
    public void CompilesCucumberExpressionsAndCapturesPositionally()
    {
        var bindings = Bindings();
        var text = "Seed a workspace \"Acme\" on the \"free\" plan";
        var binding = bindings.FindForStep(text);
        Assert.NotNull(binding);
        Assert.Equal(new[] { "\"Acme\"", "\"free\"" }, binding!.Values(text));
        var captured = binding.Capture(text);
        Assert.Equal("\"Acme\"", captured["string"]!.GetValue<string>());
        Assert.Equal("\"free\"", captured["string[1]"]!.GetValue<string>());
    }

    [Fact]
    public void ConvertsTypedParameters()
    {
        var bindings = Bindings();
        var binding = bindings.FindForStep("Seed 2 unpaid invoices for \"Acme\"");
        Assert.NotNull(binding);
        Assert.True((bool)bindings.Invoke(binding!, "Seed 2 unpaid invoices for \"Acme\"")!);
    }

    [Fact]
    public void PublishesDescriptorsWithoutHashes()
    {
        var bindings = Bindings();
        var descriptors = bindings.Publish();
        Assert.Equal(2, descriptors.Count);
        Assert.All(descriptors, descriptor => Assert.False(descriptor.ContainsKey("hash")));
        Assert.Equal("setup", descriptors[0]["kind"]!.GetValue<string>());
    }

    [Fact]
    public void ReturnsFalseWhenTheBindingReportsFailure()
    {
        var bindings = Bindings();
        var binding = bindings.FindForStep("Seed 0 unpaid invoices for \"Acme\"");
        Assert.NotNull(binding);
        Assert.False((bool)bindings.Invoke(binding!, "Seed 0 unpaid invoices for \"Acme\"")!);
    }
}
