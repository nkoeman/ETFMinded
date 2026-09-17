import { NextResponse } from "next/server";
import { getCurrentAppUser } from "@/lib/auth/appUser";
import { getPortfolioExposure } from "@/lib/exposure/portfolioExposure";

export const runtime = "nodejs";

function parseAsOf(value: string | null) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Invalid asOf date. Use YYYY-MM-DD.");
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid asOf date. Use YYYY-MM-DD.");
  }
  return parsed;
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const asOfDate = parseAsOf(url.searchParams.get("asOf")) || new Date();
    const result = await getPortfolioExposure(user.id, asOfDate);

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "private, no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load portfolio exposure.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
