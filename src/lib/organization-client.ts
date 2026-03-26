import { authClient } from "@/lib/auth-client";
import { getUserFacingErrorMessage } from "@/lib/errors";

type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
};

function slugifyOrganizationName(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
}

function withSuffix(baseSlug: string, attempt: number) {
  if (attempt === 0) {
    return baseSlug;
  }

  const suffix = Math.random().toString(36).slice(2, 6);
  return `${baseSlug.slice(0, 43)}-${suffix}`;
}

function isSlugConflict(errorMessage: string | undefined) {
  const message = errorMessage?.toLowerCase() ?? "";
  return (
    message.includes("slug") ||
    message.includes("unique") ||
    message.includes("already exists") ||
    message.includes("duplicate")
  );
}

export async function listOrganizations() {
  const response = await fetch("/api/auth/organization/list", {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error("Failed to load organizations");
  }

  return (await response.json()) as OrganizationSummary[];
}

export async function activateFirstOrganization() {
  const organizations = await listOrganizations();

  if (organizations.length === 0) {
    return { organizations, activatedOrganizationId: null };
  }

  const { error } = await authClient.organization.setActive({
    organizationId: organizations[0].id,
  });

  if (error) {
    throw new Error(
      getUserFacingErrorMessage(error, "Failed to activate workspace."),
    );
  }

  return {
    organizations,
    activatedOrganizationId: organizations[0].id,
  };
}

export async function createOrganizationWithUniqueSlug(name: string) {
  const baseSlug = slugifyOrganizationName(name);
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = withSuffix(baseSlug, attempt);
    const result = await authClient.organization.create({
      name,
      slug,
    });

    if (!result.error && result.data) {
      return result.data;
    }

    lastError = result.error?.message;
    if (!isSlugConflict(lastError)) {
      break;
    }
  }

  throw new Error(
    getUserFacingErrorMessage(
      { message: lastError },
      "Failed to create workspace.",
    ),
  );
}
