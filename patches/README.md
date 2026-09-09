# OAuth provider resource seeding

`@better-auth/oauth-provider@1.7.1` eagerly calls `seedResources` during plugin
initialization. A connection failure rejects Better Auth's shared `$context`
promise permanently, affecting unrelated session and organization requests even
after the database recovers. See [upstream issue #10887](https://github.com/better-auth/better-auth/issues/10887).

Our patch removes that eager call. The provider's existing `getResource` →
`seedResourcesOnce` path seeds on first resource access, shares concurrent work,
and clears its promise on failure so a later request can try again. No auth
instance or OAuth request is replayed. A request that encounters the database
failure still fails normally; the patch prevents it from poisoning auth startup.

This is a local workaround using the provider's existing code, not a merged
upstream fix. The exact dependency version and `patchedDependencies` entry keep
Bun installs reproducible. When upgrading, check whether upstream has fixed the
eager seed and run `bun run test src/lib/auth.test.ts`
before removing or rebasing the patch. Those tests exercise the installed package,
including real TCP resets, concurrent requests, and the CIMD token/MCP flow.
