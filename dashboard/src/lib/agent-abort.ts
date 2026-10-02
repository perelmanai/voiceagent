/** Stop waiting for non-agent setup work as soon as the user cancels. */
export function waitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Agent run cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    // Attach both handlers even when already aborted, so background rejection
    // cannot become an unhandled rejection after cancellation.
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
