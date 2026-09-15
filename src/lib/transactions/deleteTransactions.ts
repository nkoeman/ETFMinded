import { prisma } from "@/lib/prisma";
import { withSyncLock } from "@/lib/prices/syncLock";
import { refreshDailyPortfolioValuesForUser } from "@/lib/valuation/dailyPortfolioValue";
import { invalidateTopMoversCacheForUser } from "@/lib/dashboard/topMoversByRange";

const LOCK_TTL_MS = 30 * 60 * 1000;

function startOfDay(value: Date) {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

async function recomputeUserPortfolioValues(userId: string) {
  const firstRemainingTransaction = await prisma.transaction.findFirst({
    where: { userId },
    orderBy: { tradeAt: "asc" },
    select: { tradeAt: true }
  });

  if (!firstRemainingTransaction) {
    return {
      recomputed: false,
      fromDate: null,
      points: 0
    };
  }

  const series = await refreshDailyPortfolioValuesForUser(userId, {
    fromDate: startOfDay(firstRemainingTransaction.tradeAt),
    toDate: startOfDay(new Date())
  });

  return {
    recomputed: true,
    fromDate: series.startDate,
    points: series.points.length
  };
}

export type DeleteTransactionResult =
  | {
      deleted: true;
      recalculated: boolean;
      recalculatedPoints: number;
      deletedTransaction: {
        id: string;
        tradeAt: Date;
        instrumentName: string;
      };
    }
  | {
      deleted: false;
      reason: "not_found" | "locked";
    };

export async function deleteTransactionForUser(
  userId: string,
  transactionId: string
): Promise<DeleteTransactionResult> {
  const lock = await withSyncLock(
    `price-sync:${userId}`,
    async () => {
      const transaction = await prisma.transaction.findFirst({
        where: {
          id: transactionId,
          userId
        },
        select: {
          id: true,
          tradeAt: true,
          importBatchId: true,
          instrument: {
            select: {
              name: true,
              displayName: true
            }
          }
        }
      });

      if (!transaction) {
        return {
          deleted: false as const,
          reason: "not_found" as const
        };
      }

      await prisma.$transaction(async (tx) => {
        await tx.transaction.delete({
          where: { id: transaction.id }
        });

        await tx.dailyPortfolioValue.deleteMany({
          where: { userId }
        });

        await tx.portfolioAiSummary.deleteMany({
          where: { userId }
        });

        if (transaction.importBatchId) {
          await tx.importBatch.deleteMany({
            where: {
              id: transaction.importBatchId,
              userId,
              transactions: { none: {} }
            }
          });
        }
      });

      invalidateTopMoversCacheForUser(userId);
      const recompute = await recomputeUserPortfolioValues(userId);

      return {
        deleted: true as const,
        recalculated: recompute.recomputed,
        recalculatedPoints: recompute.points,
        deletedTransaction: {
          id: transaction.id,
          tradeAt: transaction.tradeAt,
          instrumentName: transaction.instrument.displayName || transaction.instrument.name
        }
      };
    },
    {
      ttlMs: LOCK_TTL_MS,
      lockedBy: userId
    }
  );

  if (!lock.acquired) {
    return {
      deleted: false as const,
      reason: "locked"
    };
  }

  return lock.result;
}

export type DeleteAllTransactionsResult =
  | {
      deleted: true;
      transactionsDeleted: number;
      importBatchesDeleted: number;
      dailyValuesDeleted: number;
      aiSummariesDeleted: number;
    }
  | {
      deleted: false;
      reason: "locked";
    };

export async function deleteAllTransactionsForUser(userId: string): Promise<DeleteAllTransactionsResult> {
  const lock = await withSyncLock(
    `price-sync:${userId}`,
    async () => {
      const result = await prisma.$transaction(async (tx) => {
        const transactions = await tx.transaction.deleteMany({
          where: { userId }
        });
        const dailyValues = await tx.dailyPortfolioValue.deleteMany({
          where: { userId }
        });
        const aiSummaries = await tx.portfolioAiSummary.deleteMany({
          where: { userId }
        });
        const importBatches = await tx.importBatch.deleteMany({
          where: { userId }
        });

        return {
          transactionsDeleted: transactions.count,
          importBatchesDeleted: importBatches.count,
          dailyValuesDeleted: dailyValues.count,
          aiSummariesDeleted: aiSummaries.count
        };
      });

      invalidateTopMoversCacheForUser(userId);

      return {
        deleted: true as const,
        ...result
      };
    },
    {
      ttlMs: LOCK_TTL_MS,
      lockedBy: userId
    }
  );

  if (!lock.acquired) {
    return {
      deleted: false as const,
      reason: "locked"
    };
  }

  return lock.result;
}
