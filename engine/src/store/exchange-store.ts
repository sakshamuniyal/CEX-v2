export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus = "open" | "partially_filled" | "filled" | "cancelled";

export interface Balance {
  available: number;
  locked: number;
}

export interface RestingOrder {
  orderId: string;
  userId: string;
  side: Side;
  type: "limit";
  symbol: string;
  price: number;
  qty: number;
  filledQty: number;
  status: OrderStatus;
  createdAt: number;
}

export interface OrderRecord {
  orderId: string;
  userId: string;
  side: Side;
  type: OrderType;
  symbol: string;
  price: number | null;
  qty: number;
  filledQty: number;
  status: OrderStatus;
  fills: Fill[];
  createdAt: number;
}

export interface Fill {
  fillId: string;
  symbol: string;
  price: number;
  qty: number;
  buyOrderId: string;
  sellOrderId: string;
  createdAt: number;
}

export interface OrderBook {
  bids: Map<number, RestingOrder[]>;
  asks: Map<number, RestingOrder[]>;
}

export interface CreateOrderInput {
  userId: string;
  type: OrderType;
  side: Side;
  symbol: string;
  price: number | null;
  qty: number;
}

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface DepthResponse {
  symbol: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export const BALANCES = new Map<string, Record<string, Balance>>();
export const ORDERBOOKS = new Map<string, OrderBook>();
export const ORDERS = new Map<string, OrderRecord>();
export const FILLS: Fill[] = [];


export async function getBalance(userId: string): Promise<Record<string, Balance>> {
  let userBalance = BALANCES.get(userId);
  if(!userBalance){
    userBalance ={
      "BTC": { available: 10, locked: 0 },
      "USD": { available: 50000, locked: 0 }
      };
      BALANCES.set(userId, userBalance);
    }
    return userBalance;
  }

export async function getOrder(userId: string, orderId: string): Promise<OrderRecord> {
  const order = ORDERS.get(orderId);
  if(!order || order.userId !== userId) {
    throw new Error("order_not_found");
  }
  return order
}

export async function getDepth(symbol: string): Promise<DepthResponse> {
  const book = ORDERBOOKS.get(symbol) || { bids: new Map(), asks: new Map()};
  
  const bids: DepthLevel[] = Array.from(book.bids.entries())
  .map(([price, orders]) => ({
    price,
    qty: orders.reduce((sum: number, o: RestingOrder) => sum + (o.qty - o.filledQty), 0)
  }) )
  .sort((a, b) => b.price - a.price) //Highest first

  const asks: DepthLevel[] = Array.from(book.asks.entries())
  .map(([price, orders]) => ({
    price,
    qty: orders.reduce((sum: number, o: RestingOrder) => sum + (o.qty - o.filledQty), 0)
  }))
  .sort((a, b) => a.price - b.price) // Lowest fist

  return { symbol, bids, asks};
}
export async function cancelOrder(userId: string, orderId: string) {
  const order = ORDERS.get(userId);
  if(!order || order.userId !== userId) throw new Error("order_not_found");
  if(order.status === "filled" || order.status === "cancelled") throw new Error("cannot_cancel_finished_order");

  const book = ORDERBOOKS.get(order.symbol);
  if(book && order.type === "limit") {
    const sideMap = order.side === "buy" ? book.bids : book.asks
    const ordersAtPrice = sideMap.get(order.price!);
    if(ordersAtPrice) {
      sideMap.set(order.price!, ordersAtPrice.filter(o => o.orderId !== orderId));
      if(sideMap.get(order.price!)?.length === 0) sideMap.delete(order.price!);
    }
  }

  const balances = await getBalance(userId);
  const remainingQty = order.qty - order.filledQty;

  if(order.side === "buy") {
    balances["USD"]!.locked -= remainingQty * order.price!;
    balances["USD"]!.available += remainingQty * order.price!
  } else {
    balances["BTC"]!.locked -= remainingQty;
    balances["BTC"]!.available += remainingQty;
  }

  order.status = "cancelled";
  return order;
}

export async function createOrder(input: CreateOrderInput) {
  const {userId, type, side, symbol, price, qty} = input;
  const balances = await getBalance(userId);

  const baseAsset = "BTC";
  const quoteAsset = "USD";

  if(type === "limit") {
    if(side === "buy") {
      const totalCost = qty * price!;
      if (balances[quoteAsset]!.available < totalCost) throw new Error("insufficient_balance");
      balances[quoteAsset]!.available -= totalCost;
      balances[quoteAsset]!.locked += totalCost;
    } else {
      if(balances[baseAsset]!.available < qty) throw new Error("insufficient_balance");
      balances[baseAsset]!.available -= qty;
      balances[baseAsset]!.locked += qty;
    }
  }

  const order: OrderRecord = {
    orderId: crypto.randomUUID(),
    userId,
    side,
    type,
    symbol,
    price,
    qty,
    filledQty: 0,
    status: "open",
    fills: [],
    createdAt: Date.now()
  };

   ORDERS.set(order.orderId, order)

  if(!ORDERBOOKS.has(symbol)) {
     ORDERBOOKS.set(symbol, {bids: new Map(), asks: new Map()});
  }
  const book = ORDERBOOKS.get(symbol)!;

  matchOrder(order, book);

  if(order.type === "limit" && order.filledQty < order.qty) {
    const sideMap = order.side === "buy" ? book.bids : book.asks;
    if(!sideMap.has(order.price!)) sideMap.set(order.price!, []);
     sideMap.get(order.price!)!.push({
      ...order,
      type: "limit",
      price: order.price!
    });
  }

  return order;
}

async function matchOrder(takerOrder: OrderRecord, book: OrderBook) {
  const isBuy = takerOrder.side === "buy";
  const oppositeMap = isBuy ? book.asks : book.bids;

  const sortedPrices = Array.from(oppositeMap.keys()).sort((a, b) => isBuy ? a - b : b - a);

  for(const price of sortedPrices) {
    if(takerOrder.filledQty === takerOrder.qty) break;

    if(takerOrder.type === "limit") {
      if(isBuy && price > takerOrder.price!) break;
      if(!isBuy && price < takerOrder.price!) break;
    }

    const makerOrders = oppositeMap.get(price)!;
    while(makerOrders.length > 0 && takerOrder.filledQty < takerOrder.qty) {
      const maker = makerOrders[0]!;
      const remainingTaker = takerOrder.qty - takerOrder.filledQty;
      const remainingMaker = maker.qty - maker.filledQty;
      const fillQty = Math.min(remainingTaker, remainingMaker);

      executeFill(takerOrder, maker, fillQty, price);

      if(maker.filledQty === maker.qty) {
        makerOrders.shift();
      }
    }
    if(makerOrders.length === 0) oppositeMap.delete(price);
  }
}

async function executeFill(taker: OrderRecord, maker: RestingOrder, qty: number, price: number) {
  const fill: Fill = {
    fillId: crypto.randomUUID(),
    symbol: taker.symbol,
    price,
    qty,
    buyOrderId: taker.side === "buy" ? taker.orderId : maker.orderId,
    sellOrderId: taker.side === "sell" ? taker.orderId : maker.orderId,
    createdAt: Date.now()
  };

  FILLS.push(fill);
  taker.fills.push(fill);
  taker.filledQty += qty;
  maker.filledQty += qty;

  taker.status = taker.filledQty === taker.qty ? "filled" : "partially_filled";
  maker.status = maker.filledQty === maker.qty ? "filled" : "partially_filled";

  const makerRecord = ORDERS.get(maker.orderId);
  if(makerRecord) {
    makerRecord.filledQty = maker.filledQty;
    makerRecord.status = maker.status;
    makerRecord.fills.push(fill);
  }

  const takerBalances = await getBalance(taker.userId);
  const makerBalances = await getBalance(maker.userId);

  if(taker.side === "buy") {
    takerBalances["BTC"]!.available += qty;

    if(taker.type === "limit") takerBalances["USD"]!.locked -= qty * taker.price!

    makerBalances["USD"]!.available += qty * price;
    makerBalances["BTC"]!.locked -= qty;
  } else {
    takerBalances["USD"]!.available += qty * price;
    if( taker.type === "limit") takerBalances["BTC"]!.locked -= qty;

    makerBalances["BTC"]!.available += qty;
    makerBalances["USD"]!.locked -= qty * maker.price;
  }
}