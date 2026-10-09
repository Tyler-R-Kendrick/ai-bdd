using System.Reflection;
using System.Text.Json.Nodes;

namespace AiBdd.Reqnroll;

/// <summary>The per-scenario state: the daemon session and this plugin's bindings.</summary>
public sealed class AiBddRuntime
{
    public const string ProviderName = "dotnet:reqnroll";
    private static readonly JsonObject PluginInfo = AiBddClient.Object(
        ("name", "AiBdd.Reqnroll"),
        ("version", "0.1.0"),
        ("language", "csharp"));

    private readonly AiBddClient client;
    private readonly AiBddBindings bindings = new();
    private readonly List<string> healed = new();
    private bool failed;

    public AiBddRuntime(AiBddClient? client = null) => this.client = client ?? new AiBddClient();

    public string? SessionId { get; private set; }

    public IReadOnlyList<string> Healed => healed;

    public AiBddClient Client => client;

    public AiBddBindings Bindings => bindings;

    public bool Failed => failed;

    public void MarkFailed() => failed = true;

    /// <summary>Registers an annotated method as a binding.</summary>
    public string Register(MethodInfo method, AiBddStepAttribute annotation) =>
        bindings.Add(annotation.Pattern, annotation.Description, annotation.Kind, method);

    /// <summary>Opens the daemon session and publishes the bindings.</summary>
    public void OpenSession(string scenarioName, IEnumerable<string>? tags = null)
    {
        var input = AiBddClient.Object(
            ("scenarioId", $"reqnroll#{scenarioName}"),
            ("scenarioName", scenarioName),
            ("tags", new JsonArray((tags ?? Array.Empty<string>()).Select(tag => (JsonNode)JsonValue.Create(tag)!).ToArray())),
            ("plugin", PluginInfo));
        var opened = client.Call("open_session", input);
        SessionId = opened["sessionId"]!.GetValue<string>();
        var descriptors = bindings.Publish();
        if (descriptors.Count > 0)
        {
            var array = new JsonArray(descriptors.Select(descriptor => (JsonNode)descriptor.DeepClone()).ToArray());
            client.Call(
                "register_bindings",
                AiBddClient.Object(("sessionId", SessionId), ("provider", ProviderName), ("bindings", array)));
        }
    }

    /// <summary>Closes the session with the scenario's status.</summary>
    public void CloseSession()
    {
        if (SessionId is null)
        {
            return;
        }

        try
        {
            client.Call(
                "close_session",
                AiBddClient.Object(("sessionId", SessionId), ("status", failed ? "failed" : "passed")));
        }
        catch (AiBddException)
        {
            // closing is best effort: the daemon may already have reaped the session
        }

        SessionId = null;
    }

    /// <summary>Resolves one step, then invokes it locally or lets the daemon run it.</summary>
    public AiBddStepOutcome RunStep(string text)
    {
        var input = AiBddClient.Object(("sessionId", SessionId), ("step", AiBddClient.Object(("text", text))));
        var resolved = client.Call("resolve_step", input);
        var next = resolved["next"]!.GetValue<string>();
        var resolution = resolved["resolution"]!.AsObject();

        if (next == "fail")
        {
            failed = true;
            throw Failure(text, resolved, resolution);
        }

        var type = resolution["type"]?.GetValue<string>();
        if (next == "invoke-local" && (type == "exact" || type == "semantic"))
        {
            var bindingId = resolution["bindingId"]!.GetValue<string>();
            var binding = bindings.Find(bindingId) ?? bindings.FindForStep(text);
            if (binding is null)
            {
                failed = true;
                throw new AiBddException("PARAM_EXTRACTION_FAILED", $"the plugin has no method for {bindingId}");
            }

            var started = DateTimeOffset.UtcNow;
            var status = "passed";
            JsonObject? error = null;
            try
            {
                var result = bindings.Invoke(binding, text);
                if (result is false)
                {
                    status = "failed";
                    error = AiBddClient.Object(("message", "the binding returned false"));
                }
            }
            catch (AiBddException failure)
            {
                status = "failed";
                error = AiBddClient.Object(("message", failure.Message));
            }

            report("report_binding_result", bindingId, text, status, started, error);
            if (status == "failed")
            {
                failed = true;
                throw new AiBddException("CHECK_FAILED", error?["message"]?.GetValue<string>() ?? text);
            }

            return new AiBddStepOutcome(status, null);
        }

        var outcome = client.Call("run_step", input);
        var outcomeStatus = outcome["status"]!.GetValue<string>();
        if (outcomeStatus == "passed")
        {
            return new AiBddStepOutcome(outcomeStatus, null);
        }

        if (outcomeStatus == "healed")
        {
            // A heal is a pass in Reqnroll's report; the ai-bdd reporters still show
            // the step as healed (R-K22).
            healed.Add(text);
            return new AiBddStepOutcome(outcomeStatus, null);
        }

        failed = true;
        var payload = outcome["error"] as JsonObject;
        throw new AiBddException(
            payload?["code"]?.GetValue<string>() ?? outcomeStatus.ToUpperInvariant(),
            payload?["message"]?.GetValue<string>() ?? text);
    }

    /// <summary>Reports a locally executed binding to the daemon, so evidence sees it.</summary>
    public void ReportLocal(string bindingId, string text, int durationMs, string status, string? error)
    {
        if (SessionId is null)
        {
            return;
        }

        var started = DateTimeOffset.UtcNow.AddMilliseconds(-durationMs);
        report("report_binding_result", bindingId, text, status, started, error is null ? null : AiBddClient.Object(("message", error)));
    }

    private void report(string tool, string bindingId, string text, string status, DateTimeOffset started, JsonObject? error)
    {
        var payload = AiBddClient.Object(
            ("sessionId", SessionId),
            ("step", AiBddClient.Object(("text", text))),
            ("bindingId", bindingId),
            ("status", status),
            ("durationMs", (int)(DateTimeOffset.UtcNow - started).TotalMilliseconds));
        if (error is not null)
        {
            payload["error"] = error;
        }

        try
        {
            client.Call(tool, payload);
        }
        catch (AiBddException)
        {
            // reporting is best effort: the step outcome is already decided
        }
    }

    private static AiBddException Failure(string text, JsonObject resolved, JsonObject resolution)
    {
        if (resolved["error"] is JsonObject payload)
        {
            return new AiBddException(
                payload["code"]?.GetValue<string>() ?? "FAILED",
                payload["message"]?.GetValue<string>() ?? text);
        }

        var type = resolution["type"]?.GetValue<string>();
        return type switch
        {
            "ambiguous" => new AiBddException("STEP_AMBIGUOUS", resolution["message"]?.GetValue<string>() ?? text),
            "unbound" => new AiBddException("SETUP_UNBOUND", resolution["message"]?.GetValue<string>() ?? text),
            _ => new AiBddException("FAILED", text),
        };
    }
}

/// <summary>The outcome of one step as the plugin sees it.</summary>
public sealed record AiBddStepOutcome(string Status, string? ErrorCode);
