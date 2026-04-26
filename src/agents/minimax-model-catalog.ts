export type MinimaxTextModelSpec = {
  id: string;
  name: string;
  reasoning: boolean;
};

export const MINIMAX_BUILTIN_DEFAULT_TEXT_MODEL_ID = "MiniMax-M2.7";
export const MINIMAX_BUILTIN_TEXT_MODELS: readonly MinimaxTextModelSpec[] = [
  {
    id: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    reasoning: true,
  },
  {
    id: "MiniMax-M2.5",
    name: "MiniMax M2.5",
    reasoning: true,
  },
  {
    id: "MiniMax-M2.5-highspeed",
    name: "MiniMax M2.5 Highspeed",
    reasoning: true,
  },
  {
    id: "MiniMax-M2.5-Lightning",
    name: "MiniMax M2.5 Lightning",
    reasoning: true,
  },
] as const;

function inferMinimaxModelName(modelId: string): string {
  if (modelId.startsWith("MiniMax-")) {
    return `MiniMax ${modelId.slice("MiniMax-".length)}`;
  }
  return modelId;
}

export function resolveMinimaxDefaultTextModelId(): string {
  return (
    process.env.OPENCLAW_MINIMAX_DEFAULT_MODEL?.trim() || MINIMAX_BUILTIN_DEFAULT_TEXT_MODEL_ID
  );
}

export function resolveMinimaxTextModelCatalog(): MinimaxTextModelSpec[] {
  const defaultId = resolveMinimaxDefaultTextModelId();
  const builtins = [...MINIMAX_BUILTIN_TEXT_MODELS];
  if (builtins.some((model) => model.id === defaultId)) {
    return builtins;
  }
  return [
    {
      id: defaultId,
      name: inferMinimaxModelName(defaultId),
      reasoning: true,
    },
    ...builtins,
  ];
}
