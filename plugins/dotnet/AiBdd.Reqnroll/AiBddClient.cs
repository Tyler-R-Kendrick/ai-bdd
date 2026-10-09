using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AiBdd.Reqnroll;

/// <summary>An AiBddError payload returned by the daemon.</summary>
public sealed class AiBddException : Exception
{
    public AiBddException(string code, string message, bool retryable = false)
        : base($"{code}: {message}")
    {
        Code = code;
        Retryable = retryable;
    }

    public string Code { get; }

    public bool Retryable { get; }
}

/// <summary>
/// The HTTP JSON mirror client.
///
/// Discovery order: an explicit URL, <c>AI_BDD_DAEMON_URL</c>, then
/// <c>.ai-bdd/daemon.json</c> (which <c>ai-bdd serve --http</c> writes with mode 0600).
/// </summary>
public sealed class AiBddClient
{
    private readonly HttpClient http;
    private readonly string? projectRoot;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public AiBddClient(string? projectRoot = null, string? url = null, string? token = null, HttpMessageHandler? handler = null)
    {
        this.projectRoot = projectRoot ?? Environment.GetEnvironmentVariable("AI_BDD_PROJECT_ROOT") ?? Directory.GetCurrentDirectory();
        Url = url ?? UrlFromProperty("ai-bdd.daemonUrl") ?? Environment.GetEnvironmentVariable("AI_BDD_DAEMON_URL");
        Token = token ?? UrlFromProperty(null, "ai-bdd.daemonToken") ?? Environment.GetEnvironmentVariable("AI_BDD_DAEMON_TOKEN");
        http = handler is null ? new HttpClient { Timeout = TimeSpan.FromSeconds(120) } : new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(120) };
    }

    public string? Url { get; private set; }

    public string? Token { get; private set; }

    private static string? UrlFromProperty(string? unused, string? name = null)
    {
        _ = unused;
        return name is null ? null : AppDomain.CurrentDomain.GetData(name) as string;
    }

    /// <summary>True when a daemon is reachable without starting one.</summary>
    public bool Available()
    {
        if (!string.IsNullOrEmpty(Url))
        {
            return true;
        }

        return File.Exists(DaemonFile());
    }

    private string DaemonFile() => Path.Combine(projectRoot!, ".ai-bdd", "daemon.json");

    private void Resolve()
    {
        if (!string.IsNullOrEmpty(Url))
        {
            return;
        }

        var file = DaemonFile();
        if (!File.Exists(file))
        {
            throw new AiBddException(
                "DAEMON_UNAUTHORIZED",
                $"no daemon is running: {file} does not exist (start one with ai-bdd serve --http)");
        }

        var payload = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
        Url = payload["url"]!.GetValue<string>();
        Token = payload["token"]?.GetValue<string>() ?? string.Empty;
    }

    /// <summary>Invokes one tool and returns its JSON result.</summary>
    public JsonObject Call(string tool, JsonObject body)
    {
        Resolve();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{Url!.TrimEnd('/')}/v1/{tool}")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrEmpty(Token))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        }

        using var response = http.Send(request);
        var text = new StreamReader(response.Content.ReadAsStream()).ReadToEnd();
        if (!response.IsSuccessStatusCode)
        {
            throw ToError(text, (int)response.StatusCode);
        }

        return JsonNode.Parse(text)!.AsObject();
    }

    /// <summary>Invokes one tool asynchronously and returns its JSON result.</summary>
    public async Task<JsonObject> CallAsync(string tool, JsonObject body, string? traceparent = null)
    {
        Resolve();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{Url!.TrimEnd('/')}/v1/{tool}")
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        if (!string.IsNullOrEmpty(Token))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        }

        if (traceparent is not null)
        {
            request.Headers.TryAddWithoutValidation("traceparent", traceparent);
        }

        using var response = await http.SendAsync(request).ConfigureAwait(false);
        var text = await new StreamReader(await response.Content.ReadAsStreamAsync().ConfigureAwait(false)).ReadToEndAsync().ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw ToError(text, (int)response.StatusCode);
        }

        return JsonNode.Parse(text)!.AsObject();
    }

    private static AiBddException ToError(string body, int status)
    {
        try
        {
            var payload = JsonNode.Parse(body)?["error"];
            if (payload is not null)
            {
                return new AiBddException(
                    payload["code"]?.GetValue<string>() ?? "INTERNAL",
                    payload["message"]?.GetValue<string>() ?? $"HTTP {status}",
                    payload["retryable"]?.GetValue<bool>() ?? false);
            }
        }
        catch (JsonException)
        {
            // fall through
        }

        return new AiBddException("INTERNAL", $"HTTP {status}");
    }

    public static JsonObject Object(params (string Key, object? Value)[] entries)
    {
        var result = new JsonObject();
        foreach (var (key, value) in entries)
        {
            result[key] = value switch
            {
                null => null,
                string text => JsonValue.Create(text),
                bool flag => JsonValue.Create(flag),
                int number => JsonValue.Create(number),
                long number => JsonValue.Create(number),
                // A node can only have one parent, so a shared template (the plugin
                // info, a scripted response) must be cloned before it is attached.
                JsonNode node => node.DeepClone(),
                _ => JsonValue.Create(value.ToString()),
            };
        }

        return result;
    }

    internal static JsonSerializerOptions SerializerOptions => JsonOptions;
}
