import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  acquireFinanceSchedulerLock,
  FINANCE_SCHEDULER_LOCK,
  FINANCE_SCHEDULER_PID,
  financeSchedulerPidPresent,
  readFinanceSchedulerPid,
} from "./finance-scheduler-lock.js";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-lock-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("excludes a second writer and releases the PID and lock idempotently", () => {
  const release = acquireFinanceSchedulerLock(directory);
  expect(readFinanceSchedulerPid(directory)).toBe(process.pid);
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("lock exists");
  release();
  release();
  expect(readFinanceSchedulerPid(directory)).toBeNull();
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
  acquireFinanceSchedulerLock(directory)();
});

it("protects the same book addressed by a directory symlink", () => {
  const book = path.join(directory, "book");
  fs.mkdirSync(book);
  const alias = path.join(directory, "alias");
  fs.symlinkSync(book, alias, "dir");
  const release = acquireFinanceSchedulerLock(book);
  try {
    expect(() => acquireFinanceSchedulerLock(alias)).toThrow("lock exists");
  } finally {
    release();
  }
});

it("preserves a crash lock even when its owner is absent", () => {
  const lock = path.join(directory, FINANCE_SCHEDULER_LOCK);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), '{"pid":999999999,"startedAt":"2000-01-01"}');
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("reconcile interrupted runs");
  expect(fs.existsSync(lock)).toBe(true);
});

it("does not overlap the legacy running scheduler or remove its PID", () => {
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), String(process.pid));
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("still alive");
  expect(readFinanceSchedulerPid(directory)).toBe(process.pid);
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
});

it("does not treat probe permission denial as a dead owner", () => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  expect(financeSchedulerPidPresent(123)).toBe(true);
});

it("fails closed on a malformed PID", () => {
  fs.writeFileSync(path.join(directory, FINANCE_SCHEDULER_PID), "invalid");
  expect(() => acquireFinanceSchedulerLock(directory)).toThrow("invalid finance scheduler pid");
  expect(fs.existsSync(path.join(directory, FINANCE_SCHEDULER_LOCK))).toBe(false);
});
