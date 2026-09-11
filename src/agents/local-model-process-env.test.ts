import { describe, expect, it } from "vitest";
import { buildLocalModelProcessEnv } from "./local-model-process-env.js";

describe("local model subprocess environment", () => {
  it("keeps runtime/cache settings and excludes gateway credentials", () => {
    expect(
      buildLocalModelProcessEnv(
        {
          PATH: "/usr/bin",
          HOME: "/tmp/home",
          HF_HOME: "/tmp/hf",
          LCX_LOCAL_MODEL_ALLOW_NETWORK: "1",
          OPENAI_API_KEY: "do-not-forward",
          TELEGRAM_BOT_TOKEN: "do-not-forward",
          HTTP_PROXY: "do-not-forward",
        },
        { PYTHONUNBUFFERED: "1" },
      ),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      HF_HOME: "/tmp/hf",
      PYTHONUNBUFFERED: "1",
    });
  });
});
