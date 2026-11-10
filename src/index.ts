export { inMemoryCache } from "./cache.ts";
export {
  makeQuery,
  queryRegistry,
  refetchActiveQueries,
  refetchActiveQueriesOnVisible,
  type InvalidateOptions,
  type QueryOptions,
  type QueryState,
} from "./make-query.ts";
export {
  makeInfiniteQuery,
  type InfiniteQueryState,
} from "./make-infinite-query.ts";
export {
  makeMutation,
  type MutationResult,
  type MutationState,
} from "./make-mutation.ts";
