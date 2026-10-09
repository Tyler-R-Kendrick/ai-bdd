package dev.ai.bdd.cucumber;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.cucumber.core.cli.Main;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The plugin conformance run: every kit feature through Cucumber-JVM against
 * {@code ai-bdd serve --fake-script}, compared with the kit's expected statuses.
 */
class PluginConformanceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static Process daemon;
    private static Path kit;
    private static Map<String, List<String>> aliases = new LinkedHashMap<>();

    @BeforeAll
    static void startScriptedDaemon() throws IOException, InterruptedException {
        Path repository = Path.of(System.getenv().getOrDefault("AI_BDD_REPO_ROOT", "../..")).toAbsolutePath().normalize();
        kit = repository.resolve("packages/conformance/plugin");
        Path cli = repository.resolve("packages/cli/dist/bin.js");
        assertTrue(Files.exists(cli), "build the CLI first: " + cli);

        Path project = Files.createTempDirectory("ai-bdd-jvm-daemon");
        daemon = new ProcessBuilder("node", cli.toString(), "serve", "--fake-script", "--port", "0")
                .directory(project.toFile())
                .redirectErrorStream(true)
                .redirectOutput(project.resolve("daemon.log").toFile())
                .start();

        Path daemonFile = project.resolve(".ai-bdd/daemon.json");
        for (int attempt = 0; attempt < 200 && !Files.exists(daemonFile); attempt++) {
            Thread.sleep(100);
        }
        assertTrue(Files.exists(daemonFile), "the scripted daemon never wrote daemon.json");
        Map<String, Object> payload = AiBddJson.parseObject(Files.readString(daemonFile, StandardCharsets.UTF_8));
        System.setProperty("ai-bdd.daemonUrl", String.valueOf(payload.get("url")));
        System.setProperty("ai-bdd.daemonToken", String.valueOf(payload.get("token")));
        System.setProperty("ai-bdd.projectRoot", project.toString());

        JsonNode document = MAPPER.readTree(Files.readString(kit.resolve("status-aliases.json"), StandardCharsets.UTF_8));
        Iterator<String> fields = document.fieldNames();
        while (fields.hasNext()) {
            String key = fields.next();
            if (key.startsWith("_")) {
                continue;
            }
            List<String> values = new ArrayList<>();
            document.get(key).forEach(node -> values.add(node.asText()));
            aliases.put(key, values);
        }
    }

    @AfterAll
    static void stopDaemon() {
        if (daemon != null) {
            daemon.destroy();
        }
    }

    @TestFactory
    Stream<DynamicTest> kitCases() throws IOException {
        try (Stream<Path> files = Files.list(kit.resolve("expected"))) {
            return files.filter(path -> path.toString().endsWith(".json"))
                    .sorted(Comparator.comparing(path -> path.getFileName().toString()))
                    .map(path -> DynamicTest.dynamicTest(path.getFileName().toString(), () -> runCase(path)))
                    .toList()
                    .stream();
        }
    }

    private void runCase(Path expectedFile) throws IOException {
        JsonNode expected = MAPPER.readTree(Files.readString(expectedFile, StandardCharsets.UTF_8));
        String feature = expected.get("feature").asText();
        Path report = Files.createTempFile("ai-bdd-jvm-", ".json");
        Files.deleteIfExists(report);

        byte exit = Main.run(new String[] {
                "--glue", "dev.ai.bdd.cucumber.steps",
                "--plugin", "json:" + report,
                "--monochrome",
                "--no-dry-run",
                kit.resolve("features").resolve(feature).toString(),
        }, Thread.currentThread().getContextClassLoader());
        assertTrue(Files.exists(report), "Cucumber produced no report (exit " + exit + ")");

        List<String> statuses = new ArrayList<>();
        JsonNode document = MAPPER.readTree(Files.readString(report, StandardCharsets.UTF_8));
        for (JsonNode featureNode : document) {
            for (JsonNode element : featureNode.path("elements")) {
                for (JsonNode step : element.path("steps")) {
                    statuses.add(step.path("result").path("status").asText("undefined"));
                }
            }
        }

        List<JsonNode> expectedSteps = new ArrayList<>();
        expected.path("steps").forEach(expectedSteps::add);
        assertEquals(expectedSteps.size(), statuses.size(), "step count for " + feature + ": " + statuses);
        for (int index = 0; index < expectedSteps.size(); index++) {
            String wanted = expectedSteps.get(index).path("status").asText();
            String got = statuses.get(index);
            assertTrue(
                    wanted.equals(got) || aliases.getOrDefault(wanted, List.of()).contains(got),
                    feature + " step " + index + ": expected " + wanted + ", Cucumber reported " + got);
        }
    }
}
