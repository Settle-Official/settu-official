import { NextRequest, NextResponse } from "next/server";
import { PaycrestAdapter } from "@/lib/offramp/adapters/paycrest-adapter";
import {
  isPayableAccountIdentifier,
  normalizeAccountIdentifier,
} from "@/lib/offramp/utils/validation";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const institution = body?.institution;
    const accountIdentifier = normalizeAccountIdentifier(
      institution,
      body?.accountIdentifier,
    );

    if (!institution || !accountIdentifier) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (!isPayableAccountIdentifier(institution, accountIdentifier)) {
      return NextResponse.json(
        { error: "Invalid account number format" },
        { status: 400 }
      );
    }

    const paycrestApiKey = process.env.PAYCREST_API_KEY;
    if (!paycrestApiKey) {
      throw new Error("PAYCREST_API_KEY not configured");
    }

    const paycrest = new PaycrestAdapter(paycrestApiKey);
    const accountName = await paycrest.verifyAccount(
      institution,
      accountIdentifier
    );

    // accountIdentifier is echoed back normalised, for callers that want to
    // show the number the payout will actually use.
    return NextResponse.json({ data: accountName, accountIdentifier });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to verify account" },
      { status: 500 }
    );
  }
}
