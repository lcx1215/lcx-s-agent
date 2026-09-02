const GENERIC_LEARNING_TOPIC_RE =
  /^(?:一样|这样|这个|这个主题|审阅|学习审阅|学习框架|框架|入口|资料|来源|沉淀|系统能力|eval)$/iu;

function normalizeLearningTopicText(value: string): string {
  return value
    .replace(/<at\s+[^>]*>.*?<\/at>/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function trimLearningTopicCandidate(value: string): string {
  return value
    .replace(/^[，。；;,.!?！？:：\s]+/u, "")
    .replace(/[，。；;,.!?！？:：].*$/u, "")
    .replace(/^(?:请|帮我|麻烦|一起|同时|先|再|用|结合|基于)\s*/u, "")
    .replace(
      /^(?:网上可靠来源|可靠来源|外部来源|本地沉淀|网上资料|资料)\s*(?:和|与|及|、|，)?\s*/u,
      "",
    )
    .replace(/(?:学习审阅|学习复盘|学习框架|学习计划|学习入口)$/u, "")
    .trim();
}

function compactLearningTopicCandidate(value: string): string | undefined {
  const topic = trimLearningTopicCandidate(value);
  if (!topic || GENERIC_LEARNING_TOPIC_RE.test(topic)) {
    return undefined;
  }
  return topic.length > 36 ? `${topic.slice(0, 36).trimEnd()}...` : topic;
}

export function summarizeExternalLearningVisibleTopic(userMessage: string | undefined): string {
  const normalized = normalizeLearningTopicText(userMessage ?? "");
  if (!normalized) {
    return "这个主题";
  }

  const explicitReviewPatterns = [
    /(?:做一次|做一遍|进行一次|来一次)\s*([^，。；;,.!?！？:：]{1,36}?)(?:学习审阅|学习复盘|学习框架|学习计划|学习入口|学习)?(?:[，。；;,.!?！？:：]|$)/iu,
    /([^，。；;,.!?！？:：]{1,36}?)(?:学习审阅|学习复盘|学习框架|学习计划|学习入口)(?:[，。；;,.!?！？:：]|$)/iu,
  ];
  for (const pattern of explicitReviewPatterns) {
    const topic = compactLearningTopicCandidate(normalized.match(pattern)?.[1] ?? "");
    if (topic) {
      return topic;
    }
  }

  const stripped = normalized
    .replace(/^(?:今天|现在|接下来)\s*/u, "")
    .replace(/^(?:用|让)?(?:三|3|多)?个?模型(?:一起|同时)?\s*/u, "")
    .replace(/^(?:一起|同时)?\s*(?:学习一下|学一下|学学|学习|研究|补|看|读)\s*/u, "")
    .trim();
  if (stripped && stripped !== normalized) {
    const topic = compactLearningTopicCandidate(stripped);
    if (topic) {
      return topic;
    }
  }

  const requestedArtifactPatterns = [
    /(?:给我|输出|整理|生成)\s*(?:一版|一个|一份|一套)?\s*([^，。；;,.!?！？:：]{1,36}?)(?:[，。；;,.!?！？:：]|$)/iu,
  ];
  for (const pattern of requestedArtifactPatterns) {
    const topic = compactLearningTopicCandidate(normalized.match(pattern)?.[1] ?? "");
    if (topic) {
      return topic;
    }
  }

  const topicPatterns = [
    /(?:今天|现在|接下来)?\s*(?:学习|研究|补|看|读)\s*([^，。；;,.!?！？:：]{1,36})/iu,
    /([^，。；;,.!?！？:：]{1,36})\s*(?:的知识|知识|框架|资料|论文)/iu,
  ];
  for (const pattern of topicPatterns) {
    const topic = compactLearningTopicCandidate(normalized.match(pattern)?.[1] ?? "");
    if (topic) {
      return topic;
    }
  }
  return normalized.length > 36 ? `${normalized.slice(0, 36).trimEnd()}...` : normalized;
}

export function summarizeLearningCouncilVisibleTopic(userMessage: string | undefined): string {
  const topic = summarizeExternalLearningVisibleTopic(userMessage);
  return topic === "这个主题" ? "这个学习主题" : topic;
}
