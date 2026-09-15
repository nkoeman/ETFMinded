import { NextResponse } from "next/server";
import { getCurrentAppUser } from "@/lib/auth/appUser";
import { resolveOrCreateListingForTransaction } from "@/lib/eodhd/mapping";
import { aggregateDegiroOrderExecutions, parseDegiroCsv } from "@/lib/import/degiroCsv";
import {
  buildFallbackTransactionKey,
  buildImportIdentity,
  normalizeOrderId
} from "@/lib/import/transactionIdentity";
import { ensureInstrumentProfiles } from "@/lib/enrichment";
import { enrichInstrumentsFromOpenFigi } from "@/lib/openfigi/enrich";
import { kickoffIsharesExposureSnapshots } from "@/lib/ishares/ensureIsharesExposure";
import { syncFullForUser, syncLast4WeeksForUser } from "@/lib/prices/sync";
import { withSyncLock } from "@/lib/prices/syncLock";
import { prisma } from "@/lib/prisma";
import { buildTransactionUniqueKey } from "@/lib/transactions/buildUniqueKey";

export const runtime = "nodejs";

type PreparedImportRow = {
  userId: string;
  instrumentId: string;
  listingId: string | null;
  importBatchId: string;
  externalOrderId: string | null;
  tradeAt: Date;
  quantity: number;
  price: number | null;
  valueEur: number | null;
  totalEur: number | null;
  currency: string;
  exchange: string;
  exchangeCode: string;
  type: "TRADE";
  uniqueKey: string;
  dedupeKey: string;
  isin: string;
};

type ExistingOrderTransaction = {
  id: string;
  externalOrderId: string | null;
  instrumentId: string;
  listingId: string | null;
  tradeAt: Date;
  quantity: unknown;
  price: unknown;
  valueEur: unknown;
  totalEur: unknown;
  currency: string;
  exchange: string;
  exchangeCode: string;
  uniqueKey: string;
};

const NUMBER_TOLERANCE = 0.000001;

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numbersDiffer(left: number | null, right: unknown) {
  const parsedRight = nullableNumber(right);
  if (left === null || parsedRight === null) return left !== parsedRight;
  return Math.abs(left - parsedRight) > NUMBER_TOLERANCE;
}

function existingOrderTransactionDiffers(row: PreparedImportRow, existing: ExistingOrderTransaction) {
  return (
    existing.instrumentId !== row.instrumentId ||
    existing.listingId !== row.listingId ||
    existing.tradeAt.getTime() !== row.tradeAt.getTime() ||
    numbersDiffer(row.quantity, existing.quantity) ||
    numbersDiffer(row.price, existing.price) ||
    numbersDiffer(row.valueEur, existing.valueEur) ||
    numbersDiffer(row.totalEur, existing.totalEur) ||
    existing.currency !== row.currency ||
    existing.exchange !== row.exchange ||
    existing.exchangeCode !== row.exchangeCode ||
    existing.uniqueKey !== row.uniqueKey
  );
}

// Imports a DeGiro CSV, resolves MIC-first listing mapping, and triggers background price sync.
export async function POST(req: Request) {
  try {
    const user = await getCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "CSV file is required." }, { status: 400 });
    }

    const existingTransactionCount = await prisma.transaction.count({
      where: { userId: user.id }
    });
    const isInitialImport = existingTransactionCount === 0;

    const buffer = Buffer.from(await file.arrayBuffer());
    const csv = buffer.toString("utf8");
    const parsedRows = parseDegiroCsv(csv);
    const rows = aggregateDegiroOrderExecutions(parsedRows);

    if (!rows.length) {
      return NextResponse.json({ error: "No valid rows found in CSV." }, { status: 400 });
    }

    const importBatch = await prisma.importBatch.create({
      data: {
        userId: user.id,
        source: "degiro",
        fileName: file.name
      }
    });

    const productByIsin = new Map<string, string>();
    for (const row of rows) {
      if (!productByIsin.has(row.isin)) {
        productByIsin.set(row.isin, row.product);
      }
    }

    const instrumentMap = new Map<string, { id: string; isin: string }>();
    for (const [isin, product] of productByIsin.entries()) {
      const instrument = await prisma.instrument.upsert({
        where: { isin },
        update: { name: product },
        create: { isin, name: product, displayName: product }
      });

      if (!instrument.displayName) {
        await prisma.instrument.update({
          where: { isin },
          data: { displayName: product }
        });
      }

      instrumentMap.set(isin, { id: instrument.id, isin: instrument.isin });
    }

    try {
      await enrichInstrumentsFromOpenFigi(Array.from(productByIsin.keys()), {
        userId: user.id,
        importBatchId: importBatch.id
      });
    } catch (error) {
      console.error("[ENRICH][OPENFIGI] import enrichment failed", {
        userId: user.id,
        importBatchId: importBatch.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await ensureInstrumentProfiles(Array.from(productByIsin.keys()), {
        userId: user.id,
        importBatchId: importBatch.id
      });
    } catch (error) {
      console.error("[ENRICH][PROFILE] import enrichment failed", {
        userId: user.id,
        importBatchId: importBatch.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    kickoffIsharesExposureSnapshots({
      userId: user.id,
      instrumentIds: Array.from(instrumentMap.values()).map((instrument) => instrument.id)
    });

    const listingCache = new Map<string, string | null>();
    const seenInputDedupeKeys = new Set<string>();
    let duplicateRowsInUpload = 0;

    const prepared: PreparedImportRow[] = [];

    for (const row of rows) {
      const instrument = instrumentMap.get(row.isin);
      if (!instrument) continue;

      const beursCode = (row.exchange || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
      const listingKey = `${row.isin}|${beursCode}`;

      let listingId = listingCache.get(listingKey);
      if (listingId === undefined) {
        const listing = await resolveOrCreateListingForTransaction({
          userId: user.id,
          isin: instrument.isin,
          productName: row.product,
          degiroBeursCode: beursCode,
          transactionCurrency: row.currency || "UNKNOWN"
        });
        listingId = listing?.id || null;
        listingCache.set(listingKey, listingId);
      }

      const identity = buildImportIdentity({
        orderId: row.orderId,
        tradeAt: row.tradeAt,
        isin: row.isin,
        quantity: row.quantity
      });

      if (seenInputDedupeKeys.has(identity.key)) {
        duplicateRowsInUpload += 1;
        continue;
      }
      seenInputDedupeKeys.add(identity.key);

      const normalizedOrderId = normalizeOrderId(row.orderId);
      const sourceIdentity =
        normalizedOrderId ?? buildFallbackTransactionKey(row.tradeAt, row.isin, row.quantity);

      prepared.push({
        userId: user.id,
        instrumentId: instrument.id,
        listingId: listingId ?? null,
        importBatchId: importBatch.id,
        externalOrderId: normalizedOrderId,
        tradeAt: row.tradeAt,
        quantity: row.quantity,
        price: row.price,
        valueEur: row.valueEur,
        totalEur: row.totalEur,
        currency: row.currency,
        exchange: beursCode,
        exchangeCode: beursCode,
        type: "TRADE",
        uniqueKey: buildTransactionUniqueKey(
          user.id,
          row.isin,
          beursCode,
          row.tradeAt,
          row.quantity,
          row.price,
          row.totalEur,
          row.product,
          null,
          sourceIdentity
        ),
        dedupeKey: identity.key,
        isin: row.isin
      });
    }

    const orderIds = Array.from(
      new Set(
        prepared.map((row) => row.externalOrderId).filter((value): value is string => Boolean(value))
      )
    );

    const existingOrderById = new Map<string, ExistingOrderTransaction>();
    if (orderIds.length) {
      const existingOrderRows = await prisma.transaction.findMany({
        where: {
          userId: user.id,
          externalOrderId: { in: orderIds }
        },
        select: {
          id: true,
          externalOrderId: true,
          instrumentId: true,
          listingId: true,
          tradeAt: true,
          quantity: true,
          price: true,
          valueEur: true,
          totalEur: true,
          currency: true,
          exchange: true,
          exchangeCode: true,
          uniqueKey: true
        }
      });

      for (const row of existingOrderRows) {
        if (row.externalOrderId) existingOrderById.set(row.externalOrderId, row);
      }
    }

    const fallbackRows = prepared;
    const existingFallbackKeys = new Set<string>();
    if (fallbackRows.length) {
      const fallbackInstrumentIds = Array.from(new Set(fallbackRows.map((row) => row.instrumentId)));
      const fallbackTradeAts = Array.from(new Set(fallbackRows.map((row) => row.tradeAt.getTime()))).map(
        (value) => new Date(value)
      );

      const existingFallbackRows = await prisma.transaction.findMany({
        where: {
          userId: user.id,
          externalOrderId: null,
          instrumentId: { in: fallbackInstrumentIds },
          tradeAt: { in: fallbackTradeAts }
        },
        select: {
          tradeAt: true,
          quantity: true,
          instrument: { select: { isin: true } }
        }
      });

      for (const row of existingFallbackRows) {
        existingFallbackKeys.add(
          buildFallbackTransactionKey(row.tradeAt, row.instrument.isin, Number(row.quantity))
        );
      }
    }

    const insertableRows = prepared.filter((row) => {
      if (row.externalOrderId) {
        if (existingOrderById.has(row.externalOrderId)) return false;
      }

      const fallbackKey = buildFallbackTransactionKey(row.tradeAt, row.isin, row.quantity);
      return !existingFallbackKeys.has(fallbackKey);
    });

    const changedExistingRows = prepared.filter((row) => {
      if (!row.externalOrderId) return false;
      const existing = existingOrderById.get(row.externalOrderId);
      return existing ? existingOrderTransactionDiffers(row, existing) : false;
    });

    let importedCount = 0;
    let updatedCount = 0;

    await prisma.$transaction(async (tx) => {
      if (insertableRows.length) {
        const result = await tx.transaction.createMany({
          data: insertableRows.map((row) => ({
            userId: row.userId,
            instrumentId: row.instrumentId,
            listingId: row.listingId,
            importBatchId: row.importBatchId,
            externalOrderId: row.externalOrderId,
            tradeAt: row.tradeAt,
            quantity: row.quantity,
            price: row.price,
            valueEur: row.valueEur,
            totalEur: row.totalEur,
            currency: row.currency,
            exchange: row.exchange,
            exchangeCode: row.exchangeCode,
            type: row.type,
            uniqueKey: row.uniqueKey
          })),
          skipDuplicates: true
        });
        importedCount = result.count;
      }

      for (const row of changedExistingRows) {
        const existing = row.externalOrderId ? existingOrderById.get(row.externalOrderId) : null;
        if (!existing) continue;

        await tx.transaction.update({
          where: { id: existing.id },
          data: {
            instrumentId: row.instrumentId,
            listingId: row.listingId,
            tradeAt: row.tradeAt,
            quantity: row.quantity,
            price: row.price,
            valueEur: row.valueEur,
            totalEur: row.totalEur,
            currency: row.currency,
            exchange: row.exchange,
            exchangeCode: row.exchangeCode,
            type: row.type,
            uniqueKey: row.uniqueKey
          }
        });
        updatedCount += 1;
      }
    });

    const touchedRows = [...insertableRows, ...changedExistingRows];
    const unmappedRows = touchedRows.filter((row) => !row.listingId).length;
    const warning =
      unmappedRows > 0
        ? "Some instruments could not be mapped; they will be excluded from valuation until mapping succeeds automatically."
        : null;

    const listingIds = Array.from(
      new Set(touchedRows.map((row) => row.listingId).filter((id): id is string => Boolean(id)))
    );

    const lockKey = `price-sync:${user.id}`;
    void withSyncLock(
      lockKey,
      () => (isInitialImport ? syncFullForUser(user.id) : syncLast4WeeksForUser(user.id)),
      { lockedBy: user.id }
    ).then((lock) => {
      if (!lock.acquired) {
        console.info("[prices.sync] import-triggered sync skipped; sync already running", {
          userId: user.id,
          mode: isInitialImport ? "full" : "recent"
        });
      }
    }).catch((error) => {
      console.error("[prices.sync] import-triggered sync failed", { userId: user.id, error });
    });

    return NextResponse.json({
      imported: importedCount,
      updated: updatedCount,
      totalRows: rows.length,
      csvRows: parsedRows.length,
      aggregatedExecutionRows: parsedRows.length - rows.length,
      skipped: rows.length - importedCount - updatedCount,
      skippedDuplicatesInUpload: duplicateRowsInUpload,
      syncTriggered: true,
      syncMode: isInitialImport ? "full" : "recent",
      initialSetup: isInitialImport,
      mappedListings: listingIds.length,
      unmappedRows,
      warning
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
