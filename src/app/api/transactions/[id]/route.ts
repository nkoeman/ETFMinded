import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getCurrentAppUser } from "@/lib/auth/appUser";
import { deleteTransactionForUser } from "@/lib/transactions/deleteTransactions";

export const runtime = "nodejs";

type RouteContext = {
  params: {
    id: string;
  };
};

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const user = await getCurrentAppUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const transactionId = String(context.params.id || "").trim();
    if (!transactionId) {
      return NextResponse.json({ error: "Transaction ID is required." }, { status: 400 });
    }

    const result = await deleteTransactionForUser(user.id, transactionId);
    if (!result.deleted) {
      if (result.reason === "locked") {
        return NextResponse.json(
          { error: "Portfolio update is already running. Try again after it completes." },
          { status: 409 }
        );
      }

      return NextResponse.json({ error: "Transaction not found." }, { status: 404 });
    }

    revalidatePath("/app");
    revalidatePath("/app/portfolio");
    revalidatePath("/app/import");
    revalidatePath("/app/insights");
    revalidatePath("/app/setup");

    return NextResponse.json({
      ok: true,
      transactionId: result.deletedTransaction.id,
      recalculated: result.recalculated,
      recalculatedPoints: result.recalculatedPoints
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete transaction.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
