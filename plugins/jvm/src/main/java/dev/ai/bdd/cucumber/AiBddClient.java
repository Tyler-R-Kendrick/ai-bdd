package dev.ai.bdd.cucumber;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

/**
 * The HTTP JSON mirror client, on java.net.http.
 *
 * Discovery order: explicit url and token, the environment, then
 * {@code .ai-bdd/daemon.json}, which {@code ai-bdd serve --http} writes with mode
 * 0600.
 */
public class AiBddClient {

    private final Path projectRoot;
    private final HttpClient http;
    private String url;
    private String token;

    public AiBddClient(Path projectRoot) {
        this.projectRoot = projectRoot != null ? projectRoot : Path.of(System.getProperty("user.dir"));
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(20)).build();
        // Environment first, then the system properties an embedding process can set.
        this.url = firstNonEmpty(System.getenv("AI_BDD_DAEMON_URL"), System.getProperty("ai-bdd.daemonUrl"));
        this.token = firstNonEmpty(System.getenv("AI_BDD_DAEMON_TOKEN"), System.getProperty("ai-bdd.daemonToken"));
    }

    public AiBddClient(Path projectRoot, String url, String token) {
        this(projectRoot);
        this.url = url;
        this.token = token;
    }

    private static String firstNonEmpty(String first, String second) {
        if (first != null && !first.isEmpty()) {
            return first;
        }
        return second == null || second.isEmpty() ? null : second;
    }

    public boolean available() {
        return (url != null && !url.isEmpty()) || Files.exists(daemonFile());
    }

    private Path daemonFile() {
        return projectRoot.resolve(".ai-bdd").resolve("daemon.json");
    }

    private void resolve() {
        if (url != null && !url.isEmpty()) {
            return;
        }
        Path file = daemonFile();
        if (!Files.exists(file)) {
            throw new AiBddError(
                    "DAEMON_UNAUTHORIZED",
                    "no daemon is running: " + file + " does not exist (start one with ai-bdd serve --http)",
                    false);
        }
        try {
            Map<String, Object> payload = AiBddJson.parseObject(Files.readString(file, StandardCharsets.UTF_8));
            url = String.valueOf(payload.get("url"));
            token = String.valueOf(payload.getOrDefault("token", ""));
        } catch (IOException error) {
            throw new AiBddError("INTERNAL", "daemon.json is not readable: " + error.getMessage(), false);
        }
    }

    /** Invokes one tool and returns the parsed result. */
    public Map<String, Object> call(String tool, Map<String, Object> body) {
        resolve();
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url.replaceAll("/$", "") + "/v1/" + tool))
                .timeout(Duration.ofSeconds(120))
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(AiBddJson.write(body), StandardCharsets.UTF_8));
        if (token != null && !token.isEmpty()) {
            builder.header("authorization", "Bearer " + token);
        }
        try {
            HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 400) {
                throw toError(response.body(), response.statusCode());
            }
            return AiBddJson.parseObject(response.body());
        } catch (IOException error) {
            throw new AiBddError("DRIVER_UNAVAILABLE", "the daemon is unreachable: " + error.getMessage(), true);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AiBddError("INTERNAL", "interrupted while calling " + tool, false);
        }
    }

    /** Invokes one tool, ignoring the result. */
    public void callVoid(String tool, Map<String, Object> body) {
        call(tool, body);
    }

    private AiBddError toError(String body, int status) {
        try {
            Map<String, Object> envelope = AiBddJson.parseObject(body);
            Object error = envelope.get("error");
            if (error instanceof Map<?, ?> map) {
                return new AiBddError(
                        String.valueOf(map.get("code")),
                        String.valueOf(map.get("message")),
                        Boolean.TRUE.equals(map.get("retryable")));
            }
        } catch (RuntimeException ignored) {
            // fall through to the generic error below
        }
        return new AiBddError("INTERNAL", "HTTP " + status, false);
    }
}
