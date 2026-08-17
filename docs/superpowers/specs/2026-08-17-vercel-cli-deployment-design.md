# Vercel CLI Production Deployment

## Goal

Allow any authorized GitHub contributor to merge to `main` without Vercel blocking production because the commit author lacks a paid Vercel seat.

## Design

GitHub Actions will own production deployment. Vercel's Git-triggered deployments remain disabled through `vercel.json`.

For pull requests, CI continues to run lint, unit tests, component tests, the migration guard, and the existing placeholder-environment Next.js build.

For pushes to `main`, CI will:

1. Run lint and tests.
2. Check out the merged revision and install the locked Bun dependencies.
3. Pull the production project settings and environment variables with `vercel pull`.
4. Build once with `vercel build --prod`.
5. Upload that output with `vercel deploy --prebuilt --prod`.

The workflow will use the repository's locked Vercel CLI through `bunx vercel`, rather than installing a global or canary CLI. The production deployment job will authenticate as an existing deploying Vercel user through a project-scoped token, so deployment authorization does not depend on the Git commit author.

## Configuration

The workflow requires these GitHub Actions secrets:

- `VERCEL_TOKEN`: project-scoped token belonging to an existing deploying team member
- `VERCEL_ORG_ID`: `team_AXO9HQJA3fbSsTQAn0wLbz5o`
- `VERCEL_PROJECT_ID`: `prj_FKUE9b2vKrQOarYFthpWDOCDTqaN`

The old `VERCEL_DEPLOY_HOOK_URL` secret may be removed after the first successful CLI deployment.

## Failure behavior

Unlike the asynchronous deploy hook, the CLI command waits for Vercel's deployment result. A rejected or failed build therefore fails the GitHub Actions deployment job rather than reporting a false success.

No production deployment runs when lint, tests, or component tests fail. Pull requests cannot access or invoke the production deployment token.

## Validation

- Review the workflow syntax and trigger conditions in the pull request.
- Confirm pull-request CI still exposes the existing `Build` check.
- Add the three repository secrets before merging.
- Merge the PR and verify the first `main` workflow produces a ready production deployment.
- Confirm the deployed SHA and application health before removing the old deploy-hook secret.
