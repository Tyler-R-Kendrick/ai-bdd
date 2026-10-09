using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace AiBdd.Reqnroll.Tests;

/// <summary>
/// A scripted daemon on an in-process HTTP listener.
///
/// The plugin talks to the real HTTP JSON mirror, so the tests exercise the same
/// path a real daemon serves: bearer auth, the tool names and the AiBddError payload.
/// </summary>
public sealed class FakeDaemon : IDisposable
{
    private readonly HttpListener listener = new();
    private readonly Dictionary<string, JsonObject> responses = new();
    private readonly List<(string Tool, JsonObject Body)> calls = new();
    private readonly Task loop;

    public FakeDaemon(string token = "test-token")
    {
        Token = token;
        var port = FreePort();
        Url = $"http://127.0.0.1:{port}";
        listener.Prefixes.Add(Url + "/");
        listener.Start();
        loop = Task.Run(Handle);
    }

    public string Url { get; }

    public string Token { get; }

    public IReadOnlyList<(string Tool, JsonObject Body)> Calls => calls;

    public void Respond(string tool, JsonObject body) => responses[tool] = body;

    private static int FreePort()
    {
        var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    private async Task Handle()
    {
        while (listener.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (Exception)
            {
                return;
            }

            var tool = context.Request.Url!.AbsolutePath.Replace("/v1/", string.Empty);
            var body = new JsonObject();
            using (var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8))
            {
                var text = await reader.ReadToEndAsync().ConfigureAwait(false);
                if (!string.IsNullOrWhiteSpace(text))
                {
                    body = JsonNode.Parse(text)!.AsObject();
                }
            }

            calls.Add((tool, body));
            var authorized = context.Request.Headers["authorization"] == $"Bearer {Token}";
            if (!authorized && tool != "health")
            {
                await Write(context, 401, new JsonObject
                {
                    ["error"] = new JsonObject
                    {
                        ["code"] = "DAEMON_UNAUTHORIZED",
                        ["message"] = "missing or invalid bearer token",
                        ["retryable"] = false,
                    },
                }).ConfigureAwait(false);
                continue;
            }

            if (!responses.TryGetValue(tool, out var response))
            {
                await Write(context, 400, new JsonObject
                {
                    ["error"] = new JsonObject
                    {
                        ["code"] = "INVALID_ARGUMENT",
                        ["message"] = $"no scripted response for {tool}",
                        ["retryable"] = false,
                    },
                }).ConfigureAwait(false);
                continue;
            }

            await Write(context, 200, response).ConfigureAwait(false);
        }
    }

    private static async Task Write(HttpListenerContext context, int status, JsonObject payload)
    {
        var bytes = Encoding.UTF8.GetBytes(payload.ToJsonString());
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json";
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
        context.Response.Close();
    }

    public void Dispose()
    {
        if (listener.IsListening)
        {
            listener.Stop();
        }

        listener.Close();
        _ = loop;
    }
}
