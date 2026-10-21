/** Resolve a declared daily-bar session from its real source instant, without guessing a zone. */
export function financeEodSessionDate(
  sourceTimestamp: number,
  declaredDate: unknown,
  timezoneOffsetMinutes: unknown = 0,
): string | undefined {
  const source = new Date(sourceTimestamp);
  if (!Number.isFinite(source.getTime())) {
    return undefined;
  }
  if (declaredDate === undefined) {
    return source.toISOString().slice(0, 10);
  }
  if (typeof declaredDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(declaredDate)) {
    return undefined;
  }
  const parsedDate = Date.parse(declaredDate);
  if (
    !Number.isFinite(parsedDate) ||
    new Date(parsedDate).toISOString().slice(0, 10) !== declaredDate ||
    typeof timezoneOffsetMinutes !== "number" ||
    !Number.isInteger(timezoneOffsetMinutes) ||
    Math.abs(timezoneOffsetMinutes) > 14 * 60
  ) {
    return undefined;
  }
  const sourceLocalTime = new Date(sourceTimestamp + timezoneOffsetMinutes * 60_000);
  return Number.isFinite(sourceLocalTime.getTime()) &&
    sourceLocalTime.toISOString().slice(0, 10) === declaredDate
    ? declaredDate
    : undefined;
}
