package dev.ai.bdd.cucumber;

import java.io.File;
import java.io.IOException;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Finds annotated glue classes in the paths Cucumber hands to the backend.
 *
 * Cucumber's own java backend wraps every `@Given`/`@When`/`@Then` method, but it
 * does not expose them to other backends, so the ai-bdd backend scans the same glue
 * directories for {@link AiBddStep}-annotated methods and (optionally) for native
 * annotations it wants to publish to the daemon.
 */
final class ClassScanner {

    private ClassScanner() {
    }

    static List<Class<?>> scan(Path root, ClassLoader classLoader) {
        return scan(root, classLoader, "");
    }

    /**
     * Scans a directory for classes whose package names start with
     * {@code packagePrefix} (derived from the `classpath:` glue URI).
     */
    static List<Class<?>> scan(Path root, ClassLoader classLoader, String packagePrefix) {
        List<Class<?>> classes = new ArrayList<>();
        if (!Files.isDirectory(root)) {
            return classes;
        }
        try {
            List<Path> candidates = new ArrayList<>();
            try (var stream = Files.walk(root)) {
                stream.filter(path -> path.toString().endsWith(".class"))
                        .filter(path -> !path.toString().contains("$"))
                        .forEach(candidates::add);
            }
            URL[] urls = {root.toUri().toURL()};
            try (URLClassLoader loader = new URLClassLoader(urls, classLoader)) {
                for (Path candidate : candidates) {
                    String relative = root.relativize(candidate).toString().replace(File.separatorChar, '.');
                    String simple = relative.substring(0, relative.length() - ".class".length());
                    String className = packagePrefix == null || packagePrefix.isEmpty() ? simple : packagePrefix + "." + simple;
                    try {
                        classes.add(loader.loadClass(className));
                    } catch (ClassNotFoundException | LinkageError ignored) {
                        // a class that cannot be loaded is not glue
                    }
                }
            }
        } catch (IOException ignored) {
            return classes;
        }
        return classes;
    }

    static Optional<Class<?>> loadClass(File file) {
        try {
            String path = file.getAbsolutePath();
            int marker = Math.max(path.lastIndexOf("classes"), path.lastIndexOf("test-classes"));
            if (marker < 0) {
                return Optional.empty();
            }
            Path root = Path.of(path.substring(0, marker + "classes".length()));
            String className = root.relativize(file.toPath()).toString()
                    .replace(File.separatorChar, '.')
                    .replaceAll("\\.class$", "");
            return Optional.of(Class.forName(className));
        } catch (RuntimeException | ClassNotFoundException ignored) {
            return Optional.empty();
        }
    }
}
