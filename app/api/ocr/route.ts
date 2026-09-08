import { NextResponse } from "next/server";
import { recognizeWithCloudOcr } from "@/lib/ocr";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();
  const image = form.get("image");
  if (!(image instanceof File)) return NextResponse.json({ error: "Expected an image upload" }, { status: 400 });
  try {
    return NextResponse.json(await recognizeWithCloudOcr(image));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cloud OCR failed" }, { status: 502 });
  }
}
