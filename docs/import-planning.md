# Content Plan CSV Import (MVP)

Backend import for the marketing content plan. Valid rows become **draft** `PostJob` records so they appear on the calendar. Nothing is queued or published automatically.

## File requirements

- Format: `.csv` (`.xlsx` / `.xls` are rejected)
- Encoding: UTF-8 (BOM allowed)
- Delimiter: comma or semicolon (auto-detected)
- Maximum size: 5 MB
- Maximum data rows: 1,000
- One sheet per file

### Export instructions

Excel:

1. Open the sheet that contains the content plan (`Worksheet` / `Worksheet 2` in the client file).
2. `File > Save As > CSV UTF-8 (Comma delimited) (*.csv)`.
3. Upload the resulting `.csv`.

Google Sheets:

1. Open the content-plan sheet.
2. `File > Download > Comma-separated values (.csv)`.
3. Upload the resulting `.csv`.

The importer accepts the client's two-row header. The first row may contain group headers such as `Category` / `Content Review`, and the second row may contain `Content Pillar`, `Content Category`, `Acc by`, `PIC Design`, etc.

## Columns

Required:

| Column | Use |
|---|---|
| `Content Title` | `content.title`, shown on the calendar |
| `Post Date` | `scheduledFor` |
| `Platform` | `content.platforms` and account targets |

Optional:

| Column | Use |
|---|---|
| `Content Pillar` | `content.pillar` |
| `Content Category` | `content.category` |
| `Link Copywrite` | `content.designCopy` (raw, preserved exactly) |
| `Aset Pendukung` | `content.assetNotes` (links/notes, not media uploads) |
| `PIC Content` | `content.picContent` |
| `Content Review` | `content.contentReview` |
| `Acc by` | `content.approvedBy` |
| `PIC Design` | `content.picDesign` |
| `Progress Content` | `content.progress` |
| `Link Output` | `content.outputUrl` |
| `Status` | `content.sourceStatus` |

Caption and media are **not** in the Excel/CSV. The import leaves `content.text` empty and `content.mediaUrls` empty. `Link Copywrite` is design copy, not a caption.

## Date rules

- Preferred: `YYYY-MM-DD`
- Also accepted: `DD/MM/YYYY`, `DD-MM-YYYY`, `YYYY/MM/DD`
- Ambiguous slash dates such as `01/02/2026` are read as `DD/MM/YYYY` with a warning.
- No time column: default is **09:00 WIB**.
- Past dates are imported as archive drafts with a warning.

## Platform rules

| CSV value | Stored platforms |
|---|---|
| `LinkedIn` / `LI` | `linkedin` |
| `Instagram` / `IG` | `instagram` |
| `Mirroring (LI&Ig)` / `LI & IG` | `linkedin`, `instagram` |
| `Website` | `website` (draft only; no social target) |

Unknown platforms make the row invalid.

If exactly one connected account exists for a platform, it is linked automatically. If none or more than one exists, the draft is still created without that target and a warning tells the user to choose an account manually.

## Endpoints

All endpoints require the normal auth cookie. Use the same workspace header as other app routes when needed (`x-workspace-id`).

### Preview

```http
POST /jobs/import/preview
Content-Type: multipart/form-data
```

Field:

- `file`: CSV file

Response:

```json
{
  "file": {
    "name": "content-plan.csv",
    "delimiter": ",",
    "headerRow": 1,
    "subHeaderRow": 2
  },
  "summary": {
    "totalRows": 85,
    "validRows": 70,
    "invalidRows": 10,
    "duplicateRows": 5
  },
  "rows": [
    {
      "sourceRow": 73,
      "importKey": "...",
      "title": "Slope Stability Before the Rain Peaks",
      "postDate": "2026-10-22",
      "scheduledFor": "2026-10-22T02:00:00.000Z",
      "platforms": ["linkedin", "instagram"],
      "designCopyPreview": "Slide 1...",
      "designCopyLength": 2450,
      "designCopyHasLineBreaks": true,
      "targets": [],
      "warnings": ["Akun linkedin belum terhubung; draft dibuat tanpa target."]
    }
  ],
  "invalidRows": [
    {
      "sourceRow": 84,
      "title": "Row without platform",
      "reason": "Platform wajib diisi."
    }
  ],
  "duplicates": []
}
```

`designCopyPreview` is truncated to 500 characters. The full value is only stored during commit, from the original file.

### Commit

```http
POST /jobs/import/commit
Content-Type: multipart/form-data
```

Fields:

- `file`: the same CSV file used for preview
- `sourceRows` (optional): JSON array or comma-separated row numbers, e.g. `[73,74]` or `73,74`

The server re-parses and re-validates the file. It does not trust the preview payload. If `sourceRows` is omitted, all valid non-duplicate rows are imported.

Response:

```json
{
  "summary": {
    "totalRows": 85,
    "selectedRows": 85,
    "created": 70,
    "skipped": 15,
    "invalidRows": 10,
    "duplicateRows": 5
  },
  "jobs": [
    {
      "id": "c...",
      "sourceRow": 73,
      "title": "Slope Stability Before the Rain Peaks",
      "scheduledFor": "2026-10-22T02:00:00.000Z"
    }
  ],
  "skipped": [
    { "sourceRow": 84, "reason": "Platform wajib diisi." }
  ]
}
```

### Template

```http
GET /jobs/import/template
```

Returns `posthive-content-plan-template.csv` with headers and two sample rows, including a multiline `Link Copywrite` sample.

## Draft behavior

Imported rows are created with:

```text
status         = draft
approvalStatus = null
scheduledFor   = date at 09:00 WIB
commentText    = null
content.text   = ""
content.mediaUrls = []
```

No BullMQ job is created. The draft must be completed and scheduled manually.

The content JSON also stores:

```json
{
  "title": "...",
  "designCopy": "...",
  "designCopySource": "Link Copywrite",
  "assetNotes": "...",
  "platforms": ["linkedin", "instagram"],
  "sourceStatus": "Published",
  "sourceRow": 73,
  "importSource": {
    "fileName": "content-plan.csv",
    "importedAt": "2026-10-22T12:00:00.000Z",
    "delimiter": ","
  }
}
```

`designCopy` is preserved exactly, including line breaks, quotes, and commas. It is intentionally not split into slides; future Figma placeholder mapping can build on this field without re-importing.

## Duplicate prevention

`PostJob.importKey` is a SHA-256 hash of:

```text
normalized title | postDate | sorted platforms
```

There is a unique constraint on `[workspaceId, importKey]`. Re-importing the same plan returns `created: 0` for rows that already exist. Design-copy changes do not create a duplicate, and the existing draft is not overwritten.

## Frontend notes

Minimal upload flow:

```ts
const body = new FormData();
body.append("file", file);

const preview = await fetch(`${API_BASE}/jobs/import/preview`, {
  method: "POST",
  credentials: "include",
  body, // do NOT set Content-Type manually
});

const commitBody = new FormData();
commitBody.append("file", file);
commitBody.append("sourceRows", JSON.stringify(selectedRows)); // optional

await fetch(`${API_BASE}/jobs/import/commit`, {
  method: "POST",
  credentials: "include",
  body: commitBody,
});
```

If the app uses `apiFetch`, use a `FormData` body only if the helper leaves the `Content-Type` header unset.

- Imported drafts have `scheduledFor`, so the calendar should include them.
- Calendar/list titles should use `content.title` first, then `content.text`, then a fallback such as `Untitled`.
- A draft can have zero targets; don't treat that as an import failure.
- `Website` rows cannot be scheduled to a social account.
- Show `warnings` from preview and `skipped` from commit so users understand invalid/duplicate rows.
- The edit flow should let users add a caption, media, and accounts before scheduling. The existing `PATCH /jobs/:id` preserves unknown content JSON fields such as `designCopy`.

## Out of scope

- Direct Google Sheets API integration
- `.xlsx` parsing
- Caption generation
- Downloading media from Figma/Drive
- Automatic scheduling or publishing
- Splitting `designCopy` into Figma placeholders
