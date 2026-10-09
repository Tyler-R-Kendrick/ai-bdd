package dev.ai.bdd.cucumber;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Unit tests for the JSON reader, the client, the bindings and the catch-all pattern. */
class AiBddUnitTest {

    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void jsonRoundTripsObjectsArraysAndEscapes() {
        Map<String, Object> parsed = AiBddJson.parseObject("{\"a\":[1,2,\"three\"],\"b\":{\"c\":true},\"d\":null,\"e\":\"x\\ny\"}");
        assertEquals(List.of(1L, 2L, "three"), parsed.get("a"));
        assertEquals(Boolean.TRUE, ((Map<?, ?>) parsed.get("b")).get("c"));
        assertEquals("x\ny", parsed.get("e"));
        String written = AiBddJson.write(parsed);
        assertEquals(parsed, AiBddJson.parseObject(written));
    }

    @Test
    void clientReportsAMissingDaemon(@org.junit.jupiter.api.io.TempDir Path directory) {
        AiBddClient client = new AiBddClient(directory);
        assertFalse(client.available());
        AiBddError error = assertThrows(AiBddError.class, () -> client.call("health", Map.of()));
        assertEquals("DAEMON_UNAUTHORIZED", error.code());
    }

    @Test
    void clientReadsDaemonJsonAndSerializesErrors(@org.junit.jupiter.api.io.TempDir Path directory) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/health", exchange -> {
            assertEquals("Bearer token-from-file", exchange.getRequestHeaders().getFirst("authorization"));
            respond(exchange, 200, "{\"ok\":true,\"protocol\":1}");
        });
        server.createContext("/v1/resolve_step", exchange -> respond(exchange, 401, "{\"error\":{\"code\":\"NO_SESSION\",\"message\":\"unknown session\",\"retryable\":false}}"));
        server.start();

        Files.createDirectories(directory.resolve(".ai-bdd"));
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        Files.writeString(directory.resolve(".ai-bdd/daemon.json"),
                "{\"url\":\"" + base + "\",\"token\":\"token-from-file\"}", StandardCharsets.UTF_8);

        AiBddClient client = new AiBddClient(directory);
        assertTrue(client.available());
        assertEquals(1L, client.call("health", Map.of()).get("protocol"));

        AiBddError error = assertThrows(AiBddError.class, () -> client.call("resolve_step", Map.of()));
        assertEquals("NO_SESSION", error.code());
    }

    private void respond(com.sun.net.httpserver.HttpExchange exchange, int status, String body) {
        try {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream stream = exchange.getResponseBody()) {
                stream.write(bytes);
            }
        } catch (IOException ignored) {
            // the test already failed elsewhere
        }
    }

    @Test
    void bindingsCompileCucumberExpressionsAndCaptureValues() {
        AiBddBindings bindings = new AiBddBindings("java:test");
        String id = bindings.add("Seed a workspace {string} on the {string} plan", "Seeds a workspace", "setup", List.of(), null);
        AiBddBindings.Entry entry = bindings.find(id).orElseThrow();
        Map<String, Object> captured = entry.capture("Seed a workspace \"Acme\" on the \"free\" plan");
        assertEquals("\"Acme\"", captured.get("string") == null ? null : captured.values().iterator().next());
        assertEquals(2, entry.values("Seed a workspace \"Acme\" on the \"free\" plan").size());
        assertEquals(1, entry.values("Seed a workspace \"Acme\" on the \"free\" plan").size() - 1);
        assertTrue(bindings.findForStep("Seed a workspace \"Acme\" on the \"free\" plan").isPresent());
        assertTrue(bindings.findForStep("something else").isEmpty());
        assertEquals(1, bindings.publish().size());
    }

    @Test
    void bindingsSupportIntAndEnumParameters() {
        AiBddBindings bindings = new AiBddBindings("java:test");
        String id = bindings.add("Seed {int} unpaid invoices for {string}", "Seeds invoices", "setup", List.of(), null);
        AiBddBindings.Entry entry = bindings.find(id).orElseThrow();
        List<String> values = entry.values("Seed 2 unpaid invoices for \"Acme\"");
        assertEquals(List.of("2", "\"Acme\""), values);
    }

    @Test
    void catchAllPatternExcludesNativePatterns() {
        String pattern = AiBddBackend.catchAllPattern(List.of("Seed a workspace {string} on the {string} plan"));
        assertTrue(pattern.startsWith("^(?!"));
        java.util.regex.Pattern compiled = java.util.regex.Pattern.compile(pattern);
        assertFalse(compiled.matcher("Seed a workspace \"Acme\" on the \"free\" plan").matches());
        assertTrue(compiled.matcher("Open billing settings").matches());
        assertEquals(AiBddStepDefinition.PATTERN, AiBddBackend.catchAllPattern(List.of()));
    }

    @Test
    void catchAllPatternKeepsAnchoredRegexesIntact() {
        String pattern = AiBddBackend.catchAllPattern(List.of("^I have a wallet$"));
        java.util.regex.Pattern compiled = java.util.regex.Pattern.compile(pattern);
        assertFalse(compiled.matcher("I have a wallet").matches());
        assertTrue(compiled.matcher("I have a wallet with 10 euros").matches());
    }

    @Test
    void stepDefinitionsAreLocationAware() {
        AiBddRuntime runtime = new AiBddRuntime(Path.of("."));
        AiBddStepDefinition definition = new AiBddStepDefinition(runtime);
        assertEquals(AiBddStepDefinition.PATTERN, definition.getPattern());
        assertEquals(1, definition.parameterInfos().size());
        assertEquals(String.class, definition.parameterInfos().get(0).getType());
        assertNotNull(definition.getLocation());
        assertTrue(definition.isDefinedAt(new StackTraceElement("dev.ai.bdd.cucumber.AiBddStepDefinition", "execute", "AiBddStepDefinition.java", 1)));
        assertFalse(definition.isDefinedAt(new StackTraceElement("other.Class", "execute", "Other.java", 1)));
    }

    @Test
    void optionsDefaultToNoNativePatterns() {
        AiBddOptions options = AiBddOptions.load(null);
        assertTrue(options.nativePatterns().isEmpty());
    }
}
