"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { organization } from "@/lib/auth-client";

// Query keys
const orgKeys = {
  all: ["organization"] as const,
  list: () => [...orgKeys.all, "list"] as const,
  full: () => [...orgKeys.all, "full"] as const,
};

// Fetch helper for Better Auth GET endpoints
async function authGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to fetch");
  return res.json();
}

// List all orgs the user belongs to
export function useListOrganizations() {
  return useQuery({
    queryKey: orgKeys.list(),
    queryFn: () =>
      authGet<
        { id: string; name: string; slug: string; logo: string | null; createdAt: string; metadata: string | null }[]
      >("/organization/list"),
  });
}

// Get full active organization (with members)
export function useActiveOrganization() {
  return useQuery({
    queryKey: orgKeys.full(),
    queryFn: () =>
      authGet<{
        id: string;
        name: string;
        slug: string;
        logo: string | null;
        members: {
          id: string;
          userId: string;
          role: string;
          createdAt: string;
          user: { id: string; name: string; email: string; image: string | null };
        }[];
        invitations: {
          id: string;
          email: string;
          role: string | null;
          status: string;
          expiresAt: string;
        }[];
      }>("/organization/get-full-organization"),
  });
}

// Create organization
export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; slug: string }) =>
      organization.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.list() });
    },
  });
}

// Set active organization
export function useSetActiveOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { organizationId: string }) =>
      organization.setActive(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.all });
    },
  });
}

// Invite member
export function useInviteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      email: string;
      role: "member" | "admin";
      organizationId: string;
    }) => organization.inviteMember(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.full() });
    },
  });
}

// Remove member
export function useRemoveMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { memberIdOrEmail: string }) =>
      organization.removeMember(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.full() });
    },
  });
}
