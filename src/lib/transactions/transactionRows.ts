import { format, startOfDay } from "date-fns";
import { prisma } from "@/lib/prisma";

export type TransactionTableRow = {
  id: string;
  date: string;
  type: "Buy" | "Sell";
  name: string;
  quantity: string;
  price: string;
  currency: string;
  exchangeCode: string;
  amount: string;
};

function toNumber(value: unknown) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  return Number(value);
}

const quantityFormatter = new Intl.NumberFormat("nl-NL", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4
});

function moneyFormatter(currency: string) {
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export async function getTransactionTableRows(userId: string): Promise<TransactionTableRow[]> {
  const transactions = await prisma.transaction.findMany({
    where: { userId },
    select: {
      id: true,
      tradeAt: true,
      quantity: true,
      price: true,
      transactionCosts: true,
      valueEur: true,
      totalEur: true,
      currency: true,
      exchangeCode: true,
      instrument: {
        select: {
          name: true,
          displayName: true
        }
      }
    },
    orderBy: { tradeAt: "desc" }
  });

  return transactions.map((tx) => {
    const amount = tx.valueEur ?? tx.totalEur;
    const type = toNumber(tx.quantity) < 0 ? "Sell" : "Buy";
    const currency = tx.currency || "EUR";

    return {
      id: tx.id,
      date: format(startOfDay(tx.tradeAt), "yyyy-MM-dd"),
      type,
      name: tx.instrument.displayName || tx.instrument.name,
      quantity: quantityFormatter.format(Math.abs(toNumber(tx.quantity))),
      price: tx.price === null ? "-" : moneyFormatter(currency).format(toNumber(tx.price)),
      currency,
      exchangeCode: tx.exchangeCode,
      amount: amount === null ? "-" : moneyFormatter("EUR").format(toNumber(amount))
    };
  });
}
