"use client";

import { type FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type ExchangeOption = {
  code: string;
  name: string | null;
  country: string | null;
  currency: string | null;
};

type ManualTransactionButtonProps = {
  exchanges: ExchangeOption[];
};

type FormState = {
  tradeAt: string;
  side: "BUY" | "SELL";
  name: string;
  isin: string;
  quantity: string;
  price: string;
  currency: string;
  exchangeCode: string;
  transactionCosts: string;
};

const TRANSACTIONS_CHANGED_EVENT = "transactions:changed";

function todayDateValue() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function buildInitialForm(exchanges: ExchangeOption[]): FormState {
  const firstExchange = exchanges[0];

  return {
    tradeAt: todayDateValue(),
    side: "BUY",
    name: "",
    isin: "",
    quantity: "",
    price: "",
    currency: firstExchange?.currency || "EUR",
    exchangeCode: firstExchange?.code || "",
    transactionCosts: ""
  };
}

function exchangeLabel(exchange: ExchangeOption) {
  const parts = [exchange.code];
  if (exchange.name) parts.push(exchange.name);
  if (exchange.country) parts.push(exchange.country);
  if (exchange.currency) parts.push(exchange.currency);
  return parts.join(" | ");
}

// Opens a lightweight modal so users can add a single trade without going through CSV import.
export function ManualTransactionButton({ exchanges }: ManualTransactionButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => buildInitialForm(exchanges));

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, submitting]);

  function openModal() {
    setError(null);
    setMessage(null);
    setForm(buildInitialForm(exchanges));
    setOpen(true);
  }

  function closeModal() {
    if (submitting) return;
    setOpen(false);
  }

  function updateField<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  function updateExchange(value: string) {
    const selected = exchanges.find((exchange) => exchange.code === value);
    setForm((current) => ({
      ...current,
      exchangeCode: value,
      currency: selected?.currency || current.currency || "EUR"
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tradeAt: form.tradeAt,
          side: form.side,
          name: form.name.trim(),
          isin: form.isin.trim().toUpperCase(),
          quantity: Number(form.quantity),
          price: Number(form.price),
          currency: form.currency.trim().toUpperCase(),
          exchangeCode: form.exchangeCode,
          transactionCosts:
            form.transactionCosts.trim() === "" ? null : Number(form.transactionCosts)
        })
      });

      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(data.error || "Unable to create transaction.");
        return;
      }

      setOpen(false);
      setMessage("Transaction added.");
      window.dispatchEvent(new CustomEvent(TRANSACTIONS_CHANGED_EVENT));
      router.refresh();
    } catch {
      setError("Unable to create transaction.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="stack-sm">
        <button type="button" className="btn btn-sm" onClick={openModal} disabled={!exchanges.length}>
          <span aria-hidden="true">+</span>
          Manual entry
        </button>
        {message ? <small>{message}</small> : null}
        {!exchanges.length ? <small className="warning-text">No exchanges available. Run exchange sync first.</small> : null}
      </div>

      {open ? (
        <div className="modal-backdrop" role="presentation" onClick={(event) => {
          if (event.target === event.currentTarget) {
            closeModal();
          }
        }}>
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="manual-transaction-title">
            <div className="row">
              <div className="stack-sm">
                <div className="section-title">Transactions</div>
                <h3 id="manual-transaction-title">Add transaction</h3>
                <small>Manual trades keep the current signed-quantity model used across portfolio calculations.</small>
              </div>
              <button type="button" className="btn btn-sm" onClick={closeModal} disabled={submitting}>
                Cancel
              </button>
            </div>

            <form className="manual-transaction-form" onSubmit={handleSubmit}>
              <div className="manual-transaction-grid">
                <label>
                  Transaction date
                  <input
                    type="date"
                    value={form.tradeAt}
                    onChange={(event) => updateField("tradeAt", event.target.value)}
                    required
                  />
                </label>

                <label>
                  Type
                  <select
                    value={form.side}
                    onChange={(event) => updateField("side", event.target.value as FormState["side"])}
                    required
                  >
                    <option value="BUY">Buy</option>
                    <option value="SELL">Sell</option>
                  </select>
                </label>

                <label>
                  Name
                  <input
                    type="text"
                    value={form.name}
                    onChange={(event) => updateField("name", event.target.value)}
                    placeholder="iShares Core MSCI World"
                    required
                  />
                </label>

                <label>
                  ISIN
                  <input
                    type="text"
                    value={form.isin}
                    onChange={(event) => updateField("isin", event.target.value.toUpperCase())}
                    placeholder="IE00B4L5Y983"
                    minLength={12}
                    maxLength={12}
                    required
                  />
                </label>

                <label>
                  Quantity
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0.00000001"
                    step="0.00000001"
                    value={form.quantity}
                    onChange={(event) => updateField("quantity", event.target.value)}
                    required
                  />
                </label>

                <label>
                  Price
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0.00000001"
                    step="0.00000001"
                    value={form.price}
                    onChange={(event) => updateField("price", event.target.value)}
                    required
                  />
                </label>

                <label>
                  Currency
                  <input
                    type="text"
                    value={form.currency}
                    onChange={(event) => updateField("currency", event.target.value.toUpperCase())}
                    maxLength={8}
                    required
                  />
                </label>

                <label>
                  Exchange
                  <select
                    value={form.exchangeCode}
                    onChange={(event) => updateExchange(event.target.value)}
                    required
                  >
                    {exchanges.map((exchange) => (
                      <option key={exchange.code} value={exchange.code}>
                        {exchangeLabel(exchange)}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Transaction costs
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.00000001"
                    value={form.transactionCosts}
                    onChange={(event) => updateField("transactionCosts", event.target.value)}
                    placeholder="0.00"
                  />
                </label>
              </div>

              {error ? <small className="warning-text">{error}</small> : null}

              <div className="row row-start">
                <button type="button" className="btn btn-sm" onClick={closeModal} disabled={submitting}>
                  Close
                </button>
                <button type="submit" className="btn btn-sm btn-primary" disabled={submitting || !exchanges.length}>
                  {submitting ? "Saving..." : "Save transaction"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
