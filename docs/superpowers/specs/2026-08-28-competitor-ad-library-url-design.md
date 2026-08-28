# Competitor Ad Library URL design

## Goal

Stop asking users to find and type a Meta page ID when they add a competitor. Ask for the advertiser's Meta Ad Library page URL and extract the ID from it.

## Dialog

Keep the competitor name field.

Replace the "Meta page ID" field with "Meta Ad Library page URL". Add an "Open Meta Ad Library" link beside the field help text. The link opens Meta Ad Library in a new tab, searches for the name already entered in the dialog, shows active ads across all countries, and sorts by total impressions. It uses safe external-link attributes.

The help text tells the user to search for the advertiser, open its page, and paste the resulting URL. The pasted URL must contain a non-empty `view_all_page_id` query parameter. An individual ad URL containing only `id` is not enough because that value identifies an ad, not its advertiser page.

## Data flow

Add a small parser to `src/components/blocks/competitor-signals/ad-library.ts`. It accepts a string and returns the Meta page ID only when all of these conditions hold:

- The value is a valid HTTPS URL.
- The hostname is `facebook.com` or one of its subdomains.
- The path is `/ads/library/` with or without the trailing slash.
- The URL contains a numeric `view_all_page_id` value.

The dialog parses the URL before calling `signals.addCompetitor`. It continues sending `{ name, metaPageId }`, so the server procedure and database do not change.

## Errors

Show errors below the URL field:

- Invalid or unrelated URL: "Paste a Meta Ad Library advertiser page URL."
- Individual ad URL: "Open the advertiser's page in Meta Ad Library, then copy that page URL."

Keep the existing duplicate-competitor error behavior.

## Tests

Add unit tests for the parser covering a normal advertiser URL, extra query parameters, accepted Facebook subdomains, missing or non-numeric page IDs, individual ad URLs, unrelated hosts, and malformed input.

Update the dialog component tests to cover the external link, successful ID extraction, and blocked submission for invalid and individual-ad URLs.
