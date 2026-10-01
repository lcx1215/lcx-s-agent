export type AlpacaTradeExecutionType = "fill" | "partial_fill";

export function isAlpacaTradeExecutionType(value: unknown): value is AlpacaTradeExecutionType {
  return value === "fill" || value === "partial_fill";
}
