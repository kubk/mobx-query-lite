import {
  actionBound,
  computed,
  makeAutoObservable,
  makeObservable,
  observable,
  onBecomeObserved,
  onBecomeUnobserved,
  runInAction,
} from "mobx";
import { inMemoryCache } from "./cache.ts";
import { hashKey, partialMatchKey, type QueryKey } from "./query-key.ts";
import { toError } from "./to-error.ts";

type QueryConfig<T> = {
  query: () => Promise<T>;
  key: QueryKey;
};

type QueryConfigFactory<T> = () => QueryConfig<T>;

export type QueryOptions = {
  gcTime?: number;
  staleTime?: number;
};

export type InvalidateOptions = {
  refetchInactive?: boolean;
};

export type InvalidateQueriesFilters = InvalidateOptions & {
  // Matches every query whose key starts with this one, like React Query's queryKey filter
  key: QueryKey;
  // Only match a query with exactly this key
  exact?: boolean;
};

export type QueryState<T> = {
  // True while there is no data and no error
  isPending: boolean;
  // True during any fetch
  isFetching: boolean;
  lastFetched: number | null;
  data: T | undefined;
  error: Error | null;
  staleTime: number;
  invalidate: (options?: InvalidateOptions) => Promise<void>;
  prefetch: () => Promise<void>;
  refetch: () => Promise<void>;
  setData: (data: T | undefined) => void;
};

// Live queries by hashKey(key)
export const queryRegistry = new Map<string, StaticQuery<any>>();

export async function invalidateQueries({
  key,
  exact,
  ...options
}: InvalidateQueriesFilters) {
  const hash = hashKey(key);
  await Promise.all(
    Array.from(queryRegistry.entries())
      .filter(([queryHash, query]) =>
        exact ? queryHash === hash : partialMatchKey(query.key, key),
      )
      .map(([, query]) => query.invalidate(options)),
  );
}

export async function refetchActiveQueries() {
  await Promise.all(
    Array.from(queryRegistry.values())
      .filter((query) => query.isActive)
      .map((query) => query.refetch()),
  );
}

export function refetchActiveQueriesOnVisible(minInterval = 5000) {
  let lastRefetchAt = -Infinity;

  const onVisibilityChange = () => {
    const now = Date.now();
    if (
      document.visibilityState !== "visible" ||
      now - lastRefetchAt < minInterval
    ) {
      return;
    }

    lastRefetchAt = now;
    refetchActiveQueries();
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

export function makeQuery<T>(
  fetcher: QueryConfig<T> | QueryConfigFactory<T>,
  options?: QueryOptions,
): QueryState<T> {
  if (typeof fetcher === "function") {
    return new DynamicQuery(fetcher, options);
  }

  return makeStaticQuery(fetcher, options);
}

function makeStaticQuery<T>(
  fetcher: QueryConfig<T>,
  options?: QueryOptions,
): QueryState<T> {
  const hash = hashKey(fetcher.key);

  const existing = queryRegistry.get(hash) as StaticQuery<T> | undefined;
  if (existing) {
    return existing;
  }

  const state = new StaticQuery(fetcher, options);

  queryRegistry.set(hash, state);

  return state;
}

class StaticQuery<T> implements QueryState<T> {
  data: T | undefined;
  isFetching = false;
  lastFetched: number | null;
  error: Error | null = null;
  staleTime: number;
  private fetchId = 0;
  private gcTimeout: ReturnType<typeof setTimeout> | undefined;
  private gcTime: number;
  isActive = false;
  private isInvalidated = false;
  private invalidationId = 0;
  private hash: string;

  constructor(
    private fetcher: QueryConfig<T>,
    options?: QueryOptions,
  ) {
    this.hash = hashKey(fetcher.key);
    const cached = inMemoryCache.get<T>(this.hash);

    this.data = cached?.data;
    this.lastFetched = cached?.lastFetched ?? null;
    this.gcTime = options?.gcTime ?? 5 * 60 * 1000;
    this.staleTime = options?.staleTime ?? 5 * 60 * 1000;

    makeObservable(this, {
      data: observable,
      error: observable,
      invalidate: actionBound,
      isFetching: observable,
      isPending: computed,
      lastFetched: observable,
      prefetch: actionBound,
      refetch: actionBound,
      setData: actionBound,
    });

    onBecomeObserved(this, "data", () => {
      this.registerIfMissing();
      this.isActive = true;
      this.clearGcTimeout();

      queueMicrotask(() => {
        this.prefetch();
      });
    });

    onBecomeUnobserved(this, "data", () => {
      this.isActive = false;
      this.scheduleGc();
    });

    this.scheduleGc();
  }

  get key() {
    return this.fetcher.key;
  }

  get isPending() {
    return this.data === undefined && !this.error;
  }

  isStale() {
    if (this.isInvalidated) return true;
    if (!this.lastFetched) return true;
    return Date.now() - this.lastFetched > this.staleTime;
  }

  invalidate(options?: InvalidateOptions) {
    this.registerIfMissing();
    this.scheduleGc();
    this.isInvalidated = true;
    this.invalidationId += 1;

    if (this.isActive || options?.refetchInactive) {
      return this.refetch();
    }

    return Promise.resolve();
  }

  prefetch() {
    if (this.isStale() && !this.isFetching) {
      return this.refetch();
    }

    return Promise.resolve();
  }

  async refetch() {
    this.registerIfMissing();
    this.scheduleGc();

    const currentFetchId = this.fetchId + 1;
    const currentInvalidationId = this.invalidationId;
    this.fetchId = currentFetchId;
    this.isFetching = true;
    this.error = null;

    let data: T;
    try {
      data = await this.fetcher.query();
    } catch (error) {
      // An action only covers the synchronous part of an async method, so writes after `await` need their own
      runInAction(() => {
        if (this.fetchId === currentFetchId) {
          this.error = toError(error);
          this.isFetching = false;
        }
      });
      return;
    }

    if (this.fetchId !== currentFetchId) {
      return;
    }

    const lastFetched = Date.now();
    runInAction(() => {
      this.data = data;
      this.lastFetched = lastFetched;
      this.isFetching = false;
      if (this.invalidationId === currentInvalidationId) {
        this.isInvalidated = false;
      }
    });
    inMemoryCache.set(this.hash, { data, lastFetched });
  }

  setData(data: T | undefined) {
    this.registerIfMissing();
    this.scheduleGc();

    // Data set by hand, such as an optimistic update, wins over responses of requests started before it
    this.fetchId += 1;
    this.isFetching = false;

    const lastFetched = Date.now();
    this.data = data;
    this.lastFetched = lastFetched;
    this.error = null;
    this.isInvalidated = false;
    inMemoryCache.set(this.hash, { data, lastFetched });
  }

  private registerIfMissing() {
    if (!queryRegistry.has(this.hash)) {
      queryRegistry.set(this.hash, this);
    }
  }

  private clearGcTimeout() {
    if (this.gcTimeout !== undefined) {
      clearTimeout(this.gcTimeout);
      this.gcTimeout = undefined;
    }
  }

  private scheduleGc() {
    this.clearGcTimeout();

    if (this.isActive || this.gcTime === Infinity) {
      return;
    }

    this.gcTimeout = setTimeout(
      () => {
        this.gcTimeout = undefined;

        if (this.isFetching) {
          this.scheduleGc();
          return;
        }

        if (queryRegistry.get(this.hash) === this) {
          queryRegistry.delete(this.hash);
          inMemoryCache.delete(this.hash);
          runInAction(() => {
            this.data = undefined;
            this.lastFetched = null;
            this.error = null;
          });
        }
      },
      Math.max(this.gcTime, 0),
    );
  }
}

class DynamicQuery<T> implements QueryState<T> {
  readonly #currentQuery: () => QueryState<T>;

  constructor(getConfig: QueryConfigFactory<T>, options?: QueryOptions) {
    this.#currentQuery = () => makeStaticQuery(getConfig(), options);
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get data() {
    return this.#currentQuery().data;
  }

  get error() {
    return this.#currentQuery().error;
  }

  get isPending() {
    return this.#currentQuery().isPending;
  }

  get isFetching() {
    return this.#currentQuery().isFetching;
  }

  get lastFetched() {
    return this.#currentQuery().lastFetched;
  }

  get staleTime() {
    return this.#currentQuery().staleTime;
  }

  // Alias for the underlying query
  invalidate(options?: InvalidateOptions) {
    return this.#currentQuery().invalidate(options);
  }

  // Alias for the underlying query
  prefetch() {
    return this.#currentQuery().prefetch();
  }

  // Alias for the underlying query
  refetch() {
    return this.#currentQuery().refetch();
  }

  // Alias for the underlying query
  setData(data: T | undefined) {
    return this.#currentQuery().setData(data);
  }
}
