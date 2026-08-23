import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TripCache } from "../../src/cache/trip-cache.ts";
import type { AppContext } from "../../src/context.ts";
import type { Json0Op } from "../../src/ot/apply.ts";
import { buildAndSubmitOp } from "../../src/tools/shared.ts";
import type { RestClient } from "../../src/transport/rest.ts";
import type { ShareDBPool } from "../../src/transport/sharedb.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

class FakeShareDBClient extends EventEmitter {
  public version = 1;
  public subscribeCalled = 0;
  public isSubscribed = true;
  public remoteOpGeneration = 0;
  public submittedOps: Json0Op[][] = [];

  constructor(
    public currentSnapshot: TripPlan = {
      title: "Test Trip",
      sections: [],
    } as unknown as TripPlan,
  ) {
    super();
  }

  async subscribe() {
    this.subscribeCalled++;
    return this.currentSnapshot;
  }

  async submit(ops: Json0Op[]) {
    this.submittedOps.push(ops);
    this.version += 1;
    return { remoteOpObserved: false };
  }
}

describe("TripCache event listener leak", () => {
  it("unregisters remoteOp listener on invalidate", async () => {
    const fakeClient = new FakeShareDBClient();
    const fakeRest = {
      getTripWithResources: async () => ({ geos: [] }),
    } as unknown as RestClient;

    const fakePool = {
      get: () => fakeClient,
      discard: () => {},
    } as unknown as ShareDBPool;

    const cache = new TripCache(fakeRest, fakePool);

    // Initial get, should subscribe and register listener
    await cache.get("tripA");
    expect(fakeClient.listenerCount("remoteOp")).toBe(1);
    expect(fakeClient.listenerCount("reconnected")).toBe(1);

    // Invalidate, should unregister both listeners
    cache.invalidate("tripA");
    expect(fakeClient.listenerCount("remoteOp")).toBe(0);
    expect(fakeClient.listenerCount("reconnected")).toBe(0);
  });

  it("handles multiple get/invalidate cycles without leaking listeners", async () => {
    const fakeClient = new FakeShareDBClient();
    const fakeRest = {
      getTripWithResources: async () => ({ geos: [] }),
    } as unknown as RestClient;

    const fakePool = {
      get: () => fakeClient,
      discard: () => {},
    } as unknown as ShareDBPool;

    const cache = new TripCache(fakeRest, fakePool);

    for (let i = 0; i < 5; i++) {
      await cache.get("tripA");
      expect(fakeClient.listenerCount("remoteOp")).toBe(1);
      cache.invalidate("tripA");
      expect(fakeClient.listenerCount("remoteOp")).toBe(0);
    }
  });

  it("unregisters listener on clear", async () => {
    const fakeClient1 = new FakeShareDBClient();
    const fakeClient2 = new FakeShareDBClient();
    const fakeRest = {
      getTripWithResources: async () => ({ geos: [] }),
    } as unknown as RestClient;

    const fakePool = {
      get: (tripKey: string) => (tripKey === "tripA" ? fakeClient1 : fakeClient2),
      discard: () => {},
    } as unknown as ShareDBPool;

    const cache = new TripCache(fakeRest, fakePool);

    await cache.get("tripA");
    await cache.get("tripB");

    expect(fakeClient1.listenerCount("remoteOp")).toBe(1);
    expect(fakeClient2.listenerCount("remoteOp")).toBe(1);

    cache.clear();

    expect(fakeClient1.listenerCount("remoteOp")).toBe(0);
    expect(fakeClient2.listenerCount("remoteOp")).toBe(0);
  });

  it("discards the subscribed client so invalidation resubscribes from a fresh snapshot", async () => {
    const clients: FakeShareDBClient[] = [];
    let current: FakeShareDBClient | undefined;
    const fakeRest = {
      getTripWithResources: async () => ({ geos: [] }),
    } as unknown as RestClient;
    const fakePool = {
      get: () => {
        if (!current) {
          current = new FakeShareDBClient();
          clients.push(current);
        }
        return current;
      },
      discard: () => {
        current = undefined;
      },
    } as unknown as ShareDBPool;
    const cache = new TripCache(fakeRest, fakePool);

    await cache.get("tripA");
    cache.invalidate("tripA");
    await cache.get("tripA");

    expect(clients).toHaveLength(2);
    expect(clients[0]!.subscribeCalled).toBe(1);
    expect(clients[1]!.subscribeCalled).toBe(1);
  });

  it("builds against the fresh snapshot and version after reconnect", async () => {
    const initial = structuredClone(checklistTrip);
    const fakeClient = new FakeShareDBClient(initial);
    const fakeRest = {
      getTripWithResources: async () => ({ geos: [] }),
    } as unknown as RestClient;
    const fakePool = {
      get: () => fakeClient,
      discard: () => {},
    } as unknown as ShareDBPool;
    const cache = new TripCache(fakeRest, fakePool);
    await cache.get(initial.key);

    const fresh = structuredClone(initial);
    fresh.itinerary.sections.unshift({
      id: 50,
      type: "normal",
      mode: "placeList",
      heading: "Freshly added section",
      date: null,
      blocks: [],
    });
    fakeClient.currentSnapshot = fresh;
    fakeClient.version = 8;
    fakeClient.emit("reconnected");

    const ctx = {
      pool: fakePool,
      tripCache: cache,
    } as unknown as AppContext;
    const pathIndex = await buildAndSubmitOp(ctx, initial.key, (trip) => {
      const sectionIndex = trip.itinerary.sections.findIndex(
        (section) => section.heading === "Places to visit",
      );
      const insertIndex = trip.itinerary.sections[sectionIndex]!.blocks.length;
      return {
        ops: [{
          p: ["itinerary", "sections", sectionIndex, "blocks", insertIndex],
          li: { id: 700, type: "note", text: { ops: [{ insert: "Fresh path\n" }] } },
        }],
        result: sectionIndex,
      };
    });

    expect(pathIndex).toBe(2);
    expect(fakeClient.submittedOps[0]![0]!.p).toEqual([
      "itinerary",
      "sections",
      2,
      "blocks",
      1,
    ]);
    expect((await cache.getEntry(initial.key)).version).toBe(9);
  });
});
