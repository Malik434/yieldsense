import { NextRequest, NextResponse } from "next/server";

const APP_HOSTS = new Set(["app.yieldsense.org", "www.app.yieldsense.org"]);

function shouldSkip(pathname: string) {
  return (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  );
}

export function proxy(request: NextRequest) {
  const host = request.headers.get("host")?.split(":")[0].toLowerCase();
  const { pathname } = request.nextUrl;

  if (!host || shouldSkip(pathname) || !APP_HOSTS.has(host)) {
    return NextResponse.next();
  }

  if (pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
