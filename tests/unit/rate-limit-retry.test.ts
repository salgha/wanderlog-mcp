import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { WanderlogError } from "../../src/errors.ts";
import type { Json0Op } from "../../src/ot/apply.ts";
import { submitOp } from "../../src/tools/shared.ts";
import { ShareDBClient, type SubmitOutcome } from "../../src/transport/sharedb.ts";

const ops: Json0Op[] = [{ p: ["days"], od: 3, oi: 5 }];

function makeFakeContext(failures: Array<Error | null>): {
  ctx: AppContext;
  submitCalls: () => number;
  invalidateCount: () => number;
  applyLocalOpCount: () => number;
} {
  let callIndex = 0;
  let invalidateCount = 0;
  let applyLocalOpCount = 0;

  const fakeClient = {
    isSubscribed: true,
    version: 0,
    remoteOpGeneration: 0,
    async submit(_ops: Json0Op[]): Promise<void> {
      const failure = failures[callIndex++];
      if (failure) throw failure;
      this.version += 1;
    },
  };

  const ctx = {
    pool: { get: () => fakeClient },
    tripCache: {
      applyLocalOp: () => {
        applyLocalOpCount++;
      },
      invalidate: () => {
        invalidateCount++;
      },
    },
  } as unknown as AppContext;

  return {
    ctx,
    submitCalls: () => callIndex,
    invalidateCount: () => invalidateCount,
    applyLocalOpCount: () => applyLocalOpCount,
  };
}

const rateLimitError = () =>
  new WanderlogError(
    "Wanderlog rejected the request (4001): Too many requests",
    "rate_limited",
  );

describe("submitOp rate-limit retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries after a rate_limited error and succeeds", async () => {
    const fake = makeFakeContext([rateLimitError(), null]);
    const promise = submitOp(fake.ctx, "tripA", ops);
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(fake.submitCalls()).toBe(2);
    expect(fake.applyLocalOpCount()).toBe(1);
    expect(fake.invalidateCount()).toBe(0);
  });

  it("does not retry when a remote op arrives before the rate-limit rejection", async () => {
    let rejectFirstSubmit!: (error: Error) => void;
    let submitCalls = 0;
    let invalidateCount = 0;
    let applyLocalOpCount = 0;
    const client = {
      isSubscribed: true,
      version: 7,
      remoteOpGeneration: 0,
      submit: () => {
        submitCalls += 1;
        if (submitCalls > 1) {
          return Promise.reject(
            new WanderlogError("stale operation was retried", "stale_op_retried"),
          );
        }
        return new Promise<void>((_resolve, reject) => {
          rejectFirstSubmit = reject;
        });
      },
    };
    const ctx = {
      pool: { get: () => client },
      tripCache: {
        applyLocalOp: () => {
          applyLocalOpCount += 1;
        },
        invalidate: () => {
          invalidateCount += 1;
        },
      },
    } as unknown as AppContext;

    const pending = submitOp(ctx, "tripA", ops);
    const result = pending.catch((error: unknown) => error);
    await Promise.resolve();
    client.remoteOpGeneration += 1;
    rejectFirstSubmit(rateLimitError());
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toMatchObject({ code: "stale_rate_limit_retry" });
    expect(submitCalls).toBe(1);
    expect(invalidateCount).toBe(1);
    expect(applyLocalOpCount).toBe(0);
  });

  it("does not retry when a remote op arrives during rate-limit backoff", async () => {
    let submitCalls = 0;
    let invalidateCount = 0;
    const client = {
      isSubscribed: true,
      version: 7,
      remoteOpGeneration: 0,
      async submit(): Promise<void> {
        submitCalls += 1;
        if (submitCalls === 1) throw rateLimitError();
        throw new WanderlogError("stale operation was retried", "stale_op_retried");
      },
    };
    const ctx = {
      pool: { get: () => client },
      tripCache: {
        applyLocalOp: () => {
          throw new Error("stale op must not be applied");
        },
        invalidate: () => {
          invalidateCount += 1;
        },
      },
    } as unknown as AppContext;

    const pending = submitOp(ctx, "tripA", ops);
    const result = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    client.remoteOpGeneration += 1;
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toMatchObject({ code: "stale_rate_limit_retry" });
    expect(submitCalls).toBe(1);
    expect(invalidateCount).toBe(1);
  });

  it("gives up after exhausting retries and invalidates the cache", async () => {
    const fake = makeFakeContext([
      rateLimitError(),
      rateLimitError(),
      rateLimitError(),
      rateLimitError(),
    ]);
    const promise = submitOp(fake.ctx, "tripA", ops);
    const assertion = expect(promise).rejects.toMatchObject({
      code: "rate_limited",
    });
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
    await assertion;
    expect(fake.submitCalls()).toBe(4);
    expect(fake.applyLocalOpCount()).toBe(0);
    expect(fake.invalidateCount()).toBe(1);
  });

  it("does not retry non-rate-limit errors", async () => {
    const fake = makeFakeContext([
      new WanderlogError("Submit op timeout", "submit_timeout"),
    ]);
    await expect(submitOp(fake.ctx, "tripA", ops)).rejects.toMatchObject({
      code: "submit_timeout",
    });
    expect(fake.submitCalls()).toBe(1);
    expect(fake.invalidateCount()).toBe(1);
  });
});

describe("ShareDBClient bare {code, message} rejection frames", () => {
  const config = {
    cookieHeader: "connect.sid=test",
    baseUrl: "https://example.test",
    wsBaseUrl: "wss://example.test",
    userAgent: "test",
  };

  function clientWithPendingOp(): {
    client: ShareDBClient;
    pending: Promise<SubmitOutcome>;
  } {
    const client = new ShareDBClient(config, "tripA");
    const internals = client as unknown as {
      pendingOps: Map<
        number,
        {
          resolve: (outcome: SubmitOutcome) => void;
          reject: (err: Error) => void;
          timer: NodeJS.Timeout;
          remoteOpObserved: boolean;
        }
      >;
      handleFrame: (
        frame: Record<string, unknown>,
        handshakeTimeout: NodeJS.Timeout,
        connectResolve: () => void,
      ) => void;
    };
    const pending = new Promise<SubmitOutcome>((resolve, reject) => {
      internals.pendingOps.set(1, {
        resolve,
        reject,
        timer: setTimeout(() => {}, 60_000),
        remoteOpObserved: false,
      });
    });
    return { client, pending };
  }

  function deliverFrame(client: ShareDBClient, frame: Record<string, unknown>) {
    (
      client as unknown as {
        handleFrame: (
          frame: Record<string, unknown>,
          handshakeTimeout: NodeJS.Timeout,
          connectResolve: () => void,
        ) => void;
      }
    ).handleFrame(frame, setTimeout(() => {}, 60_000), () => {});
  }

  it("maps code 4001 to a rate_limited error on pending ops", async () => {
    const { client, pending } = clientWithPendingOp();
    deliverFrame(client, {
      code: 4001,
      message: "Too many requests; please try again later",
    });
    await expect(pending).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("maps other bare codes to ws_rejected", async () => {
    const { client, pending } = clientWithPendingOp();
    deliverFrame(client, { code: 4999, message: "nope" });
    await expect(pending).rejects.toMatchObject({ code: "ws_rejected" });
  });

  it("does not treat op acks (which carry `a`) as rejections", async () => {
    const { client, pending } = clientWithPendingOp();
    const internals = client as unknown as { sessionId?: string };
    internals.sessionId = "session-1";
    deliverFrame(client, {
      a: "op",
      src: "session-1",
      seq: 1,
      v: 7,
      c: "TripPlans",
      d: "tripA",
    });
    await expect(pending).resolves.toEqual({ remoteOpObserved: false });
    expect(client.version).toBe(8);
  });
});
