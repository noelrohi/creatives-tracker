import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

export async function middleware(request: NextRequest) {
  const sessionToken = getSessionCookie(request);

  const { pathname } = request.nextUrl;
  const isAuthPage =
    pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up");
  const isInvitationPage = pathname.startsWith("/accept-invitation");
  const isPublicPage = pathname.startsWith("/reference");

  // Unauthenticated users → redirect to sign-in (but allow invitation page)
  if (!sessionToken && !isAuthPage && !isInvitationPage && !isPublicPage) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  // Authenticated users on sign-in/sign-up → redirect to dashboard
  // Note: /accept-invitation is intentionally excluded — signed-in users
  // need to reach it to accept or reject invitations
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
