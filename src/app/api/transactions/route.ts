import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getCurrentAppUser } from "@/lib/auth/appUser";
import { resolveOrCreateListingForSelectedExchange } from "@/lib/eodhd/mapping";
import { getFxRateForWeek } from "@/lib/fx/convert";
import { syncWeeklyFxRates } from "@/lib/fx/sync";
import { syncFullForUser, syncLast4WeeksForUser } from "@/lib/prices/sync";
import { prisma } from "@/lib/prisma";
import { deleteAllTransactionsForUser } from "@/lib/transactions/deleteTransactions";
import { buildTransactionUniqueKey } from "@/lib/transactions/buildUniqueKey";
import { getTransactionTableRows } from "@/lib/transactions/transactionRows";

export const runtime = "nodejs";

type ManualTransactionPayload = {
  tradeAt?: unknown;
  side?: unknown;
  name?: unknown;
  isin?: unknown;
  quantity?: unknown;
  price?: unknown;
  currency?: unknown;
  exchangeCode?: unknown;
  transactionCosts?: unknown;
};

type ManualTransactionSide = "BUY" | "SELL";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_SYNC_DAYS = 35;

function normalizeString(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeCode(value: unknown, fallback = "") {
  return normalizeString(value).toUpperCase() || fallback;
}

function parsePositiveNumber(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than 0.`);
  }
  return parsed;
}

function parseOptionalCost(value: unknown) {
  if (value === null || value === undefined || normalizeString(value) === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Transaction costs must be 0 or greater.");
  }

  return parsed;
}

function parseTradeDate(value: unknown) {
  const raw = normalizeString(value);
  if (!raw) {
    throw new Error("Transaction date is required.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error("Transaction date is invalid.");
  }

  const parsed = new Date(`${raw}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error("Transaction date is invalid.");
  }

  return parsed;
}

function getFxAnchorFriday(value: Date) {
  const day = value.getUTCDay();
  const diff = day >= 5 ? day - 5 : day + 2;
  return new Date(`${new Date(value.getTime() - diff * ONE_DAY_MS).toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function shouldRunFullSync(tradeAt: Date) {
  const recentBoundary = Date.now() - RECENT_SYNC_DAYS * ONE_DAY_MS;
  return tradeAt.getTime() < recentBoundary;
}

export async function GET() {
  try {
    const user = await getCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rows = await getTransactionTableRows(user.id);
    return NextResponse.json({ rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load transactions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Persists a single manual trade while preserving the current signed-quantity model used across valuations.
export async function POST(req: Request) {
  try {
    const user = await getCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = (await req.json()) as ManualTransactionPayload;
    const tradeAt = parseTradeDate(payload.tradeAt);
    const side = normalizeCode(payload.side) as ManualTransactionSide;
    const name = normalizeString(payload.name);
    const isin = normalizeCode(payload.isin);
    const quantity = parsePositiveNumber(payload.quantity, "Quantity");
    const price = parsePositiveNumber(payload.price, "Price");
    const currency = normalizeCode(payload.currency, "EUR");
    const exchangeCode = normalizeCode(payload.exchangeCode);
    const transactionCosts = parseOptionalCost(payload.transactionCosts);

    if (side !== "BUY" && side !== "SELL") {
      throw new Error("Transaction type must be BUY or SELL.");
    }
    if (!name) {
      throw new Error("Name is required.");
    }
    if (!isin) {
      throw new Error("ISIN is required.");
    }
    if (!currency) {
      throw new Error("Currency is required.");
    }
    if (!exchangeCode) {
      throw new Error("Exchange is required.");
    }

    const selectedExchange = await prisma.eodhdExchange.findUnique({
      where: { code: exchangeCode },
      select: {
        code: true,
        name: true
      }
    });

    if (!selectedExchange) {
      return NextResponse.json({ error: "Selected exchange was not found." }, { status: 400 });
    }

    const existingInstrument = await prisma.instrument.findUnique({ where: { isin } });
    const instrument = await prisma.instrument.upsert({
      where: { isin },
      update: {},
      create: {
        isin,
        name,
        displayName: name
      }
    });

    const listing = await resolveOrCreateListingForSelectedExchange({
      userId: user.id,
      isin,
      productName: existingInstrument?.name || name,
      eodhdExchangeCode: exchangeCode,
      transactionCurrency: currency
    });

    let valueEur: number | null = null;
    let totalEur: number | null = null;

    try {
      const fxToEur =
        currency === "EUR"
          ? 1
          : await (async () => {
              await syncWeeklyFxRates([getFxAnchorFriday(tradeAt)], [currency]);
              return getFxRateForWeek(tradeAt, currency);
            })();

      const grossValueEur = quantity * price * fxToEur;
      const costValueEur = (transactionCosts || 0) * fxToEur;
      valueEur = grossValueEur;
      totalEur = grossValueEur + costValueEur;
    } catch (error) {
      console.warn("[transactions.manual] unable to derive EUR amounts", {
        userId: user.id,
        isin,
        currency,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const signedQuantity = side === "SELL" ? -quantity : quantity;
    const runFullSync = shouldRunFullSync(tradeAt);

    const transaction = await prisma.transaction.create({
      data: {
        userId: user.id,
        instrumentId: instrument.id,
        listingId: listing?.id || null,
        tradeAt,
        quantity: signedQuantity,
        price,
        transactionCosts,
        valueEur,
        totalEur,
        currency,
        exchange: selectedExchange.name || `EODHD ${selectedExchange.code}`,
        exchangeCode: selectedExchange.code,
        type: "TRADE",
        uniqueKey: buildTransactionUniqueKey(
          user.id,
          isin,
          selectedExchange.code,
          tradeAt,
          signedQuantity,
          price,
          totalEur,
          existingInstrument?.name || name,
          transactionCosts
        )
      },
      select: {
        id: true
      }
    });

    void (runFullSync ? syncFullForUser(user.id) : syncLast4WeeksForUser(user.id)).catch((error) => {
      console.error("[transactions.manual] post-create sync failed", {
        userId: user.id,
        transactionId: transaction.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    return NextResponse.json({
      ok: true,
      transactionId: transaction.id,
      listingMapped: Boolean(listing),
      syncTriggered: runFullSync ? "full" : "recent"
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: "This transaction already exists. Duplicate entries are blocked." },
        { status: 409 }
      );
    }

    const message = error instanceof Error ? error.message : "Unable to create transaction.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    const user = await getCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await deleteAllTransactionsForUser(user.id);
    if (!result.deleted) {
      return NextResponse.json(
        { error: "Portfolio update is already running. Try again after it completes." },
        { status: 409 }
      );
    }

    revalidatePath("/app");
    revalidatePath("/app/portfolio");
    revalidatePath("/app/import");
    revalidatePath("/app/insights");
    revalidatePath("/app/setup");

    return NextResponse.json({
      ok: true,
      transactionsDeleted: result.transactionsDeleted,
      importBatchesDeleted: result.importBatchesDeleted,
      dailyValuesDeleted: result.dailyValuesDeleted,
      aiSummariesDeleted: result.aiSummariesDeleted
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete transactions.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
