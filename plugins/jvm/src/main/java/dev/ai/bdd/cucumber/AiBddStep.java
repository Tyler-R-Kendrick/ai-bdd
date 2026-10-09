package dev.ai.bdd.cucumber;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a public method as an ai-bdd binding.
 *
 * The method is registered with the daemon (so semantic matching and the lockfile
 * see it) and stays in this process: the daemon answers {@code invoke-local} and
 * the backend invokes it.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface AiBddStep {

    /** A Cucumber Expression or an anchored regular expression. */
    String pattern();

    /** The natural-language description the resolver embeds. */
    String description() default "";

    /** setup, action or assertion. */
    String kind() default "";
}
