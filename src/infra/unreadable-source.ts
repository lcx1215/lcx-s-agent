import { isNotFoundPathError } from "./path-guards.js";

/**
 * One judgement, shared by every reader of a directory or file it may not be able to read:
 * "there is nothing there" and "I cannot see in there" are different answers, and collapsing
 * them makes a failed read indistinguishable from an empty one.
 *
 * Callers surface the failure instead of returning an empty result, so a scan that could not
 * read is never reported as a scan that found nothing.
 *
 * The absent/unreadable split is `isNotFoundPathError`'s call to make — there is one place that
 * knows which errno means "not there", and this module borrows it rather than restating it.
 */
export type SourceReadFailure = Readonly<{
  status: "absent" | "unreadable";
  code: string;
}>;

export type UnreadableSource = Readonly<{
  path: string;
  status: "absent" | "unreadable";
  code: string;
}>;

function errnoCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err
    ? String((err as NodeJS.ErrnoException).code)
    : "error";
}

export function describeReadFailure(err: unknown): SourceReadFailure {
  return {
    status: isNotFoundPathError(err) ? "absent" : "unreadable",
    code: errnoCode(err),
  };
}

export function describeUnreadableSource(path: string, err: unknown): UnreadableSource {
  const failure = describeReadFailure(err);
  return { path, status: failure.status, code: failure.code };
}

/** `true` when the path is genuinely not there, so an empty result is the honest answer. */
export function isAbsentFailure(failure: SourceReadFailure): boolean {
  return failure.status === "absent";
}
