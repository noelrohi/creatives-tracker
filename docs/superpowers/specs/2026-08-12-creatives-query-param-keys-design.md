# Creatives Query Parameter Keys

## Goal

Add a visible **Query Param Keys** column to the creatives table so users can quickly see which tracking parameters are present in each creative's destination URL.

## Design

The column derives its value in the client from the existing `destinationUrl`; no API or database changes are needed. It parses the URL with the platform `URL` API, collects the query parameter names, removes duplicates, sorts them alphabetically, and renders them as a comma-separated string.

Missing or malformed URLs, and URLs without query parameters, render the table's standard em dash empty state. Long values use the existing truncated-cell and tooltip presentation used by the UTM columns. The column is visible by default and can be hidden through the existing column controls.

## Testing

Focused unit coverage will verify alphabetical sorting, duplicate removal, empty query strings, missing URLs, and malformed URLs. Existing lint and relevant test suites must continue to pass.

## Scope

This change only adds the derived creatives-table column and its tests. It does not persist query parameter keys, add filtering or sorting behavior, or alter the existing individual UTM columns.
