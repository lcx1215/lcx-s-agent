import { describe, expect, it } from "vitest";
import {
  summarizeFeishuLearningVisibleTopic,
  summarizeLearningCouncilVisibleTopic,
} from "./learning-visible-topic.js";

describe("summarizeFeishuLearningVisibleTopic", () => {
  it("keeps simple learning topics readable", () => {
    expect(summarizeFeishuLearningVisibleTopic("今天学习大宗商品的知识")).toBe("大宗商品的知识");
    expect(summarizeFeishuLearningVisibleTopic("学习股市分析知识")).toBe("股市分析知识");
  });

  it("extracts the real subject from source-and-sedimentation review asks", () => {
    const prompt =
      "请用网上可靠来源和本地沉淀，一起做一次期权基础学习审阅：要说明来源覆盖限制、常见误区、第一课框架、后续怎么沉淀成系统能力和 eval；只做学习研究，不给交易建议，也不要暴露后台细节。";

    expect(summarizeFeishuLearningVisibleTopic(prompt)).toBe("期权基础");
    expect(summarizeLearningCouncilVisibleTopic(prompt)).toBe("期权基础");
  });

  it("does not leak generic requirement tails as the learning topic", () => {
    const prompt =
      "学习期权基础知识。请先像网上学习一样找可靠来源，再结合本地沉淀，给我一个新手第一课框架；只做学习研究。";

    expect(summarizeFeishuLearningVisibleTopic(prompt)).toBe("期权基础知识");
  });

  it("does not mistake comparison wording for the requested learning topic", () => {
    const prompt =
      "迁移后再次验收：请像我真的在学习一样，用网上可靠来源和本地旧沉淀，给我一版期权基础第一课。要说清楚来源覆盖限制、常见误区、第一课框架，以及后续怎么变成系统可复用能力和 eval；只做学习研究，不给交易建议，也不要暴露后台细节。";

    expect(summarizeFeishuLearningVisibleTopic(prompt)).toBe("期权基础第一课");
    expect(summarizeLearningCouncilVisibleTopic(prompt)).toBe("期权基础第一课");
  });
});
