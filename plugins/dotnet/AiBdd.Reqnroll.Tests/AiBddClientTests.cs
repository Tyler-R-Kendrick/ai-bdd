using System.Text.Json.Nodes;
using Xunit;

namespace AiBdd.Reqnroll.Tests;

public class AiBddClientTests
{
    [Fact]
    public void ReportsAMissingDaemon()
    {
        var client = new AiBddClient(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString()));
        Assert.False(client.Available());
        var error = Assert.Throws<AiBddException>(() => client.Call("health", new JsonObject()));
        Assert.Equal("DAEMON_UNAUTHORIZED", error.Code);
    }

    [Fact]
    public void ReadsDaemonJsonAndSendsTheBearerToken()
    {
        using var daemon = new FakeDaemon("token-from-file");
        daemon.Respond("health", AiBddClient.Object(("ok", true), ("protocol", 1)));

        var projectRoot = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(Path.Combine(projectRoot, ".ai-bdd"));
        File.WriteAllText(
            Path.Combine(projectRoot, ".ai-bdd", "daemon.json"),
            AiBddClient.Object(("url", daemon.Url), ("token", "token-from-file")).ToJsonString());

        var client = new AiBddClient(projectRoot);
        Assert.True(client.Available());
        var health = client.Call("health", new JsonObject());
        Assert.True(health["ok"]!.GetValue<bool>());
        Assert.Equal(1, health["protocol"]!.GetValue<int>());
        Assert.Single(daemon.Calls);
    }

    [Fact]
    public void SurfacesTheErrorPayload()
    {
        using var daemon = new FakeDaemon();
        var client = new AiBddClient(url: daemon.Url, token: "wrong-token");
        var error = Assert.Throws<AiBddException>(() => client.Call("open_session", new JsonObject()));
        Assert.Equal("DAEMON_UNAUTHORIZED", error.Code);
    }
}
