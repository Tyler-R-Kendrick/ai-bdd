package dev.ai.bdd.cucumber;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A tiny JSON reader and writer, so the plugin has no runtime dependency beyond
 * cucumber-core (which is provided).
 */
public final class AiBddJson {

    private AiBddJson() {
    }

    public static Object parse(String text) {
        Parser parser = new Parser(text);
        parser.skipWhitespace();
        Object value = parser.readValue();
        parser.skipWhitespace();
        return value;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text) {
        Object value = parse(text);
        if (value instanceof Map<?, ?> map) {
            return (Map<String, Object>) map;
        }
        throw new AiBddError("INTERNAL", "expected a JSON object", false);
    }

    public static String write(Object value) {
        StringBuilder builder = new StringBuilder();
        writeValue(builder, value);
        return builder.toString();
    }

    @SuppressWarnings("unchecked")
    private static void writeValue(StringBuilder builder, Object value) {
        if (value == null) {
            builder.append("null");
        } else if (value instanceof String text) {
            writeString(builder, text);
        } else if (value instanceof Number || value instanceof Boolean) {
            builder.append(value);
        } else if (value instanceof Map<?, ?> map) {
            builder.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<String, Object>) map).entrySet()) {
                if (!first) {
                    builder.append(',');
                }
                first = false;
                writeString(builder, String.valueOf(entry.getKey()));
                builder.append(':');
                writeValue(builder, entry.getValue());
            }
            builder.append('}');
        } else if (value instanceof Iterable<?> iterable) {
            builder.append('[');
            boolean first = true;
            for (Object item : iterable) {
                if (!first) {
                    builder.append(',');
                }
                first = false;
                writeValue(builder, item);
            }
            builder.append(']');
        } else {
            writeString(builder, String.valueOf(value));
        }
    }

    private static void writeString(StringBuilder builder, String text) {
        builder.append('"');
        for (int index = 0; index < text.length(); index++) {
            char character = text.charAt(index);
            switch (character) {
                case '"' -> builder.append("\\\"");
                case '\\' -> builder.append("\\\\");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                default -> {
                    if (character < 0x20) {
                        builder.append(String.format("\\u%04x", (int) character));
                    } else {
                        builder.append(character);
                    }
                }
            }
        }
        builder.append('"');
    }

    /** A minimal recursive-descent reader for the payloads the daemon sends. */
    private static final class Parser {
        private final String text;
        private int position;

        Parser(String text) {
            this.text = text;
        }

        void skipWhitespace() {
            while (position < text.length() && Character.isWhitespace(text.charAt(position))) {
                position++;
            }
        }

        Object readValue() {
            skipWhitespace();
            if (position >= text.length()) {
                return null;
            }
            char character = text.charAt(position);
            return switch (character) {
                case '{' -> readObject();
                case '[' -> readArray();
                case '"' -> readString();
                case 't' -> readLiteral("true", Boolean.TRUE);
                case 'f' -> readLiteral("false", Boolean.FALSE);
                case 'n' -> readLiteral("null", null);
                default -> readNumber();
            };
        }

        private Map<String, Object> readObject() {
            Map<String, Object> map = new LinkedHashMap<>();
            position++;
            skipWhitespace();
            if (position < text.length() && text.charAt(position) == '}') {
                position++;
                return map;
            }
            while (position < text.length()) {
                skipWhitespace();
                String key = readString();
                skipWhitespace();
                expect(':');
                map.put(key, readValue());
                skipWhitespace();
                if (position < text.length() && text.charAt(position) == ',') {
                    position++;
                    continue;
                }
                expect('}');
                break;
            }
            return map;
        }

        private List<Object> readArray() {
            List<Object> list = new ArrayList<>();
            position++;
            skipWhitespace();
            if (position < text.length() && text.charAt(position) == ']') {
                position++;
                return list;
            }
            while (position < text.length()) {
                list.add(readValue());
                skipWhitespace();
                if (position < text.length() && text.charAt(position) == ',') {
                    position++;
                    continue;
                }
                expect(']');
                break;
            }
            return list;
        }

        private String readString() {
            expect('"');
            StringBuilder builder = new StringBuilder();
            while (position < text.length()) {
                char character = text.charAt(position++);
                if (character == '"') {
                    break;
                }
                if (character == '\\' && position < text.length()) {
                    char escaped = text.charAt(position++);
                    switch (escaped) {
                        case 'n' -> builder.append('\n');
                        case 'r' -> builder.append('\r');
                        case 't' -> builder.append('\t');
                        case 'b' -> builder.append('\b');
                        case 'f' -> builder.append('\f');
                        case 'u' -> {
                            builder.append((char) Integer.parseInt(text.substring(position, position + 4), 16));
                            position += 4;
                        }
                        default -> builder.append(escaped);
                    }
                    continue;
                }
                builder.append(character);
            }
            return builder.toString();
        }

        private Object readNumber() {
            int start = position;
            while (position < text.length() && "-+.eE0123456789".indexOf(text.charAt(position)) >= 0) {
                position++;
            }
            String raw = text.substring(start, position);
            if (raw.contains(".") || raw.contains("e") || raw.contains("E")) {
                return Double.parseDouble(raw);
            }
            return Long.parseLong(raw);
        }

        private Object readLiteral(String literal, Object value) {
            if (!text.startsWith(literal, position)) {
                throw new AiBddError("INTERNAL", "unexpected token at " + position, false);
            }
            position += literal.length();
            return value;
        }

        private void expect(char expected) {
            skipWhitespace();
            if (position >= text.length() || text.charAt(position) != expected) {
                throw new AiBddError("INTERNAL", "expected '" + expected + "' at " + position, false);
            }
            position++;
        }
    }
}
