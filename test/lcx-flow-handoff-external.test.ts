import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendExternalMessage } from "../extensions/external/src/send.js";
import { resetInboundDedupe } from "../src/auto-reply/reply/inbound-dedupe.js";
import * as ssrf from "../src/infra/net/ssrf.js";
import { probeOriginalExternalTransport } from "./fixtures/lcx-waterflow-external-probe.js";

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("../src/shared/global-evidence-projection-source.js", () => ({
  readCanonicalGlobalEvidenceProjectionCandidate: async () => null,
}));
const roots: string[] = [];
afterEach(async () => {
  resetInboundDedupe();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function probe(fault?: Parameters<typeof probeOriginalExternalTransport>[1]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-external-native-"));
  roots.push(root);
  return probeOriginalExternalTransport(root, fault);
}
describe("original external webhook to buffered dispatcher and sender", () => {
  it("carries native inbound identity/context through private session and actual dispatcher into the HTTP receiver substitute", async () => {
    const sent: unknown[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("offline receiver requires the original JSON request body");
      }
      sent.push(JSON.parse(init.body));
      return new Response("", { status: 200 });
    });
    const run = await probe();
    const ingress = await run.submit(run.message);
    expect(ingress).toEqual({ statusCode: 202, body: { ok: true, messageId: run.message.id } });
    expect(run.inputs).toHaveLength(1);
    expect(run.inputs[0]).toMatchObject({
      BodyForAgent: run.message.text,
      MessageSid: run.message.id,
      AccountId: run.account.accountId,
      MessageThreadId: run.message.threadId,
      ReplyToId: run.message.replyToId,
    });
    expect(run.sessionWrites).toHaveLength(1);
    expect(run.dispatchResults).toEqual([
      { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
    ]);
    expect(sent).toEqual([
      expect.objectContaining({
        accountId: run.account.accountId,
        target: run.message.conversationId,
        text: "100 的 10% 是 10。",
        threadId: run.message.threadId,
        replyToId: run.message.replyToId,
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(run.statusPatches).toEqual([
      { lastInboundAt: expect.any(Number) },
      { lastOutboundAt: expect.any(Number) },
    ]);
    expect(run.errors).toEqual([]);
    const duplicate = await run.submit(run.message);
    expect(duplicate.body).toMatchObject({ duplicate: true });
    expect(run.inputs).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const proofDir = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (proofDir) {
      await fs.mkdir(proofDir, { recursive: true });
      await fs.writeFile(
        path.join(proofDir, "external-transport-native.json"),
        JSON.stringify(
          {
            boundary: "offline_transport_substitutes_no_external_delivery_claim",
            originalOwners: [
              "external.monitor",
              "inbound-context",
              "session",
              "provider-dispatcher",
              "external.send",
            ],
            substitutes: [
              "model_reply_resolver",
              "HTTP_receiver",
              "DNS",
              "optional_global_projection",
            ],
            ingress,
            resolverInput: run.inputs[0],
            sessionWrite: run.sessionWrites[0],
            dispatcherResult: run.dispatchResults[0],
            receiverRequest: sent[0],
            statusPatches: run.statusPatches,
            duplicate,
            userVisibleObserved: false,
            stillMissing: [
              "real_runtime_binding",
              "restart_probe",
              "real_external_inbound_outbound",
              "language_worker_adoption",
            ],
          },
          null,
          2,
        ) + "\n",
      );
    }
  });
  it.each([
    ["missing_body", 400],
    ["bad_auth", 401],
    ["unallowed_sender", 403],
  ] as const)("blocks %s before model and sender consumers", async (fault, statusCode) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const run = await probe();
    const message =
      fault === "missing_body"
        ? { ...run.message, text: undefined }
        : fault === "unallowed_sender"
          ? { ...run.message, senderId: "untrusted" }
          : run.message;
    const result = await run.submit(message, fault === "bad_auth" ? "Bearer wrong" : undefined);
    expect(result.statusCode).toBe(statusCode);
    expect(run.inputs).toHaveLength(0);
    expect(run.statusPatches).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["missing_runtime", "resolver_error"] as const)(
    "acknowledges ingress but preserves %s without outbound success",
    async (fault) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
      const run = await probe(fault);
      expect((await run.submit(run.message)).statusCode).toBe(202);
      expect(run.statusPatches).toEqual([{ lastInboundAt: expect.any(Number) }]);
      expect(run.errors.join(" ")).toContain(
        fault === "missing_runtime" ? "runtime is unavailable" : "reply unavailable",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("preserves sender timeout as a reply failure rather than lastOutboundAt", async () => {
    let aborted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("offline receiver deadline"));
            },
            { once: true },
          );
        }),
    );
    const run = await probe();
    expect((await run.submit(run.message)).statusCode).toBe(202);
    expect(aborted).toBe(true);
    expect(run.statusPatches).toEqual([{ lastInboundAt: expect.any(Number) }]);
    expect(run.errors.join(" ")).toContain("offline receiver deadline");
  });
  it.each([
    ["cross-origin", "https://other.example/messages", null],
    ["same-origin", "/next", "offline-token"],
  ] as const)(
    "protects configured auth headers on %s redirects",
    async (_kind, location, expected) => {
      const run = await probe();
      const observed: Headers[] = [];
      await sendExternalMessage({
        account: {
          ...run.account,
          outboundUrl: "https://receiver.example/messages",
          outboundAuth: "header",
          outboundTokenHeader: "x-custom-receiver-key",
          outboundToken: "offline-token",
        },
        target: "offline-conversation",
        text: "offline redirect check",
        fetchImpl: async (_url, init) => {
          observed.push(new Headers(init?.headers));
          return observed.length === 1
            ? new Response(null, { status: 307, headers: { location } })
            : new Response(null, { status: 200 });
        },
      });
      expect(observed).toHaveLength(2);
      expect(observed[0].get("x-custom-receiver-key")).toBe("offline-token");
      expect(observed[1].get("x-custom-receiver-key")).toBe(expected);
    },
  );

  it("releases an unread successful receiver body before returning delivery acknowledgement", async () => {
    const cancel = vi.fn();
    const run = await probe();
    const result = await sendExternalMessage({
      account: run.account,
      target: "offline-conversation",
      text: "100 的 10% 是 10。",
      messageId: "body-cleanup",
      fetchImpl: async () => new Response(new ReadableStream({ cancel }), { status: 200 }),
    });
    expect(result.messageId).toBe("body-cleanup");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["rejected", "pending"] as const)(
    "keeps %s body cleanup unconfirmed instead of acknowledging success",
    async (fault) => {
      const run = await probe();
      const release = vi.spyOn(ssrf, "closeDispatcher");
      await expect(
        sendExternalMessage({
          account: run.account,
          target: "offline-conversation",
          text: "100 的 10% 是 10。",
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                cancel: () =>
                  fault === "pending"
                    ? new Promise<void>(() => {})
                    : Promise.reject(new Error("cancel rejected")),
              }),
              { status: 200 },
            ),
        }),
      ).rejects.toThrow("body cleanup unconfirmed");
      expect(release).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["confirmed", "rejected", "pending"] as const)(
    "bounds a non-200 response body with %s cleanup on the same deadline",
    async (cleanup) => {
      const run = await probe();
      const cancel = vi.fn(() =>
        cleanup === "pending"
          ? new Promise<void>(() => {})
          : cleanup === "rejected"
            ? Promise.reject(new Error("cancel rejected"))
            : Promise.resolve(),
      );
      const release = vi.spyOn(ssrf, "closeDispatcher");
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
          },
          cancel,
        }),
        { status: 500 },
      );
      const pending = sendExternalMessage({
        account: run.account,
        target: "offline-conversation",
        text: "test",
        fetchImpl: async () => response,
      }).then(
        () => "unexpected_success",
        (error: unknown) => String(error),
      );
      let observationTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const observed = await Promise.race([
          pending,
          new Promise<string>((resolve) => {
            observationTimer = setTimeout(() => resolve("still_pending"), 80);
          }),
        ]);
        expect(observed).not.toBe("still_pending");
        expect(observed).toContain("HTTP 500");
        expect(observed).toContain("deadline");
        expect(observed).toContain(
          cleanup === "confirmed" ? "cleanup_confirmed" : "cleanup_unconfirmed",
        );
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(response.body?.locked).toBe(false);
        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        clearTimeout(observationTimer);
        if (response.body?.locked) {
          source?.close();
        }
        await pending;
      }
    },
  );
  it("limits non-200 diagnostics and cancels the unread remainder", async () => {
    const run = await probe();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(8192)));
        },
        cancel,
      }),
      { status: 403 },
    );
    const failed = await sendExternalMessage({
      account: run.account,
      target: "offline-conversation",
      text: "test",
      fetchImpl: async () => response,
    }).then(
      () => "unexpected_success",
      (error: unknown) => String(error),
    );
    expect(failed).toContain("HTTP 403");
    expect(failed).toContain("diagnostic body truncated");
    expect(failed.length).toBeLessThan(4300);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });
  it("cleans a late body but cannot return success after caller cancellation", async () => {
    const run = await probe();
    const controller = new AbortController();
    const cancel = vi.fn();
    await expect(
      sendExternalMessage({
        account: run.account,
        target: "offline-conversation",
        text: "100 的 10% 是 10。",
        signal: controller.signal,
        fetchImpl: async () => {
          controller.abort(new Error("offline caller cancelled"));
          return new Response(new ReadableStream({ cancel }), { status: 200 });
        },
      }),
    ).rejects.toThrow("offline caller cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("cleans a late 200 body but cannot return success after the account deadline without caller abort", async () => {
    const run = await probe();
    const cancel = vi.fn();
    const release = vi.spyOn(ssrf, "closeDispatcher");
    await expect(
      sendExternalMessage({
        account: { ...run.account, timeoutMs: 10 },
        target: "offline-conversation",
        text: "test",
        fetchImpl: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          return new Response(new ReadableStream({ cancel }), { status: 200 });
        },
      }),
    ).rejects.toThrow("external response deadline exceeded");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each([200, 500])(
    "bounds a pending dispatcher release after HTTP %s and keeps its failure after late release",
    async (status) => {
      const run = await probe();
      const closeOriginal = ssrf.closeDispatcher;
      let settleRelease: (() => void) | undefined;
      const releaseWait = new Promise<void>((resolve) => {
        settleRelease = resolve;
      });
      const release = vi.spyOn(ssrf, "closeDispatcher").mockImplementation(async (dispatcher) => {
        await releaseWait;
        await closeOriginal(dispatcher);
      });
      const outcome = sendExternalMessage({
        account: run.account,
        target: "offline-conversation",
        text: "test",
        fetchImpl: async () => new Response("offline HTTP diagnostic", { status }),
      }).then(
        () => "unexpected_success",
        (error: unknown) => String(error),
      );
      let observationTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const observed = await Promise.race([
          outcome,
          new Promise<string>((resolve) => {
            observationTimer = setTimeout(() => resolve("still_pending"), 80);
          }),
        ]);
        expect(observed).not.toBe("still_pending");
        expect(observed).toContain("dispatcher cleanup unconfirmed");
        if (status === 500) {
          expect(observed).toContain("HTTP 500");
          expect(observed).toContain("offline HTTP diagnostic");
        }
        expect(release).toHaveBeenCalledTimes(1);
        settleRelease?.();
        await releaseWait;
        expect(await outcome).toBe(observed);
      } finally {
        clearTimeout(observationTimer);
        settleRelease?.();
        await outcome;
      }
    },
  );
  it("reports an indefinitely pending dispatcher release without losing the HTTP failure", async () => {
    const run = await probe();
    const closeOriginal = ssrf.closeDispatcher;
    const release = vi
      .spyOn(ssrf, "closeDispatcher")
      .mockImplementation(async () => await new Promise<void>(() => {}));
    try {
      const terminal = await sendExternalMessage({
        account: run.account,
        target: "offline-conversation",
        text: "test",
        fetchImpl: async () => new Response("offline HTTP diagnostic", { status: 500 }),
      }).then(
        () => "unexpected_success",
        (error: unknown) => String(error),
      );
      expect(terminal).toContain("HTTP 500: offline HTTP diagnostic");
      expect(terminal).toContain("dispatcher cleanup unconfirmed");
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      // The test substitute never settles; dispose only its unused private Agent.
      await closeOriginal(release.mock.calls[0]?.[0]);
    }
  });
  it("does not acknowledge success when the caller cancels during dispatcher release", async () => {
    const run = await probe();
    const closeOriginal = ssrf.closeDispatcher;
    const controller = new AbortController();
    vi.spyOn(ssrf, "closeDispatcher").mockImplementation(async (dispatcher) => {
      controller.abort(new Error("offline cancelled during release"));
      await closeOriginal(dispatcher);
    });
    await expect(
      sendExternalMessage({
        account: run.account,
        target: "offline-conversation",
        text: "test",
        signal: controller.signal,
        fetchImpl: async () => new Response("", { status: 200 }),
      }),
    ).rejects.toThrow("offline cancelled during release");
  });
});
