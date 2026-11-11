import { autorun, configure } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryCache } from "./cache.ts";
import { makeInfiniteQuery } from "./make-infinite-query.ts";
import { makeMutation } from "./make-mutation.ts";
import { makeQuery, queryRegistry } from "./make-query.ts";

// MobX warns when observed state changes outside an action, which is what happens after an `await`
describe("state changes after a request run in actions", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryRegistry.clear();
    inMemoryCache.clear();
    configure({ enforceActions: "always" });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    configure({ enforceActions: "observed" });
  });

  it("makeQuery success and failure", async () => {
    const ok = makeQuery({ key: ["strict-ok"], query: async () => 1 });
    const failing = makeQuery({
      key: ["strict-fail"],
      query: async () => {
        throw new Error("boom");
      },
    });
    const dispose = autorun(() => [ok.data, ok.isFetching, failing.error]);

    await ok.refetch();
    await failing.refetch();

    expect(ok.data).toBe(1);
    expect(failing.error?.message).toBe("boom");
    expect(warn).not.toHaveBeenCalled();
    dispose();
  });

  it("makeInfiniteQuery next page success and failure", async () => {
    let failNext = false;
    const state = makeInfiniteQuery({
      key: ["strict-infinite"],
      query: async ({ cursor }: { cursor?: number }) => {
        if (failNext) throw new Error("next failed");
        return { items: [cursor ?? 0], nextCursor: (cursor ?? 0) + 1 };
      },
    });
    const dispose = autorun(() => [
      state.items,
      state.isFetchingNextPage,
      state.error,
    ]);

    await state.refetch();
    await state.fetchNextPage();
    failNext = true;
    await state.fetchNextPage();

    expect(state.items).toEqual([0, 1]);
    expect(state.error?.message).toBe("next failed");
    expect(warn).not.toHaveBeenCalled();
    dispose();
  });

  it("makeMutation success and failure", async () => {
    const mutation = makeMutation(async (fail: boolean) => {
      if (fail) throw new Error("mutation failed");
      return "saved";
    });
    const dispose = autorun(() => [
      mutation.data,
      mutation.isPending,
      mutation.error,
    ]);

    await mutation.mutateResult(false);
    await mutation.mutateResult(true);

    expect(mutation.data).toBe("saved");
    expect(mutation.isPending).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    dispose();
  });
});
