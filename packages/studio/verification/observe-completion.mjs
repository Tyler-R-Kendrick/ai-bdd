/** Attach both outcomes immediately, before a delayed stop can reject a subprocess. */
export function observeCompletion(completion) {
  return completion.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}
