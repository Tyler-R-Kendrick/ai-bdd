package dev.ai.bdd.cucumber;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The bindings this backend owns.
 *
 * The daemon decides which binding wins; only this process can call the method,
 * which is what {@code invoke-local} asks for.
 */
public final class AiBddBindings {

    /** One registered binding: its descriptor, its method and its matcher. */
    public record Entry(String id, Map<String, Object> descriptor, Method method, Pattern matcherPattern, List<String> parameterNames) {

            /** The captured groups, in pattern order (a Cucumber Expression is positional). */
        public List<String> values(String stepText) {
            if (matcherPattern == null) {
                return List.of();
            }
            Matcher matcher = matcherPattern.matcher(stepText);
            if (!matcher.matches()) {
                return List.of();
            }
            List<String> values = new ArrayList<>();
            for (int index = 1; index <= matcher.groupCount(); index++) {
                values.add(matcher.group(index));
            }
            return values;
        }

        /**
         * The captured groups keyed by the placeholder name, for the daemon.
         *
         * A Cucumber Expression may use the same type twice (`{string}` appears in
         * most sentences), so a repeated name is suffixed with its index instead of
         * silently overwriting the earlier value. Invocation uses the positional
         * values, so nothing depends on these keys being unique.
         */
        public Map<String, Object> capture(String stepText) {
            Map<String, Object> params = new LinkedHashMap<>();
            List<String> values = values(stepText);
            Map<String, Integer> seen = new LinkedHashMap<>();
            for (int index = 0; index < parameterNames.size() && index < values.size(); index++) {
                String name = parameterNames.get(index);
                int occurrence = seen.merge(name, 1, Integer::sum);
                params.put(occurrence == 1 ? name : name + "[" + (occurrence - 1) + "]", values.get(index));
            }
            return params;
        }
    }

    private final String provider;
    private final List<Entry> entries = new ArrayList<>();

    public AiBddBindings(String provider) {
        this.provider = provider;
    }

    public synchronized String add(String pattern, String description, String kind, List<Map<String, Object>> params, Method method) {
        List<String> names = parameterNames(pattern);
        Map<String, Object> descriptor = new LinkedHashMap<>();
        String id = provider + "#" + slug(pattern) + "-" + (entries.size() + 1);
        descriptor.put("id", id);
        descriptor.put("provider", provider);
        descriptor.put("pattern", pattern);
        descriptor.put("patternKind", pattern.startsWith("^") ? "regex" : "cucumber-expression");
        descriptor.put("kind", kind == null ? "action" : kind);
        if (description != null && !description.isEmpty()) {
            descriptor.put("description", description);
        }
        if (params != null && !params.isEmpty()) {
            descriptor.put("params", params);
        }
        entries.add(new Entry(id, descriptor, method, compile(pattern), names));
        return id;
    }

    public synchronized List<Map<String, Object>> publish() {
        List<Map<String, Object>> descriptors = new ArrayList<>(entries.size());
        for (Entry entry : entries) {
            descriptors.add(entry.descriptor());
        }
        return descriptors;
    }

    public synchronized Optional<Entry> find(String id) {
        return entries.stream().filter(entry -> entry.id().equals(id)).findFirst();
    }

    /** Finds this backend's own binding for a step text (a foreign id is served here). */
    public synchronized Optional<Entry> findForStep(String stepText) {
        return entries.stream()
                .filter(entry -> entry.matcherPattern() != null && entry.matcherPattern().matcher(stepText).matches())
                .findFirst();
    }

    /**
     * Invokes a binding method with the captured values.
     *
     * A Cucumber Expression is positional, so the values are assigned to the method
     * parameters in order. When the pattern's placeholders happen to be named after
     * the parameters, the name is used instead.
     */
    public Object invoke(Entry entry, List<String> values, Map<String, Object> params) {
        Method method = entry.method();
        java.lang.reflect.Parameter[] parameters = method.getParameters();
        Class<?>[] types = method.getParameterTypes();
        Object[] arguments = new Object[parameters.length];
        for (int index = 0; index < parameters.length; index++) {
            Object value = params.get(parameters[index].getName());
            if (value == null && index < values.size()) {
                value = values.get(index);
            }
            arguments[index] = convert(value, types[index]);
        }
        try {
            method.setAccessible(true);
            Object target = java.lang.reflect.Modifier.isStatic(method.getModifiers()) ? null : newInstance(method.getDeclaringClass());
            return method.invoke(target, arguments);
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            throw new AiBddError("INTERNAL", cause == null ? error.getMessage() : cause.getMessage(), false);
        } catch (ReflectiveOperationException error) {
            throw new AiBddError("INTERNAL", "could not invoke " + method, false);
        }
    }

    private static Object newInstance(Class<?> type) throws ReflectiveOperationException {
        var constructor = type.getDeclaredConstructor();
        constructor.setAccessible(true);
        return constructor.newInstance();
    }

    private static Object convert(Object value, Class<?> type) {
        if (value == null || type.isInstance(value)) {
            return value;
        }
        String text = String.valueOf(value);
        if (type == int.class || type == Integer.class) {
            return Integer.parseInt(text.trim());
        }
        if (type == long.class || type == Long.class) {
            return Long.parseLong(text.trim());
        }
        if (type == double.class || type == Double.class) {
            return Double.parseDouble(text.trim());
        }
        if (type == boolean.class || type == Boolean.class) {
            return Boolean.parseBoolean(text.trim());
        }
        return text;
    }

    /** Compiles a Cucumber Expression or an anchored regex into a matcher. */
    static Pattern compile(String pattern) {
        if (pattern.startsWith("^") && pattern.endsWith("$")) {
            return Pattern.compile(pattern);
        }
        StringBuilder builder = new StringBuilder("^");
        int index = 0;
        Matcher matcher = PLACEHOLDER.matcher(pattern);
        while (matcher.find()) {
            builder.append(Pattern.quote(pattern.substring(index, matcher.start())));
            switch (matcher.group(1)) {
                case "int" -> builder.append("(-?\\d+)");
                case "float" -> builder.append("(-?\\d+(?:\\.\\d+)?)");
                case "word" -> builder.append("(\\w+)");
                default -> builder.append("(.*?)");
            }
            index = matcher.end();
        }
        builder.append(Pattern.quote(pattern.substring(index))).append('$');
        return Pattern.compile(builder.toString());
    }

    private static final Pattern PLACEHOLDER = Pattern.compile("\\{([a-zA-Z0-9_]+)}");

    static List<String> parameterNames(String pattern) {
        List<String> names = new ArrayList<>();
        Matcher matcher = PLACEHOLDER.matcher(pattern);
        while (matcher.find()) {
            names.add(matcher.group(1));
        }
        return names;
    }

    private static String slug(String pattern) {
        String slug = pattern.toLowerCase().replaceAll("[^a-z0-9]+", "-").replaceAll("^-|-$|-$|^-$", "");
        if (slug.length() > 40) {
            slug = slug.substring(0, 40);
        }
        return slug.isEmpty() ? "step" : slug;
    }
}
