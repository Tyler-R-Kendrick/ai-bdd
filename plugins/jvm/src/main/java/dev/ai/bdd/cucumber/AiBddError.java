package dev.ai.bdd.cucumber;

/** An AiBddError payload returned by the daemon. */
public final class AiBddError extends RuntimeException {

    private final String code;
    private final boolean retryable;

    public AiBddError(String code, String message, boolean retryable) {
        super(code + ": " + message);
        this.code = code;
        this.retryable = retryable;
    }

    public String code() {
        return code;
    }

    public boolean retryable() {
        return retryable;
    }
}
