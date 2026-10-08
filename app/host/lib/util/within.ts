// An answer that only informs another, given `ms` to come: past that,
// `late()` answers instead. A peer whose session is up but whose app is
// wedged would otherwise hold the caller until the heartbeat gives up
// on it.
export async function within<T>(
  asked: Promise<T>,
  ms: number,
  late: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      asked,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(late()), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
