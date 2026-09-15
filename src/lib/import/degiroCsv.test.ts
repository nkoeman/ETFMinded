import { describe, expect, it } from "vitest";
import { aggregateDegiroOrderExecutions, parseDegiroCsv } from "@/lib/import/degiroCsv";

describe("parseDegiroCsv", () => {
  it("parses Order ID when present", () => {
    const csv = [
      "Datum,Tijd,Product,ISIN,Beurs,Aantal,Koers,Waarde EUR,Totaal EUR,Valuta,Order ID",
      "01-03-2026,10:30,Sample ETF,IE00B4L5Y983,XAMS,2,100,200,200,EUR,ABC-123"
    ].join("\n");

    const rows = parseDegiroCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe("ABC-123");
  });

  it("returns null orderId when Order ID is empty", () => {
    const csv = [
      "Datum,Tijd,Product,ISIN,Beurs,Aantal,Koers,Waarde EUR,Totaal EUR,Valuta,Order ID",
      "01-03-2026,10:30,Sample ETF,IE00B4L5Y983,XAMS,2,100,200,200,EUR,"
    ].join("\n");

    const rows = parseDegiroCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBeNull();
  });

  it("aggregates split execution rows with the same Order ID into one logical transaction", () => {
    const csv = [
      "Datum,Tijd,Product,ISIN,Beurs,Aantal,Koers,Waarde EUR,Totaal EUR,Valuta,Order ID",
      "14-09-2026,12:05,ISHARES CORE EURO STOXX 50 UCITS ETF EUR DIST,IE0008471009,EAM,-9,\"63,6500\",\"572,85\",\"572,85\",EUR,13ac0168-6471-49cd-83e4-c107e4ca2ceb",
      "14-09-2026,12:05,ISHARES CORE EURO STOXX 50 UCITS ETF EUR DIST,IE0008471009,EAM,-10,\"63,6600\",\"636,60\",\"633,60\",EUR,13ac0168-6471-49cd-83e4-c107e4ca2ceb"
    ].join("\n");

    const rows = aggregateDegiroOrderExecutions(parseDegiroCsv(csv));

    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe("13ac0168-6471-49cd-83e4-c107e4ca2ceb");
    expect(rows[0].isin).toBe("IE0008471009");
    expect(rows[0].quantity).toBe(-19);
    expect(rows[0].valueEur).toBeCloseTo(1209.45, 6);
    expect(rows[0].totalEur).toBeCloseTo(1206.45, 6);
    expect(rows[0].price).toBeCloseTo((9 * 63.65 + 10 * 63.66) / 19, 10);
  });

  it("rejects same Order ID rows with conflicting ISINs", () => {
    const csv = [
      "Datum,Tijd,Product,ISIN,Beurs,Aantal,Koers,Waarde EUR,Totaal EUR,Valuta,Order ID",
      "14-09-2026,12:05,Sample ETF A,IE0000000001,EAM,-9,\"63,6500\",\"572,85\",\"572,85\",EUR,ORD-1",
      "14-09-2026,12:05,Sample ETF B,IE0000000002,EAM,-10,\"63,6600\",\"636,60\",\"633,60\",EUR,ORD-1"
    ].join("\n");

    expect(() => aggregateDegiroOrderExecutions(parseDegiroCsv(csv))).toThrow(/multiple ISINs/);
  });
});
