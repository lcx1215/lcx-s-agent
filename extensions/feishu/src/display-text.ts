function normalizeMarkdownTableBlock(block: string): string {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return block;
  }

  const rows = lines
    .filter((line, index) => {
      if (index === 1 && /^\|?[-:\s|]+\|?$/.test(line)) {
        return false;
      }
      return true;
    })
    .map((line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean),
    )
    .filter((cells) => cells.length > 0);

  if (rows.length < 2) {
    return block;
  }

  const headers = rows[0];
  const bodyRows = rows.slice(1);
  return bodyRows
    .map((cells) => {
      const pairs = cells.map((cell, index) => {
        const header = headers[index] ?? `Column ${index + 1}`;
        return `${header}: ${cell}`;
      });
      return `- ${pairs.join("; ")}`;
    })
    .join("\n");
}

function humanizeFeishuStatusValue(value: string): string {
  const trimmed = value.trim();
  const known: Record<string, string> = {
    application_ready: "已通过验证，可作为研究能力使用",
    not_application_ready: "还没证明学进去了",
    not_started: "还没开始",
    timeout_already_reported: "前台已经先告诉你超时，后台还会补发结果",
    no_url_or_local_source_provided: "没有提供链接、本地文件或完整来源",
    safe_local_or_manual_source_required: "缺少安全的本地文件或完整原文",
    ambiguous_repeat_without_current_subject: "没有说清楚要重复哪个任务",
    no_application_ready_learning_receipt: "没有找到可证明已经学会的回执",
    missing_internalized_rule_evidence: "没有找到可证明规则已内化的证据",
    no_finance_learning_retrieval_receipts: "没有找到金融学习检索回执",
    learning_command: "学习任务入口 (learning_command)",
    control_room: "控制室 (control_room)",
    knowledge_maintenance: "知识维护入口 (knowledge_maintenance)",
    ops_audit: "运维审计入口 (ops_audit)",
    technical_daily: "技术面工作面 (technical_daily)",
    fundamental_research: "基本面研究工作面 (fundamental_research)",
    watchtower: "系统观察工作面 (watchtower)",
    protocol_truth_surface: "协议真相检查入口 (protocol_truth_surface)",
  };
  if (known[trimmed]) {
    if (known[trimmed].includes(`(${trimmed})`)) {
      return known[trimmed];
    }
    if (
      trimmed === "application_ready" ||
      trimmed === "not_application_ready" ||
      trimmed === "not_started" ||
      trimmed === "timeout_already_reported"
    ) {
      return known[trimmed];
    }
    return `${known[trimmed]} (${trimmed})`;
  }
  const timeoutMatch = trimmed.match(/^learning_council_reply_timeout_after_(\d+)ms$/u);
  if (timeoutMatch) {
    return `学习审阅超过前台等待时间 (${trimmed})`;
  }
  return trimmed;
}

function humanizeFeishuInlineText(text: string): string {
  return text
    .replace(
      /\b([a-z]+)\s+supplied a fallback contribution for\s+([a-z]+)\.?/giu,
      (_match, helper: string, target: string) => `${helper} 已为 ${target} 提供兜底内容。`,
    )
    .replace(/Learning council run:/giu, "学习流程:")
    .replace(/\bLane receipt:\s*/giu, "审阅通道回执：")
    .replace(/\bprimary_run_failed\b/giu, "主通道失败")
    .replace(/\brun_failed\b/giu, "运行失败")
    .replace(/\brescue_coverage\b/giu, "救援覆盖")
    .replace(/\blow-fidelity\b/giu, "低可信度")
    .replace(/\bpartial \/ degraded execution\b/giu, "部分完成/降级执行")
    .replace(
      /\bfull three-model execution completed with low-fidelity fact warnings\b/giu,
      "三模型审阅已完成，但事实证据可信度偏低",
    )
    .replace(/\bfull three-model execution completed\b/giu, "三模型审阅已完成")
    .replace(/\bconfigured role\b/giu, "配置角色")
    .replace(/\bruntime provider\b/giu, "运行供应商")
    .replace(/\bruntime model\b/giu, "运行模型")
    .replace(/\bcontract=/giu, "能力契约=")
    .replace(/\bfor this role in this turn\b/giu, "本轮这个通道")
    .replace(/\bapplication_ready\b/giu, "已通过验证，可作为研究能力使用")
    .replace(/\bnot_application_ready\b/giu, "还没证明学进去了")
    .replace(/\bfailedReason\b/gu, "失败原因")
    .replace(/\btargetSurface\b/gu, "目标工作面")
    .replace(/\beffectiveSurface\b/gu, "实际工作面")
    .replace(/\bhandoff receipt\b/giu, "交接回执");
}

function humanizeFeishuVisibleLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return line;
  }
  const heading = trimmed.replace(/^#{1,6}\s+/u, "");
  const headingLabels: Record<string, string> = {
    "Learning status": "学习状态",
    "Timebox status": "限时学习状态",
    "Market Intelligence Packet": "市场情报包",
    "Kimi synthesis": "Kimi 综合判断",
    "MiniMax audit": "MiniMax 审阅",
    "MiniMax challenge": "MiniMax 反方审阅",
    "DeepSeek extraction": "DeepSeek 信息抽取",
    Keep: "保留结论",
  };
  if (headingLabels[heading]) {
    return headingLabels[heading];
  }
  if (/^(?:-\s*)?Distribution:\s*/u.test(trimmed)) {
    const prefix = trimmed.startsWith("-") ? "- " : "";
    return trimmed
      .replace(/^(?:-\s*)?Distribution:\s*/u, `${prefix}分发状态：`)
      .replace(/\bpublished\b/giu, "已发布")
      .replace(/\bheld as draft\b/giu, "保留为草稿")
      .replace(/\bsuppressed\b/giu, "已抑制")
      .replace(/\bsummary only\b/giu, "只发控制室摘要")
      .replace(/\blow-signal technical slice\b/giu, "低信号技术面分片")
      .replace(/\bduplicate technical slice\b/giu, "重复技术面分片")
      .replace(/\btechnical slice\b/giu, "技术面分片")
      .replace(/\bfundamental slice\b/giu, "基本面分片");
  }

  if (/^Learning council run:\s*delayed \/ no visible completion yet\.?$/iu.test(trimmed)) {
    return "学习流程已经开始，但前台等待时间内还没形成最终答案。";
  }
  if (
    /^Learning council run:\s*failed before a final council reply was available\.?$/iu.test(trimmed)
  ) {
    return "学习流程启动失败，还没有形成可发给你的最终答案。";
  }
  if (/^Learning council run:\s*full three-model execution completed\.?$/iu.test(trimmed)) {
    return "学习审阅已完成。";
  }
  if (
    /^Learning council run:\s*full three-model execution completed with low-fidelity fact warnings\.?$/iu.test(
      trimmed,
    )
  ) {
    return "学习审阅已完成，但其中有事实证据可信度偏低的提醒。";
  }
  if (/^Learning council run:\s*partial \/ degraded execution\.?$/iu.test(trimmed)) {
    return "学习审阅只部分完成：有通道降级或失败，结论只能低可信度使用。";
  }
  if (/^Status\s*-?$/iu.test(trimmed)) {
    return "当前状态";
  }
  const laneReceiptMatch = trimmed.match(
    /^Lane receipt:\s*contract=([^;]+?)(?:\s*\(configured role:\s*([^)]+)\))?;\s*runtime provider=([^;]+);\s*runtime model=(.+)$/iu,
  );
  if (laneReceiptMatch) {
    const capability = laneReceiptMatch[1]!.trim();
    const role = laneReceiptMatch[2]?.trim();
    const provider = laneReceiptMatch[3]!.trim();
    const model = laneReceiptMatch[4]!.trim();
    const rolePart = role ? `；角色=${role}` : "";
    return `- 审阅通道：能力=${capability}${rolePart}；运行=${provider}/${model}`;
  }

  const keyValueMatch = trimmed.match(
    /^(?:-\s*)?(failedReason|foregroundStatus|originalMessageId|messageId|family|targetSurface|effectiveSurface|source_required|learningInternalizationStatus|handoff receipt|proof|next step|boundary|Boundary|primary_run_failed|run_failed|rescue_coverage|status)\s*[:=]\s*(.+)$/iu,
  );
  if (keyValueMatch) {
    const rawKey = keyValueMatch[1]!.toLowerCase();
    const rawValue = keyValueMatch[2]!.trim();
    const labels: Record<string, string> = {
      failedreason: "失败原因",
      foregroundstatus: "前台状态",
      originalmessageid: "原消息",
      messageid: "消息",
      family: "任务类型",
      targetsurface: "目标工作面",
      effectivesurface: "实际工作面",
      source_required: "还缺来源",
      learninginternalizationstatus: "学习内化状态",
      "handoff receipt": "交接回执",
      proof: "证据",
      "next step": "下一步",
      boundary: "边界",
      primary_run_failed: "主通道失败",
      run_failed: "运行失败",
      rescue_coverage: "救援覆盖",
      status: "状态",
    };
    const value =
      rawKey === "source_required"
        ? rawValue === "true"
          ? "是"
          : rawValue
        : humanizeFeishuStatusValue(rawValue);
    return `- ${labels[rawKey] ?? rawKey}: ${humanizeFeishuInlineText(value)}`;
  }

  const doneQueueMatch = trimmed.match(/^done\s+[—-]\s+family=live_scheduling_queue\b.*$/iu);
  if (doneQueueMatch) {
    return "已收到：这是排队/调度请求；本次只完成队列识别，没有把排队任务说成已经完成。";
  }
  if (/^queued\s+[—-]\s+/iu.test(trimmed)) {
    return humanizeFeishuInlineText(trimmed.replace(/^queued\s+[—-]\s+/iu, "队列状态："));
  }
  if (/^next step\s+[—-]\s+/iu.test(trimmed)) {
    return humanizeFeishuInlineText(trimmed.replace(/^next step\s+[—-]\s+/iu, "下一步："));
  }
  if (/^proof\s+[—-]\s+/iu.test(trimmed)) {
    return humanizeFeishuInlineText(trimmed.replace(/^proof\s+[—-]\s+/iu, "证据："));
  }

  return humanizeFeishuInlineText(line);
}

function humanizeFeishuVisibleText(text: string): string {
  return text.split("\n").map(humanizeFeishuVisibleLine).join("\n");
}

export function normalizeFeishuDisplayText(text: string): string {
  const normalizedTables = text.replace(
    /(^|\n)(\|.+\|[\r\n]+\|[-:| ]+\|(?:[\r\n]+\|.*\|)+)/g,
    (_match, prefix: string, table: string) => `${prefix}${normalizeMarkdownTableBlock(table)}`,
  );

  const withoutCodeFences = normalizedTables.replace(
    /```(?:[\w+-]+)?\n?([\s\S]*?)```/g,
    (_match, codeBody: string) => {
      const body = codeBody
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();
      return body ? `\n${body}\n` : "\n";
    },
  );

  return humanizeFeishuVisibleText(withoutCodeFences)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
