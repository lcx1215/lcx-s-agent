// Must stay the first import: the controller's module graph reaches the i18n layer,
// which touches `localStorage` at import time. See the shim's own comment.
import "./test-storage-shim.ts";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../app-defaults.ts";
import {
  addCronJob,
  cancelCronEdit,
  loadCronJobsPage,
  loadCronRuns,
  loadMoreCronRuns,
  normalizeCronFormState,
  runCronJob,
  startCronEdit,
  startCronClone,
  validateCronForm,
  type CronState,
} from "./cron.ts";

function createState(overrides: Partial<CronState> = {}): CronState {
  return {
    client: null,
    connected: true,
    cronLoading: false,
    cronJobsLoadingMore: false,
    cronJobs: [],
    cronJobsTotal: 0,
    cronJobsHasMore: false,
    cronJobsNextOffset: null,
    cronJobsLimit: 50,
    cronJobsQuery: "",
    cronJobsEnabledFilter: "all",
    cronJobsScheduleKindFilter: "all",
    cronJobsLastStatusFilter: "all",
    cronJobsSortBy: "nextRunAtMs",
    cronJobsSortDir: "asc",
    cronStatus: null,
    cronError: null,
    cronForm: { ...DEFAULT_CRON_FORM },
    cronFieldErrors: {},
    cronEditingJobId: null,
    cronRunsJobId: null,
    cronRunsLoadingMore: false,
    cronRuns: [],
    cronRunsTotal: 0,
    cronRunsHasMore: false,
    cronRunsNextOffset: null,
    cronRunsLimit: 50,
    cronRunsScope: "all",
    cronRunsStatuses: [],
    cronRunsDeliveryStatuses: [],
    cronRunsStatusFilter: "all",
    cronRunsQuery: "",
    cronRunsSortDir: "desc",
    cronBusy: false,
    ...overrides,
  };
}

describe("cron controller", () => {
  it("normalizes stale announce mode when session/payload no longer support announce", () => {
    const normalized = normalizeCronFormState({
      ...DEFAULT_CRON_FORM,
      sessionTarget: "main",
      payloadKind: "systemEvent",
      deliveryMode: "announce",
    });

    expect(normalized.deliveryMode).toBe("none");
  });

  it("keeps announce mode when isolated agentTurn supports announce", () => {
    const normalized = normalizeCronFormState({
      ...DEFAULT_CRON_FORM,
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      deliveryMode: "announce",
    });

    expect(normalized.deliveryMode).toBe("announce");
  });

  it("forwards webhook delivery in cron.add payload", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-1" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "webhook job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "run this",
        deliveryMode: "webhook",
        deliveryTo: "https://example.invalid/cron",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall).toBeDefined();
    expect(addCall?.[1]).toMatchObject({
      name: "webhook job",
      delivery: { mode: "webhook", to: "https://example.invalid/cron" },
    });
  });

  it("forwards sessionKey and delivery accountId in cron.add payload", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-3" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "account-routed",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        sessionTarget: "isolated",
        payloadKind: "agentTurn",
        payloadText: "run this",
        sessionKey: "agent:ops:main",
        deliveryMode: "announce",
        deliveryAccountId: "ops-bot",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall).toBeDefined();
    expect(addCall?.[1]).toMatchObject({
      sessionKey: "agent:ops:main",
      delivery: { mode: "announce", accountId: "ops-bot" },
    });
  });

  it("forwards lightContext in cron payload", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-light" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "light-context job",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        sessionTarget: "isolated",
        payloadKind: "agentTurn",
        payloadText: "run this",
        payloadLightContext: true,
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall).toBeDefined();
    expect(addCall?.[1]).toMatchObject({
      payload: { kind: "agentTurn", lightContext: true },
    });
  });

  it('sends delivery: { mode: "none" } explicitly in cron.add payload', async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-none-add" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "none delivery job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "run this",
        deliveryMode: "none",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall).toBeDefined();
    expect((addCall?.[1] as { delivery?: unknown } | undefined)?.delivery).toEqual({
      mode: "none",
    });
  });

  it('sends delivery: { mode: "none" } explicitly in cron.update patch', async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-none-update" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-none-update" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronEditingJobId: "job-none-update",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "switch to none",
        scheduleKind: "every",
        everyAmount: "30",
        everyUnit: "minutes",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "do work",
        deliveryMode: "none",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(
      (updateCall?.[1] as { patch?: { delivery?: unknown } } | undefined)?.patch?.delivery,
    ).toEqual({
      mode: "none",
    });
  });

  it("does not submit stale announce delivery when unsupported", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-2" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "main job",
        scheduleKind: "every",
        everyAmount: "1",
        everyUnit: "minutes",
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payloadKind: "systemEvent",
        payloadText: "run this",
        deliveryMode: "announce",
        deliveryTo: "buddy",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall).toBeDefined();
    expect(addCall?.[1]).toMatchObject({
      name: "main job",
    });
    // Delivery is explicitly sent as { mode: "none" } to clear the announce delivery on the backend.
    // Previously this was sent as undefined, which left announce in place (bug #31075).
    expect((addCall?.[1] as { delivery?: unknown } | undefined)?.delivery).toEqual({
      mode: "none",
    });
    // After submit, form is reset to defaults (deliveryMode = "announce" from DEFAULT_CRON_FORM).
    expect(state.cronForm.deliveryMode).toBe("announce");
  });

  it("submits cron.update when editing an existing job", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-1" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-1" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: {
        request,
      } as unknown as CronState["client"],
      cronEditingJobId: "job-1",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "edited job",
        description: "",
        clearAgent: true,
        deleteAfterRun: false,
        scheduleKind: "cron",
        cronExpr: "0 8 * * *",
        scheduleExact: true,
        payloadKind: "systemEvent",
        payloadText: "updated",
        deliveryMode: "none",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-1",
      patch: {
        name: "edited job",
        description: "",
        agentId: null,
        deleteAfterRun: false,
        schedule: { kind: "cron", expr: "0 8 * * *", staggerMs: 0 },
        payload: { kind: "systemEvent", text: "updated" },
        delivery: { mode: "none" },
      },
    });
    expect(state.cronEditingJobId).toBeNull();
  });

  it("sends empty delivery.accountId in cron.update to clear persisted account routing", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-clear-account-id" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-clear-account-id" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });

    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-clear-account-id",
      cronJobs: [
        {
          id: "job-clear-account-id",
          name: "clear account",
          enabled: true,
          createdAtMs: 0,
          updatedAtMs: 0,
          schedule: { kind: "cron", expr: "0 * * * *" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "run" },
          delivery: { mode: "announce", accountId: "ops-bot" },
          state: {},
        },
      ],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "clear account",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payloadKind: "agentTurn",
        payloadText: "run",
        deliveryMode: "announce",
        deliveryAccountId: "   ",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-clear-account-id",
      patch: {
        delivery: {
          mode: "announce",
          accountId: "",
        },
      },
    });
  });

  it("maps a cron job into editable form fields", () => {
    const state = createState();
    const job = {
      id: "job-9",
      name: "Weekly report",
      description: "desc",
      sessionKey: "agent:ops:main",
      enabled: false,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every" as const, everyMs: 7_200_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "ship it", timeoutSeconds: 45 },
      delivery: { mode: "announce" as const, channel: "telegram", to: "123", accountId: "bot-2" },
      state: {},
    };

    startCronEdit(state, job);

    expect(state.cronEditingJobId).toBe("job-9");
    expect(state.cronRunsJobId).toBe("job-9");
    expect(state.cronForm.name).toBe("Weekly report");
    expect(state.cronForm.sessionKey).toBe("agent:ops:main");
    expect(state.cronForm.enabled).toBe(false);
    expect(state.cronForm.scheduleKind).toBe("every");
    expect(state.cronForm.everyAmount).toBe("2");
    expect(state.cronForm.everyUnit).toBe("hours");
    expect(state.cronForm.payloadKind).toBe("agentTurn");
    expect(state.cronForm.payloadText).toBe("ship it");
    expect(state.cronForm.timeoutSeconds).toBe("45");
    expect(state.cronForm.deliveryMode).toBe("announce");
    expect(state.cronForm.deliveryChannel).toBe("telegram");
    expect(state.cronForm.deliveryTo).toBe("123");
    expect(state.cronForm.deliveryAccountId).toBe("bot-2");
  });

  it("includes model/thinking/stagger/bestEffort in cron.update patch", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-2" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-2" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-2",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "advanced edit",
        scheduleKind: "cron",
        cronExpr: "0 9 * * *",
        staggerAmount: "30",
        staggerUnit: "seconds",
        payloadKind: "agentTurn",
        payloadText: "run it",
        payloadModel: "opus",
        payloadThinking: "low",
        deliveryMode: "announce",
        deliveryBestEffort: true,
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-2",
      patch: {
        schedule: { kind: "cron", expr: "0 9 * * *", staggerMs: 30_000 },
        payload: {
          kind: "agentTurn",
          message: "run it",
          model: "opus",
          thinking: "low",
        },
        delivery: { mode: "announce", bestEffort: true },
      },
    });
  });

  it("sends lightContext=false in cron.update when clearing prior light-context setting", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-clear-light" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-clear-light" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-clear-light",
      cronJobs: [
        {
          id: "job-clear-light",
          name: "Light job",
          enabled: true,
          createdAtMs: 0,
          updatedAtMs: 0,
          schedule: { kind: "cron", expr: "0 9 * * *" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "run", lightContext: true },
          state: {},
        },
      ],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "Light job",
        scheduleKind: "cron",
        cronExpr: "0 9 * * *",
        payloadKind: "agentTurn",
        payloadText: "run",
        payloadLightContext: false,
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-clear-light",
      patch: {
        payload: {
          kind: "agentTurn",
          lightContext: false,
        },
      },
    });
  });

  it("includes custom failureAlert fields in cron.update patch", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-alert",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert job",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "3",
        failureAlertCooldownSeconds: "120",
        failureAlertChannel: "telegram",
        failureAlertTo: "123456",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-alert",
      patch: {
        failureAlert: {
          after: 3,
          cooldownMs: 120_000,
          channel: "telegram",
          to: "123456",
          mode: "announce",
          // The form leaves accountId blank here, and this is an edit, so it goes out as
          // an explicit clear rather than being dropped. `undefined` would be dropped by
          // `JSON.stringify` and read by the server as "leave the stored value alone".
          accountId: null,
        },
      },
    });
  });

  it("includes failure alert mode/accountId in cron.update patch", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert-mode" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert-mode" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-alert-mode",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert mode job",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "1",
        failureAlertDeliveryMode: "webhook",
        failureAlertAccountId: "bot-a",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-alert-mode",
      patch: {
        failureAlert: {
          after: 1,
          mode: "webhook",
          accountId: "bot-a",
        },
      },
    });
  });

  it("clears failureAlert.cooldownMs with null on edit when custom cooldown is left blank", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert-no-cooldown" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert-no-cooldown" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-alert-no-cooldown",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert job no cooldown",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "3",
        failureAlertCooldownSeconds: "",
        failureAlertChannel: "telegram",
        failureAlertTo: "123456",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    const wire = JSON.parse(JSON.stringify(updateCall?.[1])) as {
      patch: { failureAlert: Record<string, unknown> };
    };
    // A blank field must never turn into a bogus `0`, and on an edit it must be an
    // explicit clear (`null`) rather than a dropped key -- a dropped key reads as "leave
    // the stored value alone", which is exactly the silent no-op this pins against.
    expect(wire.patch.failureAlert).toEqual({
      after: 3,
      channel: "telegram",
      to: "123456",
      cooldownMs: null,
      mode: "announce",
      accountId: null,
    });
  });

  it("clears every blank optional failureAlert subfield with null on edit", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert-blank" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert-blank" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-alert-blank",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert job blank",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "",
        failureAlertCooldownSeconds: "",
        failureAlertChannel: "telegram",
        failureAlertTo: "",
        failureAlertAccountId: "",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    const wire = JSON.parse(JSON.stringify(updateCall?.[1])) as {
      patch: { failureAlert: Record<string, unknown> };
    };
    expect(wire.patch.failureAlert).toEqual({
      after: null,
      channel: "telegram",
      to: null,
      cooldownMs: null,
      mode: "announce",
      accountId: null,
    });
  });

  it("omits blank optional failureAlert subfields on add, where there is nothing to clear", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-alert-blank-new" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: null,
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "new alert job blank",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "custom",
        failureAlertAfter: "",
        failureAlertCooldownSeconds: "",
        failureAlertChannel: "telegram",
        failureAlertTo: "",
        failureAlertAccountId: "",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    const wire = JSON.parse(JSON.stringify(addCall?.[1])) as {
      failureAlert: Record<string, unknown>;
    };
    // The add schema rejects `null` subfields: a brand new job has nothing to fall back
    // from, so the key must be absent rather than sent as a clear sentinel.
    expect(wire.failureAlert).toEqual({ channel: "telegram", mode: "announce" });
  });

  it("includes failureAlert=false when disabled per job", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-no-alert" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-no-alert" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-no-alert",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert off",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "disabled",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toMatchObject({
      id: "job-no-alert",
      patch: { failureAlert: false },
    });
  });

  // The "inherit" mode has no value of its own: `buildFailureAlert` returns `undefined`,
  // and `undefined` is dropped by `JSON.stringify` before the frame leaves the browser.
  // These two tests assert on the post-`JSON.stringify` shape, because that is the layer
  // the defect lived in: at the object level `undefined` looks like a present key, and
  // only after the round-trip does "cleared" collapse into "absent".
  it("sends an explicit null failureAlert when an edit returns the job to inherit", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.update") {
        return { id: "job-alert-inherit" };
      }
      if (method === "cron.list") {
        return { jobs: [{ id: "job-alert-inherit" }] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: "job-alert-inherit",
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "alert inherit",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "inherit",
      },
    });

    await addCronJob(state);

    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(updateCall).toBeDefined();
    const wire = JSON.parse(JSON.stringify(updateCall?.[1])) as {
      patch: Record<string, unknown>;
    };
    // A dropped key would be read by the server as "this patch does not touch
    // failureAlert", leaving the per-job override in place: picking "inherit" would
    // silently do nothing.
    expect(wire.patch).toHaveProperty("failureAlert", null);
  });

  it("omits failureAlert entirely when a new job inherits the global config", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-new-inherit" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronEditingJobId: null,
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "new inherit job",
        payloadKind: "agentTurn",
        payloadText: "run it",
        failureAlertMode: "inherit",
      },
    });

    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    expect(addCall).toBeDefined();
    const wire = JSON.parse(JSON.stringify(addCall?.[1])) as Record<string, unknown>;
    // A new job has no override to clear, and the add schema rejects `null`, so the
    // key must be absent rather than sent as a clear sentinel.
    expect(wire).not.toHaveProperty("failureAlert");
  });

  it("maps cron stagger, model, thinking, and best effort into form", () => {
    const state = createState();
    const job = {
      id: "job-10",
      name: "Advanced job",
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 7 * * *", tz: "UTC", staggerMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: {
        kind: "agentTurn" as const,
        message: "hi",
        model: "opus",
        thinking: "high",
      },
      delivery: { mode: "announce" as const, bestEffort: true },
      state: {},
    };
    startCronEdit(state, job);

    expect(state.cronForm.deleteAfterRun).toBe(true);
    expect(state.cronForm.scheduleKind).toBe("cron");
    expect(state.cronForm.scheduleExact).toBe(false);
    expect(state.cronForm.staggerAmount).toBe("1");
    expect(state.cronForm.staggerUnit).toBe("minutes");
    expect(state.cronForm.payloadModel).toBe("opus");
    expect(state.cronForm.payloadThinking).toBe("high");
    expect(state.cronForm.deliveryBestEffort).toBe(true);
  });

  it("maps failureAlert overrides into form fields", () => {
    const state = createState();
    const job = {
      id: "job-11",
      name: "Failure alerts",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "hello" },
      failureAlert: {
        after: 4,
        cooldownMs: 30_000,
        channel: "telegram",
        to: "999",
      },
      state: {},
    };

    startCronEdit(state, job);

    expect(state.cronForm.failureAlertMode).toBe("custom");
    expect(state.cronForm.failureAlertAfter).toBe("4");
    expect(state.cronForm.failureAlertCooldownSeconds).toBe("30");
    expect(state.cronForm.failureAlertChannel).toBe("telegram");
    expect(state.cronForm.failureAlertTo).toBe("999");
    expect(state.cronForm.failureAlertDeliveryMode).toBe("announce");
    expect(state.cronForm.failureAlertAccountId).toBe("");
  });

  it("validates key cron form errors", () => {
    const errors = validateCronForm({
      ...DEFAULT_CRON_FORM,
      name: "",
      scheduleKind: "cron",
      cronExpr: "",
      payloadKind: "agentTurn",
      payloadText: "",
      timeoutSeconds: "0",
      deliveryMode: "webhook",
      deliveryTo: "ftp://bad",
    });
    expect(errors.name).toBe("cron.errors.nameRequired");
    expect(errors.cronExpr).toBe("cron.errors.cronExprRequired");
    expect(errors.payloadText).toBe("cron.errors.agentMessageRequired");
    expect(errors.timeoutSeconds).toBe("cron.errors.timeoutInvalid");
    expect(errors.deliveryTo).toBe("cron.errors.webhookUrlInvalid");
  });

  it("blocks add/update submit when validation errors exist", async () => {
    const request = vi.fn(async () => ({}));
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "",
        payloadText: "",
      },
    });
    await addCronJob(state);
    expect(request).not.toHaveBeenCalled();
    expect(state.cronFieldErrors.name).toBeDefined();
    expect(state.cronFieldErrors.payloadText).toBeDefined();
  });

  it("canceling edit resets form to defaults and clears edit mode", () => {
    const state = createState();
    const job = {
      id: "job-cancel",
      name: "Editable",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 6 * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run" },
      delivery: { mode: "announce" as const, to: "123" },
      state: {},
    };
    startCronEdit(state, job);
    state.cronForm.name = "changed";
    state.cronFieldErrors = { name: "Name is required." };

    cancelCronEdit(state);

    expect(state.cronEditingJobId).toBeNull();
    expect(state.cronForm).toEqual({ ...DEFAULT_CRON_FORM });
    expect(state.cronFieldErrors).toEqual(validateCronForm(DEFAULT_CRON_FORM));
  });

  it("cloning a job switches to create mode and applies copy naming", () => {
    const state = createState({
      cronJobs: [
        {
          id: "job-1",
          name: "Daily ping",
          enabled: true,
          createdAtMs: 0,
          updatedAtMs: 0,
          schedule: { kind: "cron", expr: "0 9 * * *" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "ping" },
          state: {},
        },
      ],
      cronEditingJobId: "job-1",
    });

    const sourceJob = state.cronJobs[0];
    expect(sourceJob).toBeDefined();
    if (!sourceJob) {
      return;
    }
    startCronClone(state, sourceJob);

    expect(state.cronEditingJobId).toBeNull();
    expect(state.cronRunsJobId).toBe("job-1");
    expect(state.cronForm.name).toBe("Daily ping copy");
    expect(state.cronForm.payloadText).toBe("ping");
  });

  it("submits cron.add after cloning", async () => {
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "cron.add") {
        return { id: "job-new" };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 0, nextWakeAtMs: null };
      }
      return {};
    });
    const sourceJob = {
      id: "job-1",
      name: "Daily ping",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 9 * * *" },
      sessionTarget: "main" as const,
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "systemEvent" as const, text: "ping" },
      state: {},
    };
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobs: [sourceJob],
      cronEditingJobId: "job-1",
    });

    startCronClone(state, sourceJob);
    await addCronJob(state);

    const addCall = request.mock.calls.find(([method]) => method === "cron.add");
    const updateCall = request.mock.calls.find(([method]) => method === "cron.update");
    expect(addCall).toBeDefined();
    expect(updateCall).toBeUndefined();
    expect((addCall?.[1] as { name?: string } | undefined)?.name).toBe("Daily ping copy");
  });

  it("loads paged jobs with query/filter/sort params", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.list") {
        expect(payload).toMatchObject({
          limit: 50,
          offset: 0,
          query: "daily",
          enabled: "enabled",
          sortBy: "updatedAtMs",
          sortDir: "desc",
        });
        return {
          jobs: [{ id: "job-1", name: "Daily", enabled: true }],
          total: 1,
          hasMore: false,
          nextOffset: null,
        };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronJobsQuery: "daily",
      cronJobsEnabledFilter: "enabled",
      cronJobsSortBy: "updatedAtMs",
      cronJobsSortDir: "desc",
    });

    await loadCronJobsPage(state);

    expect(state.cronJobs).toHaveLength(1);
    expect(state.cronJobsTotal).toBe(1);
    expect(state.cronJobsHasMore).toBe(false);
  });

  it("loads and appends paged run history", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method !== "cron.runs") {
        return {};
      }
      const offset = (payload as { offset?: number } | undefined)?.offset ?? 0;
      if (offset === 0) {
        return {
          entries: [{ ts: 2, jobId: "job-1", status: "ok", summary: "newest" }],
          total: 2,
          hasMore: true,
          nextOffset: 1,
        };
      }
      return {
        entries: [{ ts: 1, jobId: "job-1", status: "ok", summary: "older" }],
        total: 2,
        hasMore: false,
        nextOffset: null,
      };
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
    });

    await loadCronRuns(state, "job-1");
    expect(state.cronRuns).toHaveLength(1);
    expect(state.cronRunsHasMore).toBe(true);

    await loadMoreCronRuns(state);
    expect(state.cronRuns).toHaveLength(2);
    expect(state.cronRuns[0]?.summary).toBe("newest");
    expect(state.cronRuns[1]?.summary).toBe("older");
  });

  it("runs cron job in due mode when requested", async () => {
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.run") {
        expect(payload).toMatchObject({ id: "job-due", mode: "due" });
        return { ok: true };
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, hasMore: false, nextOffset: null };
      }
      return {};
    });
    const state = createState({
      client: { request } as unknown as CronState["client"],
      cronRunsScope: "job",
      cronRunsJobId: "job-due",
    });
    const job = {
      id: "job-due",
      name: "Due test",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 * * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run" },
      state: {},
    };

    await runCronJob(state, job, "due");

    expect(request).toHaveBeenCalledWith("cron.run", { id: "job-due", mode: "due" });
  });
});
