package dev.ai.bdd.cucumber;

import io.cucumber.core.backend.Backend;
import io.cucumber.core.backend.BackendProviderService;
import io.cucumber.core.backend.Container;
import io.cucumber.core.backend.Lookup;

import java.nio.file.Path;
import java.util.function.Supplier;

/**
 * Registers the ai-bdd backend through the {@code ServiceLoader}.
 *
 * A project only needs {@code dev.ai-bdd:ai-bdd-cucumber} on the classpath: no glue
 * annotation, no runner class.
 */
public class AiBddBackendProvider implements BackendProviderService {

    @Override
    public Backend create(Lookup lookup, Container container, Supplier<ClassLoader> classLoader) {
        String configured = System.getenv("AI_BDD_PROJECT_ROOT");
        if (configured == null || configured.isEmpty()) {
            configured = System.getProperty("ai-bdd.projectRoot", System.getProperty("user.dir"));
        }
        Path projectRoot = Path.of(configured);
        return new AiBddBackend(classLoader, projectRoot);
    }
}
