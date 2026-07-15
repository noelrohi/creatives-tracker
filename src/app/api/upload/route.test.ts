import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  getOrganizationRole: vi.fn(),
  getSession: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ put: mocks.put }));
vi.mock("@/lib/api-keys", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
  getBearerToken: (headerValue: string | null) => {
    if (!headerValue) return null;
    const [scheme, token] = headerValue.split(" ", 2);
    return scheme?.toLowerCase() === "bearer" ? token?.trim() || null : null;
  },
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@/lib/server/organization-role", () => ({
  getOrganizationRole: mocks.getOrganizationRole,
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

import { POST } from "./route";

const blobUrl = "https://blob.example/upload.png";
const testBytes = new TextEncoder().encode("test upload bytes");
const expectedHash = createHash("sha256").update(testBytes).digest("hex");

function uploadRequest(authorization?: string) {
  const formData = new FormData();
  formData.append("file", new File([testBytes], "upload.png", { type: "image/png" }));

  return new Request("http://localhost/api/upload", {
    method: "POST",
    headers: authorization ? { authorization } : undefined,
    body: formData,
  });
}

describe("POST /api/upload", () => {
  beforeEach(() => {
    mocks.put.mockResolvedValue({ url: blobUrl });
    mocks.getOrganizationRole.mockResolvedValue("owner");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uploads with a write-scoped bearer key and returns its SHA-256", async () => {
    mocks.authenticateApiKey.mockResolvedValue({
      apiKeyId: "key-1",
      organizationId: "org-1",
      scopes: ["write"],
    });

    const response = await POST(uploadRequest("Bearer ask_test.secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: blobUrl,
      hash: expectedHash,
    });
    expect(mocks.authenticateApiKey).toHaveBeenCalledWith("ask_test.secret");
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("rejects a read-only bearer key", async () => {
    mocks.authenticateApiKey.mockResolvedValue({
      apiKeyId: "key-1",
      organizationId: "org-1",
      scopes: ["read"],
    });

    const response = await POST(uploadRequest("Bearer ask_test.secret"));

    expect(response.status).toBe(403);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer key", async () => {
    mocks.authenticateApiKey.mockResolvedValue(null);

    const response = await POST(uploadRequest("Bearer bad-key"));

    expect(response.status).toBe(401);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("uploads with a valid session and returns its SHA-256", async () => {
    mocks.getSession.mockResolvedValue({
      session: { activeOrganizationId: "org-1" },
      user: { id: "user-1" },
    });

    const response = await POST(uploadRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: blobUrl,
      hash: expectedHash,
    });
    expect(mocks.authenticateApiKey).not.toHaveBeenCalled();
  });

  it("rejects a request without a bearer key or session", async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await POST(uploadRequest());

    expect(response.status).toBe(401);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.authenticateApiKey).not.toHaveBeenCalled();
  });
});
