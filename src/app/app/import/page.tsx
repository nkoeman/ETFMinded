import { redirect } from "next/navigation";
import { format } from "date-fns";
import { ManualTransactionButton } from "@/components/ManualTransactionButton";
import { SyncPricesButton } from "@/components/SyncPricesButton";
import { ImportDropzoneCard } from "@/components/import/ImportDropzoneCard";
import { TransactionsTableClient } from "@/components/import/TransactionsTableClient";
import { PageContainer } from "@/components/layout/PageContainer";
import { getCurrentAppUser } from "@/lib/auth/appUser";
import { ensureEodhdExchangeDirectoryLoaded } from "@/lib/eodhd/exchanges";
import { prisma } from "@/lib/prisma";
import { getTransactionTableRows } from "@/lib/transactions/transactionRows";

export default async function TransactionsPage() {
  const user = await getCurrentAppUser();
  if (!user) redirect("/sign-in");

  try {
    await ensureEodhdExchangeDirectoryLoaded();
  } catch (error) {
    console.warn("[transactions.page] unable to preload exchange directory", {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const [rows, exchanges, latestImport] = await Promise.all([
    getTransactionTableRows(user.id),
    prisma.eodhdExchange.findMany({
      select: {
        code: true,
        name: true,
        country: true,
        currency: true
      },
      orderBy: [{ code: "asc" }]
    }),
    prisma.importBatch.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            transactions: true
          }
        }
      }
    })
  ]);

  const latestImportDate = latestImport?.createdAt ? format(latestImport.createdAt, "dd MMM yyyy") : null;
  const subtitleParts = [
    `${rows.length} transaction${rows.length === 1 ? "" : "s"}`,
    latestImportDate ? `last import ${latestImportDate}` : "no import yet",
    "idempotent CSV import"
  ];

  return (
    <PageContainer>
      <div className="page-stack">
        <div className="page-head">
          <div>
            <h1 className="page-title">Transactions</h1>
            <p className="page-sub">{subtitleParts.join(" - ")}</p>
          </div>
        </div>

        <div className="import-grid">
          <ImportDropzoneCard
            latestImport={{
              createdAt: latestImport?.createdAt ? latestImport.createdAt.toISOString() : null,
              fileName: latestImport?.fileName ?? null,
              importedRows: latestImport?._count.transactions ?? null
            }}
          />

          <div className="card sync-status-card">
            <div className="card-head">
              <div>
                <h2 className="card-title">Sync status</h2>
              </div>
            </div>
            <SyncPricesButton />
          </div>
        </div>

        <TransactionsTableClient rows={rows} actions={<ManualTransactionButton exchanges={exchanges} />} />
      </div>
    </PageContainer>
  );
}
