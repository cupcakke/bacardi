import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest): NextResponse {
  const credential = process.env.NAC_HTTP_AUTH;
  if (!credential) return NextResponse.next();
  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Basic ${Buffer.from(credential).toString("base64")}`;
  const supplied = Buffer.from(authorization);
  const desired = Buffer.from(expected);
  if (supplied.length === desired.length && timingSafeEqual(supplied, desired)) return NextResponse.next();
  return new NextResponse("Authentication required", { status: 401, headers: { "www-authenticate": "Basic realm=\"Nested workspace\", charset=\"UTF-8\"", "cache-control": "no-store" } });
}
export const config = { matcher: ["/((?!api/health|_next/static|_next/image|favicon.ico).*)"] };
