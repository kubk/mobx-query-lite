// Like React Query: a key is an array, such as ["todos.list", { status: "open" }]
export type QueryKey = ReadonlyArray<unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

// Stable string identity of a key: object properties are sorted, so { a, b } and { b, a } share a cache entry
export function hashKey(key: QueryKey): string {
  return JSON.stringify(key, (_, value: unknown) => {
    if (!isPlainObject(value)) {
      return value;
    }
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, property) => {
        result[property] = value[property];
        return result;
      }, {});
  });
}

// True when `filter` is a prefix of `key`: array items match by position and objects match the properties `filter` lists
export function partialMatchKey(key: unknown, filter: unknown): boolean {
  if (key === filter) {
    return true;
  }
  if (
    typeof key !== "object" ||
    typeof filter !== "object" ||
    key === null ||
    filter === null
  ) {
    return false;
  }
  return Object.keys(filter).every((property) =>
    partialMatchKey(
      (key as Record<string, unknown>)[property],
      (filter as Record<string, unknown>)[property],
    ),
  );
}
