import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { getMessageFeishu } from "./send.js";

export type FeishuCardActionEvent = {
  open_id?: string;
  user_id?: string;
  union_id?: string;
  tenant_key?: string;
  open_message_id?: string;
  open_chat_id?: string;
  chat_id?: string;
  operator?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  context?: {
    open_id?: string;
    user_id?: string;
    chat_id?: string;
    open_chat_id?: string;
    open_message_id?: string;
  };
};

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  const senderOpenId = event.operator?.open_id ?? event.open_id ?? "";
  const senderUserId = event.operator?.user_id ?? event.user_id;
  const senderUnionId = event.operator?.union_id ?? event.union_id;
  const replyTargetMessageId =
    event.open_message_id?.trim() ||
    event.context?.open_message_id?.trim() ||
    `card-action-${event.token}`;

  // Extract action value
  const actionValue = event.action.value;
  let content = "";
  if (typeof actionValue === "object" && actionValue !== null) {
    if ("text" in actionValue && typeof actionValue.text === "string") {
      content = actionValue.text;
    } else if ("command" in actionValue && typeof actionValue.command === "string") {
      content = actionValue.command;
    } else {
      content = JSON.stringify(actionValue);
    }
  } else {
    content = String(actionValue);
  }

  let chatId =
    event.context?.chat_id?.trim() ||
    event.context?.open_chat_id?.trim() ||
    (typeof event.chat_id === "string" ? event.chat_id : "").trim() ||
    (typeof event.open_chat_id === "string" ? event.open_chat_id : "").trim() ||
    "";
  if (!chatId && replyTargetMessageId && !replyTargetMessageId.startsWith("card-action-")) {
    const sourceMessage = await getMessageFeishu({
      cfg,
      messageId: replyTargetMessageId,
      accountId,
    });
    chatId = sourceMessage?.chatId ?? "";
  }

  // Construct a synthetic message event
  const messageEvent: FeishuMessageEvent = {
    sender: {
      sender_id: {
        open_id: senderOpenId,
        user_id: senderUserId,
        union_id: senderUnionId,
      },
    },
    message: {
      message_id: replyTargetMessageId,
      chat_id: chatId || senderOpenId,
      chat_type: chatId ? "group" : "p2p",
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
  };

  log(`feishu[${account.accountId}]: handling card action from ${senderOpenId}: ${content}`);

  // Dispatch as normal message
  await handleFeishuMessage({
    cfg,
    event: messageEvent,
    botOpenId: params.botOpenId,
    runtime,
    accountId,
  });
}
