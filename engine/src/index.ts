import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";

import {
  cancelOrder,
  createOrder,
  getBalance,
  getDepth,
  getOrder,
  type CreateOrderInput,
} from "./store/exchange-store.js";

// export type EngineCommandType =
//   | "create_order"
//   | "get_depth"
//   | "get_user_balance"
//   | "get_order"
//   | "cancel_order";

// export interface EngineRequest {
//   correlationId: string;
//   responseQueue: string;
//   type: EngineCommandType;
//   payload: Record<string, unknown>;
// }

export type EngineMessage = 
| {type: "create_order"; payload: CreateOrderInput}
| {type: "get_depth"; payload: {symbol: string}}
| {type: "get_user_balance"; payload: {userId: string}}
| {type: "get_order"; payload: {userId: string; orderId: string}}
| {type: "cancel_order"; payload: {userId: string; orderId: string}}

export type EngineRequest = {
  correlationId: string;
  responseQueue: string;
} & EngineMessage

export interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const brokerClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis broker client error", error);
});

const responseClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis response client error", error);
});

await Promise.all([brokerClient.connect(), responseClient.connect()]);

async function sendResponse(responseQueue: string, response: EngineResponse): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

async function handleEngineRequest(message: EngineRequest): Promise<unknown> {
  /**
   * TODO(student):
   * 1. Check _message.type.
   * 2. Read _message.payload.
   * 3. Call your order book / balance / order logic.
   * 4. Return the data that should go back to the backend.
   *
   * Required message types:
   * - create_order
   * - get_depth
   * - get_user_balance
   * - get_order
   * - cancel_order
   */

  const {type, payload} = message;
  
  switch(type) {
    case "create_order":
      return await createOrder(payload);

    case "get_depth":
      return await getDepth(payload.symbol);

    case "get_user_balance":
      return await getBalance(payload.userId);

    case "get_order":
      return await getOrder(payload.userId , payload.orderId);

    case "cancel_order":
      return await cancelOrder(payload.userId, payload.orderId);

    default:
      throw new Error(`Unknown engine request type: ${type}`)

  }
}

console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

for (;;) {
  const item = await brokerClient.brPop(env.incomingQueue, 0);
  if (!item) continue;

  let message: EngineRequest;

  try {
    message = JSON.parse(item.element) as EngineRequest;
  } catch {
    console.error("Skipping invalid broker message");
    continue;
  }

  try {
    const data = await handleEngineRequest(message);
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: true,
      data,
    });
  } catch (error) {
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    });
  }
}