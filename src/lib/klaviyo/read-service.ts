import "server-only";

import { TRPCError } from "@trpc/server";
import {
  EnvironmentKlaviyoCredentialProvider,
  type KlaviyoCredentialProvider,
} from "@/lib/klaviyo/credential-provider";
import {
  getPilotConnectionForOrganization,
  type ConnectionRecord,
} from "@/lib/klaviyo/source-store";
import {
  KlaviyoReadError,
  KlaviyoReadTransport,
  type KlaviyoReadRequester,
} from "@/lib/klaviyo/read-transport";

export type KlaviyoReadContext = {
  client: KlaviyoReadRequester;
  scope: {
    organizationId: string;
    connectionId: string;
    accountTimezone: string | null;
  };
};

type ReadDependencies = {
  loadConnection: (organizationId: string) => Promise<ConnectionRecord | null>;
  credentialProvider: KlaviyoCredentialProvider;
  createClient: (privateApiKey: string) => KlaviyoReadRequester;
};

const credentialProvider = new EnvironmentKlaviyoCredentialProvider();
const defaults: ReadDependencies = {
  loadConnection: async (organizationId) => {
    try {
      await credentialProvider.getPilotBinding();
    } catch {
      throw new KlaviyoReadError("unavailable");
    }
    return getPilotConnectionForOrganization(organizationId, credentialProvider);
  },
  credentialProvider,
  createClient: (privateApiKey) => new KlaviyoReadTransport({ privateApiKey }),
};

function readError(error: unknown): TRPCError {
  if (error instanceof KlaviyoReadError) {
    switch (error.code) {
      case "invalid_input":
        return new TRPCError({ code: "BAD_REQUEST", message: "Invalid Klaviyo read parameters or continuation" });
      case "rate_limited":
        return new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: error.retryAfterMs !== null && error.retryAfterMs !== undefined
            ? `Klaviyo rate limit reached; retry after ${Math.ceil(error.retryAfterMs / 1000)} seconds`
            : "Klaviyo rate limit reached; retry later",
        });
      case "credential_rejected":
        return new TRPCError({ code: "PRECONDITION_FAILED", message: "Klaviyo read credentials were rejected" });
      case "unavailable":
        return new TRPCError({ code: "PRECONDITION_FAILED", message: "Klaviyo read connection is unavailable" });
      case "limit_exceeded":
        return new TRPCError({ code: "BAD_GATEWAY", message: "Klaviyo response exceeded the read limit" });
      case "invalid_response":
        return new TRPCError({ code: "BAD_GATEWAY", message: "Klaviyo returned an invalid read response" });
    }
  }
  // Provider/DB/credential exceptions may contain secrets or raw provider data.
  // Do not attach their cause: the API adapter must only see this fixed error.
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Klaviyo read failed" });
}

/** Read authority comes from the authenticated org, never an input account/key. */
export async function withKlaviyoReadContext<T>(
  organizationId: string,
  work: (context: KlaviyoReadContext) => Promise<T>,
  dependencies: ReadDependencies = defaults,
): Promise<T> {
  try {
    const connection = await dependencies.loadConnection(organizationId);
    if (
      !connection ||
      connection.organizationId !== organizationId ||
      connection.status !== "ready" ||
      !connection.klaviyoAccountId
    ) {
      throw new KlaviyoReadError("unavailable");
    }
    const credential = await dependencies.credentialProvider.resolve({
      connectionId: connection.connectionId,
      credentialReference: connection.credentialReference,
      persistedKlaviyoAccountId: connection.klaviyoAccountId,
      shopDomain: connection.shopDomain,
    });
    if (credential.expectedAccountId !== connection.klaviyoAccountId) {
      throw new KlaviyoReadError("unavailable");
    }
    return await work({
      client: dependencies.createClient(credential.privateApiKey),
      scope: {
        organizationId,
        connectionId: connection.connectionId,
        accountTimezone: connection.accountTimezone,
      },
    });
  } catch (error) {
    throw readError(error);
  }
}
