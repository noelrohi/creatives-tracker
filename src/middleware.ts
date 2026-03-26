import { NextRequest, NextResponse } from "next/server";

export async function middleware(request: NextRequest) {
  // Get the session token from cookies
  const sessionToken =
    request.cookies.get("better-auth.session_token")?.value;

  const { pathname } = request.nextUrl;
  const isAuthPage =
    pathname.startsWith("/sign-in") ||
    pathname.startsWith("/sign-up") ||
    pathname.startsWith("/accept-invitation");
  const isPublicPage = pathname.startsWith("/reference");

  // Unauthenticated users → redirect to sign-in
  if (!sessionToken && !isAuthPage && !isPublicPage) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  // Authenticated users on auth pages → redirect to dashboard
  if (sessionToken && isAuthPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - api routes (tRPC, auth, upload, etc.)
     * - _next/static, _next/image (Next.js internals)
     * - favicon.ico, robots.txt, etc.
     */
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt).*)",
  ],
};
