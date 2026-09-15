"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { TransactionTableRow } from "@/lib/transactions/transactionRows";

type TransactionRow = TransactionTableRow;

type TransactionsTableClientProps = {
  rows: TransactionRow[];
  actions?: ReactNode;
};

type Filter = "all" | "buy" | "sell";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "buy", label: "Buys" },
  { key: "sell", label: "Sells" }
];

const TRANSACTIONS_CHANGED_EVENT = "transactions:changed";

export function TransactionsTableClient({ rows, actions }: TransactionsTableClientProps) {
  const router = useRouter();
  const [localRows, setLocalRows] = useState<TransactionRow[]>(rows);
  const [refreshingRows, setRefreshingRows] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<TransactionRow | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleteAllConfirmation, setDeleteAllConfirmation] = useState("");
  const [pendingAction, setPendingAction] = useState<"single" | "all" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocalRows(rows);
  }, [rows]);

  useEffect(() => {
    let cancelled = false;

    async function refreshRows() {
      setRefreshingRows(true);
      setError(null);

      try {
        const response = await fetch("/api/transactions", {
          method: "GET",
          cache: "no-store"
        });
        const body = (await response.json().catch(() => ({}))) as { rows?: TransactionRow[]; error?: string };
        if (!response.ok) {
          throw new Error(body.error || "Unable to refresh transactions.");
        }
        if (!cancelled) {
          setLocalRows(body.rows ?? []);
        }
      } catch (refreshError) {
        if (!cancelled) {
          setError(refreshError instanceof Error ? refreshError.message : "Unable to refresh transactions.");
        }
      } finally {
        if (!cancelled) {
          setRefreshingRows(false);
        }
      }
    }

    const handleTransactionsChanged = () => {
      void refreshRows();
    };

    window.addEventListener(TRANSACTIONS_CHANGED_EVENT, handleTransactionsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(TRANSACTIONS_CHANGED_EVENT, handleTransactionsChanged);
    };
  }, []);

  useEffect(() => {
    if (!deleteCandidate && !deleteAllOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingAction) {
        setDeleteCandidate(null);
        setDeleteAllOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [deleteCandidate, deleteAllOpen, pendingAction]);

  const filteredRows = useMemo(() => {
    if (filter === "all") return localRows;
    if (filter === "buy") return localRows.filter((row) => row.type === "Buy");
    return localRows.filter((row) => row.type === "Sell");
  }, [filter, localRows]);

  async function deleteTransaction(row: TransactionRow) {
    if (pendingAction) return;

    setPendingAction("single");
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/transactions/${encodeURIComponent(row.id)}`, {
        method: "DELETE"
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Unable to delete transaction.");
      }

      setLocalRows((current) => current.filter((entry) => entry.id !== row.id));
      setDeleteCandidate(null);
      setMenuOpenFor(null);
      setMessage("Transaction deleted. Portfolio history was recalculated.");
      router.refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete transaction.");
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteAllTransactions() {
    if (pendingAction || deleteAllConfirmation !== "DELETE") return;

    setPendingAction("all");
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/transactions", {
        method: "DELETE"
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Unable to delete transactions.");
      }

      setLocalRows([]);
      setDeleteAllOpen(false);
      setDeleteAllConfirmation("");
      setMessage("Portfolio cleared. Your account remains active.");
      router.push("/app/setup");
      router.refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete transactions.");
    } finally {
      setPendingAction(null);
    }
  }

  function closeSingleDeleteDialog() {
    if (pendingAction) return;
    setDeleteCandidate(null);
  }

  function closeDeleteAllDialog() {
    if (pendingAction) return;
    setDeleteAllOpen(false);
    setDeleteAllConfirmation("");
  }

  return (
    <>
      <div className="card transactions-card">
        <div className="card-head transactions-head">
          <div>
            <h2 className="card-title">All transactions</h2>
            <p className="card-sub">Sorted by date - most recent first</p>
          </div>
          <div className="transactions-controls">
            <div className="range-pills" aria-label="Filter transactions">
              {FILTERS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={`range-pill${filter === entry.key ? " active" : ""}`}
                  onClick={() => setFilter(entry.key)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            {actions}
          </div>
        </div>

        {message ? <small className="tone-positive">{message}</small> : null}
        {refreshingRows ? <small className="tone-muted">Updating transactions...</small> : null}
        {error ? <small className="warning-text">{error}</small> : null}

        {!localRows.length ? (
          <div className="empty-transactions">
            <div className="dropzone-icon" aria-hidden="true">
              CSV
            </div>
            <h3>No transactions yet</h3>
            <p>Import your DeGiro transactions export to build performance, exposure, and activity history.</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => document.querySelector<HTMLElement>(".dropzone")?.click()}
            >
              Import your DeGiro CSV
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table transactions-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Instrument</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Price</th>
                  <th>Currency</th>
                  <th>Venue</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.date}</td>
                    <td>
                      <span className={`pill ${row.type === "Buy" ? "buy" : "sell"}`}>{row.type}</span>
                    </td>
                    <td className="transaction-name" title={row.name}>
                      {row.name}
                    </td>
                    <td className="text-right mono">{row.quantity}</td>
                    <td className="text-right mono">{row.price}</td>
                    <td className="mono">{row.currency}</td>
                    <td className="mono">{row.exchangeCode}</td>
                    <td className="text-right mono amount-cell">{row.amount}</td>
                    <td className="text-right transaction-actions-cell">
                      <div className="transaction-action-menu">
                        <button
                          type="button"
                          className="icon-btn transaction-action-trigger"
                          aria-label={`Open actions for ${row.name}`}
                          aria-expanded={menuOpenFor === row.id}
                          onClick={() => setMenuOpenFor((current) => (current === row.id ? null : row.id))}
                        >
                          <span aria-hidden="true">...</span>
                        </button>
                        {menuOpenFor === row.id ? (
                          <div className="transaction-action-popover" role="menu">
                            <button
                              type="button"
                              className="transaction-action-danger"
                              role="menuitem"
                              onClick={() => {
                                setDeleteCandidate(row);
                                setMenuOpenFor(null);
                                setError(null);
                                setMessage(null);
                              }}
                            >
                              Delete transaction
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {localRows.length ? (
          <div className="danger-zone">
            <div>
              <div className="section-title">Danger zone</div>
              <p>Clear your imported portfolio data and start again.</p>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => {
                setDeleteAllOpen(true);
                setError(null);
                setMessage(null);
              }}
            >
              Delete all transactions
            </button>
          </div>
        ) : null}
      </div>

      {deleteCandidate ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeSingleDeleteDialog();
          }}
        >
          <div className="modal-panel modal-panel-sm" role="dialog" aria-modal="true" aria-labelledby="delete-transaction-title">
            <div className="stack">
              <div className="stack-sm">
                <div className="section-title">Delete transaction</div>
                <h3 id="delete-transaction-title">Delete transaction?</h3>
                <p className="modal-copy">This will permanently delete this transaction and recalculate your portfolio.</p>
              </div>
              <div className="delete-summary">
                <strong>{deleteCandidate.name}</strong>
                <span>
                  {deleteCandidate.type}, {deleteCandidate.quantity} shares, {deleteCandidate.amount}, {deleteCandidate.date}
                </span>
              </div>
              {error ? <small className="warning-text">{error}</small> : null}
              <div className="row row-start">
                <button type="button" className="btn btn-sm" onClick={closeSingleDeleteDialog} disabled={Boolean(pendingAction)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => void deleteTransaction(deleteCandidate)}
                  disabled={Boolean(pendingAction)}
                >
                  {pendingAction === "single" ? "Deleting..." : "Delete transaction"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {deleteAllOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDeleteAllDialog();
          }}
        >
          <div className="modal-panel modal-panel-sm" role="dialog" aria-modal="true" aria-labelledby="delete-all-title">
            <div className="stack">
              <div className="stack-sm">
                <div className="section-title">Clear portfolio</div>
                <h3 id="delete-all-title">Clear portfolio?</h3>
                <p className="modal-copy">
                  This will permanently delete all your transactions and remove your portfolio history from ETFMinded.
                  Your account will remain active and you can import transactions again later. This action cannot be undone.
                </p>
              </div>
              <label>
                Type DELETE to confirm
                <input
                  type="text"
                  value={deleteAllConfirmation}
                  onChange={(event) => setDeleteAllConfirmation(event.target.value)}
                  disabled={Boolean(pendingAction)}
                  autoComplete="off"
                />
              </label>
              {error ? <small className="warning-text">{error}</small> : null}
              <div className="row row-start">
                <button type="button" className="btn btn-sm" onClick={closeDeleteAllDialog} disabled={Boolean(pendingAction)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => void deleteAllTransactions()}
                  disabled={Boolean(pendingAction) || deleteAllConfirmation !== "DELETE"}
                >
                  {pendingAction === "all" ? "Deleting..." : "Delete all transactions"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
