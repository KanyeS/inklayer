import { useCallback, useEffect, useState } from "react";

/** Loads data and re-loads on demand. Errors are kept for display rather than thrown. */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | undefined; error: Error | null; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller lists what `load` depends on in `deps`
  const run = useCallback(load, deps);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}
