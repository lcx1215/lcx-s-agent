import { describe, expect, it } from "vitest";
import { normalizeLarkApiReplyForDistillation } from "./lark-api-reply-distillation.js";

describe("normalizeLarkApiReplyForDistillation", () => {
  it("keeps Chinese and English replies as semantic-family candidates", () => {
    expect(normalizeLarkApiReplyForDistillation("以后遇到未验证来源，先标未知。")).toMatchObject({
      outputKind: "zh_text",
      disposition: "candidate_semantic_family",
    });

    expect(
      normalizeLarkApiReplyForDistillation(
        "When evidence is missing, route the answer to ops audit before making a claim.",
      ),
    ).toMatchObject({
      outputKind: "en_text",
      disposition: "candidate_semantic_family",
    });
  });

  it("keeps code and JSON out of automatic promotion", () => {
    expect(
      normalizeLarkApiReplyForDistillation("```ts\nconst route = resolveFamily(input);\n```"),
    ).toMatchObject({
      outputKind: "code",
      disposition: "review_required",
    });

    expect(
      normalizeLarkApiReplyForDistillation({ family: "learning_external_source", score: 0.91 }),
    ).toMatchObject({
      outputKind: "json",
      disposition: "review_required",
    });
  });

  it("keeps routing samples separate from finance learning artifacts", () => {
    const sample = normalizeLarkApiReplyForDistillation(
      "把这句话路由到 external_source_coverage_honesty，先进入待审语义家族样本。",
    );

    expect(sample).toMatchObject({
      outputKind: "mixed_text",
      disposition: "candidate_semantic_family",
    });
    expect(sample).not.toHaveProperty("capabilityName");
    expect(sample).not.toHaveProperty("articlePath");
    expect(sample).not.toHaveProperty("sourceArticlePath");
    expect(JSON.stringify(sample)).not.toMatch(
      /finance_learning|finance-learning|memory\/local-memory|capability card/u,
    );
  });

  it("redacts token-like replies from routing corpus candidates", () => {
    const sample = normalizeLarkApiReplyForDistillation(
      "Authorization: Bearer sk-ant-api03-thisshouldnotbelearned",
    );

    expect(sample).toMatchObject({
      outputKind: "token_like",
      disposition: "discard_secret",
    });
    expect(sample.distillableText).toBeUndefined();
    expect(sample.discardReason).toContain("must not enter routing corpus candidates");
  });

  it("records binary payloads only by length and hash", () => {
    const sample = normalizeLarkApiReplyForDistillation(Buffer.from([0, 1, 2, 3]));

    expect(sample).toMatchObject({
      outputKind: "binary",
      disposition: "discard_binary",
      byteLength: 4,
    });
    expect(sample.contentHash).toMatch(/^[a-f0-9]{16}$/u);
    expect(sample.distillableText).toBeUndefined();
  });
});
