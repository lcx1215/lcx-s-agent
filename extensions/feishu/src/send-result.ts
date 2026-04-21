import type { FeishuIdType, FeishuSendResult } from "./types.js";

export type FeishuMessageApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
};

export function assertFeishuMessageApiSuccess(
  response: FeishuMessageApiResponse,
  errorPrefix: string,
) {
  if (response.code !== 0) {
    throw new Error(`${errorPrefix}: ${response.msg || `code ${response.code}`}`);
  }
}

export function toFeishuSendResult(
  response: FeishuMessageApiResponse,
  chatId: string,
  options: {
    outboundMessageType: string;
    receiveIdType: FeishuIdType;
    usedReplyTarget: boolean;
    usedFallbackCreate: boolean;
  },
): FeishuSendResult {
  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId,
    deliveryStatus: "success",
    feishuCode: response.code,
    feishuMsg: response.msg,
    outboundMessageType: options.outboundMessageType,
    receiveIdType: options.receiveIdType,
    usedReplyTarget: options.usedReplyTarget,
    usedFallbackCreate: options.usedFallbackCreate,
  };
}
