import { NextResponse } from "next/server";
import { fetchDeepSWESnapshot } from "@/lib/deepswe";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await fetchDeepSWESnapshot());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to fetch DeepSWE data" }, { status: 502 });
  }
}
