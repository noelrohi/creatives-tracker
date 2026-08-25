# Meta URL tags import

## Problem

Meta stores Ads Manager's **URL parameters** separately from the landing URL in the creative's `url_tags` field. Adsolute currently imports only the landing URL, so the Creatives table shows empty query-parameter and UTM columns even when buyers configured URL parameters in Meta.

## Design

- Add nullable `url_tags` storage and a nullable `url_tags_checked_at` timestamp to each ad. Keep tags separate from `destination_url`; the clickable landing URL must remain unchanged. The timestamp distinguishes “Meta returned no tags” from “not checked yet.”
- Request `creative.url_tags` during Meta preview enrichment, persist the raw value when present, and stamp `url_tags_checked_at` after every successful response.
- Treat an ad whose URL tags have never been checked as eligible for preview enrichment, allowing a normal sync to backfill existing ads once without retrying tagless ads forever.
- Return URL tags with creative list rows. For query-param and UTM columns, parse URL tags first and fall back to parameters embedded in the destination URL.
- Preserve Meta template values such as `{{campaign.name}}` verbatim.

## Verification

Cover extraction and precedence with unit tests, persistence/candidate behavior with existing Meta import tests, and run lint, typecheck, relevant tests, and build before opening the PR.
