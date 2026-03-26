type ErrorLike = {
  message?: string;
  data?: {
    code?: string;
  };
};

function getMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return (error as ErrorLike).message;
  }
  return undefined;
}

function getCode(error: unknown) {
  if (typeof error === "object" && error !== null && "data" in error) {
    return (error as ErrorLike).data?.code;
  }
  return undefined;
}

export function getUserFacingErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Please try again.",
) {
  const message = getMessage(error);
  const code = getCode(error);
  const normalized = message?.toLowerCase() ?? "";

  if (!message) return fallback;

  if (
    normalized.includes("ad_account_meta_account_id_unique") ||
    normalized.includes("meta_account_id") ||
    (code === "CONFLICT" && normalized.includes("meta account"))
  ) {
    return "This Meta account is already connected.";
  }

  if (normalized.includes("no active organization selected")) {
    return "Select a workspace and try again.";
  }

  if (normalized.includes("account not found")) {
    return "Account not found.";
  }

  if (
    normalized.includes("slug") ||
    normalized.includes("organization_slug") ||
    normalized.includes("already exists") ||
    normalized.includes("duplicate")
  ) {
    return "That workspace already exists.";
  }

  if (normalized.includes("failed to switch organization")) {
    return "Failed to switch workspace.";
  }

  if (normalized.includes("failed to activate organization")) {
    return "Failed to activate workspace.";
  }

  if (normalized.includes("failed to delete workspace")) {
    return "Failed to delete workspace.";
  }

  if (normalized.includes("failed query:")) {
    return fallback;
  }

  return message;
}
