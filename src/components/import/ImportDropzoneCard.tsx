"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type LatestImportMeta = {
  createdAt: string | null;
  fileName: string | null;
  importedRows: number | null;
};

type ImportDropzoneCardProps = {
  latestImport: LatestImportMeta;
};

type ImportResult = {
  imported: number;
  updated?: number;
  skipped: number;
  totalRows: number;
  initialSetup?: boolean;
  warning?: string | null;
};

const TRANSACTIONS_CHANGED_EVENT = "transactions:changed";

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().slice(0, 10);
}

export function ImportDropzoneCard({ latestImport }: ImportDropzoneCardProps) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const inFlight = useRef(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!uploading) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [uploading]);
  const [dragActive, setDragActive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uploadFile = useCallback(
    async (file: File) => {
      if (!file || inFlight.current) return;

      inFlight.current = true;
      setElapsedSeconds(0);
      setUploading(true);
      setError(null);
      setMessage(null);

      try {
        const formData = new FormData();
        formData.set("file", file);

        const response = await fetch("/api/import", {
          method: "POST",
          body: formData
        });
        const body = (await response.json()) as ImportResult | { error?: string };
        if (!response.ok) {
          throw new Error(typeof body === "object" && body && "error" in body ? body.error || "Import failed." : "Import failed.");
        }

        const result = body as ImportResult;
        const updated = result.updated ?? 0;
        setMessage(
          `Imported ${result.imported} new row(s), updated ${updated} existing row(s), skipped ${result.skipped} unchanged row(s) out of ${result.totalRows}.`
        );
        if (result.warning) setError(result.warning);
        if (result.initialSetup) {
          router.push("/app/setup");
          return;
        }
        window.dispatchEvent(new CustomEvent(TRANSACTIONS_CHANGED_EVENT));
        router.refresh();
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "Import failed.");
      } finally {
        inFlight.current = false;
        setUploading(false);
      }
    },
    [router]
  );

  const lastImportLabel = useMemo(() => {
    if (!latestImport.createdAt) return "No previous import";
    const rowsLabel = latestImport.importedRows === null ? "-" : `${latestImport.importedRows} row(s)`;
    return `${formatDate(latestImport.createdAt)} - ${rowsLabel}`;
  }, [latestImport]);

  return (
    <div className="card stack import-card">
      <div className="card-head">
        <div>
          <h2 className="card-title">Import DeGiro CSV</h2>
          <p className="card-sub">Duplicate transactions are skipped automatically.</p>
        </div>
      </div>

      <label
        className={`dropzone${dragActive ? " is-drag" : ""}`}
        aria-busy={uploading}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          const file = event.dataTransfer?.files?.[0];
          if (file) void uploadFile(file);
        }}
      >
        <input
          type="file"
          disabled={uploading}
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadFile(file);
            event.currentTarget.value = "";
          }}
        />
        <div className="dropzone-icon" aria-hidden="true">
          CSV
        </div>
        <div>
          <h3>Drop CSV here, or click to browse</h3>
          <p>Supported columns: Datum, Tijd, Product, ISIN, Aantal, Koers, Waarde EUR, Totaal EUR</p>
        </div>
        <span className="btn btn-primary" aria-disabled={uploading}>
          {uploading ? <span className="import-loading-spinner" aria-hidden="true" /> : null}
          {uploading ? "Updating portfolio..." : "Choose file"}
        </span>
      </label>

      {uploading ? (
        <div className="import-progress">
          <p role="status">
            {elapsedSeconds < 30
              ? "Processing transactions and updating your portfolio. Please keep this page open."
              : "Still processing. Portfolio history and external data checks can take longer. Please keep this page open."}
          </p>
          <small className="tabular-nums" aria-hidden="true">
            Elapsed: {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, "0")}
          </small>
        </div>
      ) : null}

      <div className="import-status-rows">
        <div className="import-status-row">
          <span>Last import</span>
          <strong>{lastImportLabel}</strong>
        </div>
        <div className="import-status-row">
          <span>Mapped instruments</span>
          <strong>{latestImport.fileName ? latestImport.fileName : "Waiting for CSV"}</strong>
        </div>
        {message ? <small className="tone-positive">{message}</small> : null}
        {error ? <small className="warning-text">{error}</small> : null}
      </div>
    </div>
  );
}
