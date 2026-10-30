/** An uncertain provider acknowledgement remains retryable under the same durable intent ID. */
export async function dispatchDeadline<T>(
  operation: Promise<T>,
  milliseconds = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Provider dispatch confirmation exceeded its request budget.',
              ),
            ),
          milliseconds,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
