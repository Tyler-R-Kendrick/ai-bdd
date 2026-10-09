using System.Globalization;
using System.Reflection;
using System.Text.Json.Nodes;
using Reqnroll.Bindings;
using Reqnroll.Infrastructure;
using Xunit;

namespace AiBdd.Reqnroll.Tests;

public class AiBddRuntimeTests
{
    private static JsonObject StepResult(string status, string? errorCode = null, string? message = null)
    {
        var result = AiBddClient.Object(
            ("stepId", "step-1"),
            ("text", "Open billing settings"),
            ("kind", "action"),
            ("kindSource", "keyword"),
            ("status", status),
            ("resolution", AiBddClient.Object(("type", "agent"))));
        if (errorCode is not null)
        {
            result["error"] = AiBddClient.Object(("code", errorCode), ("message", message ?? errorCode), ("retryable", false));
        }

        return result;
    }

    [Fact]
    public void RunsAnAgentStepThroughTheDaemon()
    {
        using var daemon = new FakeDaemon();
        daemon.Respond("open_session", AiBddClient.Object(("sessionId", "s-1"), ("traceId", "t-1"), ("driver", "fake")));
        daemon.Respond("resolve_step", AiBddClient.Object(("next", "run-step"), ("kind", "action"), ("kindSource", "keyword"), ("resolution", AiBddClient.Object(("type", "agent")))));
        daemon.Respond("run_step", StepResult("passed"));
        daemon.Respond("close_session", AiBddClient.Object(("scenarioResult", AiBddClient.Object(("status", "passed")))));

        var runtime = new AiBddRuntime(new AiBddClient(url: daemon.Url, token: daemon.Token));
        runtime.OpenSession("Member upgrades to Pro", new[] { "@billing" });
        var outcome = runtime.RunStep("Open billing settings");
        runtime.CloseSession();

        Assert.Equal("passed", outcome.Status);
        Assert.Contains(daemon.Calls, call => call.Tool == "run_step");
        Assert.Contains(daemon.Calls, call => call.Tool == "close_session");
    }

    [Fact]
    public void HealedStepsPassAndAreRecorded()
    {
        using var daemon = new FakeDaemon();
        daemon.Respond("open_session", AiBddClient.Object(("sessionId", "s-1")));
        daemon.Respond("resolve_step", AiBddClient.Object(("next", "run-step"), ("resolution", AiBddClient.Object(("type", "agent")))));
        daemon.Respond("run_step", StepResult("healed"));

        var runtime = new AiBddRuntime(new AiBddClient(url: daemon.Url, token: daemon.Token));
        runtime.OpenSession("scenario");
        var outcome = runtime.RunStep("Upgrade the plan");
        Assert.Equal("healed", outcome.Status);
        Assert.Single(runtime.Healed);
    }

    [Fact]
    public void FailingStepsCarryTheAiBddCode()
    {
        using var daemon = new FakeDaemon();
        daemon.Respond("open_session", AiBddClient.Object(("sessionId", "s-1")));
        daemon.Respond("resolve_step", AiBddClient.Object(("next", "run-step"), ("resolution", AiBddClient.Object(("type", "agent")))));
        daemon.Respond("run_step", StepResult("failed", "CHECK_FAILED", "the badge did not change"));

        var runtime = new AiBddRuntime(new AiBddClient(url: daemon.Url, token: daemon.Token));
        runtime.OpenSession("scenario");
        var error = Assert.Throws<AiBddException>(() => runtime.RunStep("The plan badge reads \"Pro\""));
        Assert.Equal("CHECK_FAILED", error.Code);
        Assert.True(runtime.Failed);
    }

    [Fact]
    public void AmbiguousResolutionsFailWithStepAmbiguous()
    {
        using var daemon = new FakeDaemon();
        daemon.Respond("open_session", AiBddClient.Object(("sessionId", "s-1")));
        daemon.Respond(
            "resolve_step",
            AiBddClient.Object(
                ("next", "fail"),
                ("resolution", AiBddClient.Object(("type", "ambiguous"), ("message", "two bindings are within the margin")))));

        var runtime = new AiBddRuntime(new AiBddClient(url: daemon.Url, token: daemon.Token));
        runtime.OpenSession("scenario");
        var error = Assert.Throws<AiBddException>(() => runtime.RunStep("Store the workspace"));
        Assert.Equal("STEP_AMBIGUOUS", error.Code);
    }

    [Fact]
    public void LocalBindingsAreInvokedAndReported()
    {
        using var daemon = new FakeDaemon();
        daemon.Respond("open_session", AiBddClient.Object(("sessionId", "s-1")));
        daemon.Respond("register_bindings", AiBddClient.Object(("bindingSetHash", new string('a', 64)), ("accepted", 1)));
        daemon.Respond(
            "resolve_step",
            AiBddClient.Object(
                ("next", "invoke-local"),
                ("resolution", AiBddClient.Object(("type", "exact"), ("bindingId", "dotnet:reqnroll#seed-1")))));
        daemon.Respond("report_binding_result", StepResult("passed"));

        var runtime = new AiBddRuntime(new AiBddClient(url: daemon.Url, token: daemon.Token));
        var method = typeof(BindingSteps).GetMethod(nameof(BindingSteps.SeedWorkspace))!;
        runtime.Bindings.Add("Seed a workspace {string} on the {string} plan", "Seeds a workspace", "setup", method);
        runtime.OpenSession("scenario");
        var outcome = runtime.RunStep("Seed a workspace \"Acme\" on the \"free\" plan");

        Assert.Equal("passed", outcome.Status);
        Assert.Equal("\"Acme\"", BindingSteps.LastName);
        Assert.Contains(daemon.Calls, call => call.Tool == "report_binding_result");
        Assert.Contains(daemon.Calls, call => call.Tool == "register_bindings");
    }

    public static class BindingSteps
    {
        public static string? LastName;

        public static bool SeedWorkspace(string name, string plan)
        {
            LastName = name;
            return !string.IsNullOrEmpty(plan);
        }
    }
}
