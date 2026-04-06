# Adsolute API Usage

Base URL: `https://resolution-tracker-six.vercel.app/api/openapi`

All requests require an API key via the `Authorization` header:

```
Authorization: Bearer <your-api-key>
```

## Ad Accounts

| Account | ID |
| --- | --- |
| Reviv 1 | `6eb900ea-259e-4620-bd82-fde16cf68ee7` |
| Reviv 2 | `fe981ddb-87b3-492d-89a3-b670c061db85` |
| Reviv 3 | `9e4da7a0-3d60-4f79-9ac5-ed1937578188` |

## Dashboard Stats

Weekly performance for owned creatives on Reviv 3:

```bash
curl 'https://resolution-tracker-six.vercel.app/api/openapi/adCreative/dashboardStats?days=7&statuses=active&ownership=ours&accountId=9e4da7a0-3d60-4f79-9ac5-ed1937578188' \
  -H 'Authorization: Bearer <your-api-key>'
```

### Parameters

| Param | Type | Description |
| --- | --- | --- |
| `days` | number | Lookback period (1–90, default 7) |
| `from` | string | Start date (ISO 8601), overrides `days` |
| `to` | string | End date (ISO 8601), overrides `days` |
| `accountId` | string | Filter by ad account ID |
| `campaignIds` | string | Comma-separated campaign IDs |
| `adSetIds` | string | Comma-separated ad set IDs |
| `statuses` | string | Ad status filter (e.g. `active`, `paused`) |
| `ownership` | string | `ours`, `theirs`, or omit for all |

### Response

```json
{
  "portfolio": {
    "totalSpend": "2320.60",
    "totalRevenue": "2944.54",
    "roas": "1.27",
    "cpa": "58.02",
    "ctr": "3.62",
    "conversions": "40"
  },
  "topPerformers": [...],
  "bottomPerformers": [...],
  "survivingCreatives": [...]
}
```

## Other Endpoints

Full interactive API docs available at: https://resolution-tracker-six.vercel.app/reference

### Common examples

**List all creatives:**

```bash
curl 'https://resolution-tracker-six.vercel.app/api/openapi/adCreative/list?ownership=ours&accountId=9e4da7a0-3d60-4f79-9ac5-ed1937578188' \
  -H 'Authorization: Bearer <your-api-key>'
```

**Get performance for a single creative:**

```bash
curl 'https://resolution-tracker-six.vercel.app/api/openapi/adCreative/getPerformance?id=<creative-id>' \
  -H 'Authorization: Bearer <your-api-key>'
```

**List ad accounts:**

```bash
curl 'https://resolution-tracker-six.vercel.app/api/openapi/adAccount/list' \
  -H 'Authorization: Bearer <your-api-key>'
```
