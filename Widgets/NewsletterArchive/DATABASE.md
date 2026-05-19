# Database Changes — Production MP (ArchO)

This document lists every modification the NewsletterArchive widget makes to
the production MinistryPlatform database at `mp.archomaha.org`. Use it as a
reference when deploying to a new tenant, auditing custom additions, or
troubleshooting why MP behaves differently than stock.

The CPP MP installation already includes various ArchO-specific custom
columns (e.g., `dp_Households.Auto_Add_Heads`); the additions below are
**specific to this widget** and are layered on top of that baseline.

All migrations are idempotent — running them twice is safe.

---

## Schema additions

### `dp_Publications.Targeted_Audience_ID` *(Schema/01)*

```sql
ALTER TABLE dbo.dp_Publications
    ADD Targeted_Audience_ID INT NULL
        CONSTRAINT FK_dp_Publications_Targeted_Audience
            FOREIGN KEY REFERENCES dbo.Audiences(Audience_ID);
```

**Purpose:** Adds the first tier of the visibility cascade. When this column
is non-NULL on a Publication row, only users who are members of the
referenced Audience can see the Publication's communications in the archive
widget. Falls back to `Congregation_ID`, then tenant-wide visibility.

This is the canonical mechanism for restricting archive items to a curated
group (e.g., parish council, school faculty, staff-only triage queue).

### `dp_Publications.Use_First_Body_Image_For_Featured` *(Schema/08)*

```sql
ALTER TABLE dbo.dp_Publications
    ADD Use_First_Body_Image_For_Featured BIT NULL;
```

**Purpose:** Per-Publication feature flag — when set to 1, the
`api_Custom_GetMyNewsletterArchive` SP returns `NULL` for the
`Featured_Image_URL` column on rows from that Pub, deferring the choice to
the widget JS body-extraction (3-tier: `axImg=1` → `width >= 300` → first
non-tiny image).

Currently opt-in:

| Publication_ID | Title | Why |
|---|---|---|
| 14 | Brother's Keeper | AxiosHQ-hosted; the curated first image IS the per-issue hero |

See README §**Feature flags** for the general pattern when adding new
per-Publication flags.

---

## Seeded lookup records *(Schema/02)*

### Verified — `dp_Communication_Types.Newsletter_Archive`

```sql
-- Pre-existing at ArchO. Verify only; fails fast if missing.
SELECT Communication_Type_ID FROM dbo.dp_Communication_Types
WHERE Communication_Type = 'Newsletter_Archive';
-- Expected: Communication_Type_ID = 5 (sandbox + prod)
```

Used by `api_Custom_CreatePublicationArchive` to classify ingested
communications. Not created by this migration — it's expected to exist
from the broader CPP MP configuration.

### Created — `Audiences` row

```
Audience_Name : "Targeted Newsletter Audience"
Description   : "CPP staff who target / triage newsletter publications.
                 Gates the Unsorted Publication in the Newsletter Archive
                 widget. Members see archive entries pending classification."
Domain_ID     : 1 (ArchO)
Active        : 1
```

**Purpose:** Default Audience for the `Unsorted` Publication. Members are
the staff users who triage incoming newsletter communications whose
publisher couldn't be matched to a known `Publication`. Membership is
managed via `Audience_Members` — populate before going live.

### Created — `dp_Publications` row (`Publication_ID = 11`)

```
Title                  : "Unsorted"
Name                   : "Unsorted"
Description            : "Catchall for PA-ingested Communications whose source
                         could not be matched to an existing Publication.
                         Triage by reassigning Publication_ID on the
                         Communication record to the correct Publication."
Moderator              : User_ID 147 (PowerAutomate User)
Available_Online       : 0
Targeted_Audience_ID   : <the Audience created above>
```

**Purpose:** Fallback Publication for the PA ingestion flow. When
`OscarHelpers - CPP - Newsletter Archive Intake` can't match an inbound
newsletter to a known Publication, it routes the communication here.
Visibility is gated by the Targeted Newsletter Audience so the catchall
isn't visible to general users.

Triage is just `UPDATE dp_Communications SET Publication_ID = <correct>
WHERE Communication_ID = <N>`. No SP rerun needed — the widget reads live
state.

The Pub's `Publication_ID = 11` value is referenced explicitly in
`api_Custom_GetMyNewsletterArchive` as the third tier of the featured-image
cascade (`@UnsortedPubID = 11`). If this ID differs in another tenant,
update both the seed migration and the SP body.

---

## Stored procedures

Two SPs live in `StoredProc/`. Both are registered in `dp_API_Procedures`
and granted to roles via `dp_Role_API_Procedures`.

### `api_Custom_CreatePublicationArchive`

PA-callable ingestion target. Creates a `dp_Communications` row under a
target `Publication`, classified as `Communication_Type_ID = 5`
(`Newsletter_Archive`). Returns the new `Communication_ID` to the PA flow.

Called by `OscarHelpers - CPP - Newsletter Archive Intake` v17 in
production.

### `api_Custom_GetMyNewsletterArchive`

Widget-callable cascade reader. Returns the authenticated user's accessible
Newsletter Archive entries, ordered by `Sent_Date DESC`, with the 4-tier
`dp_Files` image cascade applied per row.

**Migration history** (visible in the comment block at the top of
`StoredProc/api_Custom_GetMyNewsletterArchive.sql`):

| Schema/ file | What changed |
|---|---|
| (initial create) | Visibility cascade only — no featured image yet |
| 04 | Added `Featured_Image_URL` (single-tier: Communication only) |
| 07 | Expanded to 4-tier cascade: Communication → Publication → Unsorted (Pub 11) → Domain |
| 08 | Added `CASE WHEN Use_First_Body_Image_For_Featured = 1 THEN NULL ELSE …` branch |
| 09 | Added `Publication_Default_Image_URL` result column — Tier-2 lookup only (the Pub's own attached image), no per-Pub opt-out and no Unsorted/Domain fallback. Powers the widget sidebar's square Pub-identity avatar; widget falls back to a first-letter avatar when the column is NULL |

Current canonical state lives in `StoredProc/api_Custom_GetMyNewsletterArchive.sql`.
The `Schema/0[4|7|8|9]-*.sql` files are migration steps — they exist for
ordered redeployment to a fresh environment. Once applied, the SP body
matches the StoredProc/ file. For a fresh tenant deploy, you can skip
the historical migration alters (04 / 07 / 08 / 09) entirely by running
the canonical SP file — it already reflects post-09 state.

---

## API surface registration *(Schema/05)*

Both SPs are registered with MP's REST gate:

```sql
INSERT INTO dbo.dp_API_Procedures (Procedure_Name, Description) VALUES
    ('api_Custom_CreatePublicationArchive', '...'),
    ('api_Custom_GetMyNewsletterArchive',   '...');
```

And granted to roles via `dp_Role_API_Procedures`:

| SP | Roles granted |
|---|---|
| `api_Custom_CreatePublicationArchive` | Administrators (initial — refine to a PA-specific role if needed) |
| `api_Custom_GetMyNewsletterArchive` | Administrators (for testing) + the broader Member role used for engagement-tracking widgets |

`api_Custom_GetMyNewsletterArchive` must be reachable by every
authenticated MP user who is allowed to view the archive page — typically
the Member role.

The two-table registration pattern (`dp_API_Procedures` for the SP itself
+ `dp_Role_API_Procedures` for per-role grants) is MP's standard custom-SP
auth surface. See `[[CPP RunBook/3-Resources/ministry-platform-help/
curated-use/]]` for the canonical pattern.

---

## Required MP UI registration (not in SQL)

Two configuration touches happen in the MP UI, not via SQL:

1. **Pages → `dp_Files` page → set `Image_Column = "Image_Width"`** (or
   equivalent visibility on the Page record) so MP recognizes the column
   for serving images. CPP MP at ArchO has this configured baseline.

2. **`dp_Pages` rows** for `dp_Communications`, `dp_Publications`, and
   `dp_Domains` are pre-existing in MP baseline. The 4-tier image cascade
   SP joins to these via `Page_ID` on `dp_Files`. No edits needed —
   listed here for completeness because the SP references them.

---

## Verification queries

After applying all migrations, run these to confirm production state:

```sql
-- Targeted_Audience_ID column exists on dp_Publications
SELECT * FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'dp_Publications' AND COLUMN_NAME = 'Targeted_Audience_ID';

-- Use_First_Body_Image_For_Featured column exists on dp_Publications
SELECT * FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'dp_Publications' AND COLUMN_NAME = 'Use_First_Body_Image_For_Featured';

-- Audience + Unsorted Pub + Newsletter_Archive Communication_Type all present
SELECT 'Communication_Type' AS Lookup, Communication_Type_ID AS ID, Communication_Type AS Name
FROM dbo.dp_Communication_Types WHERE Communication_Type = 'Newsletter_Archive'
UNION ALL
SELECT 'Audience', Audience_ID, Audience_Name FROM dbo.Audiences
WHERE Audience_Name = 'Targeted Newsletter Audience' AND Domain_ID = 1
UNION ALL
SELECT 'Publication', Publication_ID, Title FROM dbo.dp_Publications
WHERE Name = 'Unsorted' AND Domain_ID = 1;

-- Both SPs are registered + role-granted
SELECT p.Procedure_Name, rp.Role_ID
FROM dbo.dp_API_Procedures p
LEFT JOIN dbo.dp_Role_API_Procedures rp ON rp.API_Procedure_ID = p.API_Procedure_ID
WHERE p.Procedure_Name IN ('api_Custom_CreatePublicationArchive','api_Custom_GetMyNewsletterArchive');

-- Brother's Keeper has the body-image opt-in flag
SELECT Publication_ID, Title, Use_First_Body_Image_For_Featured
FROM dbo.dp_Publications WHERE Publication_ID = 14;

-- Migration 09: SP returns Publication_Default_Image_URL in its result set.
-- Run the SP as any authenticated user and confirm the column appears.
-- (Substitute @Username for any valid dp_Users.User_Name in your tenant.)
EXEC dbo.api_Custom_GetMyNewsletterArchive
    @DomainID    = 1,
    @Username    = 'John.Norman',
    @Max_Results = 1;
-- Expected columns include: Communication_ID, Subject, Body, Sent_Date,
-- From_Contact, From_Display_Name, From_Email, Publication_ID,
-- Publication_Title, Publication_Description, Available_Online,
-- Congregation_ID, Targeted_Audience_ID, Visibility_Tier,
-- Featured_Image_URL, AND Publication_Default_Image_URL.

-- How many Publications currently have a default-image attached
-- (i.e., will show an image avatar in the widget sidebar rather than a
-- first-letter monogram)?
SELECT p.Publication_ID, p.Title,
       (SELECT COUNT(*) FROM dbo.dp_Files f
        INNER JOIN dbo.dp_Pages pg ON pg.Page_ID = f.Page_ID
        WHERE pg.Table_Name = 'dp_Publications'
          AND f.Record_ID = p.Publication_ID
          AND f.Image_Width IS NOT NULL
          AND COALESCE(f.Publicly_Accessible, 1) = 1
          AND f.Domain_ID = p.Domain_ID) AS Attached_Image_Count
FROM dbo.dp_Publications p
WHERE p.Domain_ID = 1
ORDER BY Attached_Image_Count DESC, p.Title;
```

`Schema/06-smoke-test.sql` runs an expanded version of these checks.

---

## Sandbox → Production deployment order

For redeploying to a fresh MP tenant, run migrations in numeric order:

1. `01-add-targeted-audience-column.sql` — column add (`Targeted_Audience_ID`)
2. `02-seed-lookup-data.sql` — Audience + Unsorted Pub
3. (Run the StoredProc/ files at this point — they create the SPs in their
   current canonical state, which is post-09. Migrations 03/04/07/09 are
   historical SP alters; in a fresh deploy you skip them by running the
   final SP file directly.)
4. `05-register-procedures.sql` — register + role-grant
5. `06-smoke-test.sql` — verify
6. `08-add-pub-use-body-image-flag.sql` — column add (`Use_First_Body_Image_For_Featured`)
   + opt-in flag set + SP alter to honor the flag. Required even on
   fresh deploy because it ADDS a column; the canonical SP file
   references it via `COALESCE(p.Use_First_Body_Image_For_Featured, 0)`.

For an incremental upgrade of an EXISTING deployment that pre-dates
migration 09, also run:

7. `09-alter-sp-add-publication-default-image-url.sql` — adds the
   `Publication_Default_Image_URL` column to the SP result set. The
   widget gracefully degrades without this (avatars show first-letter
   monograms), but applying it unlocks the per-Pub image avatars in the
   sidebar.

For audit / rollback, each migration's idempotency check means a re-run
just confirms state without making changes.

### Attaching Publication default images (optional, MP UI)

After migration 09 is applied, no image avatars will actually display in
the sidebar until Publications have `dp_Files` rows attached. For each
Publication that should display a custom image:

1. In MP, open the **Publications** page record.
2. Use the file-attachment UI to upload an image (recommended size:
   1200×648 retina or 800×433 standard, landscape, `.jpg` or `.png`).
3. Set `Default_Image = 1` on the new `dp_Files` row (MP's attach UI
   typically prompts for this).
4. Verify with the "Publications currently with a default-image attached"
   query in the *Verification queries* section above.

Publications without an attached default image will continue to show a
first-letter monogram avatar — no error, just less visual identity.

---

## Sandbox tenant notes

`mpsandbox.archomaha.org` should be kept identical to production for these
custom additions. The sandbox does **not** duplicate `dp_Files` images
from production (different `Unique_Name` GUIDs), so when testing the
image cascade in sandbox you'll need to attach test images to a
Publication and/or Domain locally.

Fr. Norman has direct SSMS access to the sandbox MP database via the
`mpsandbox.archomaha.org` server name (over VPN). DDL operations and
inserts into `dp_API_Procedures` / `dp_Role_API_Procedures` typically
require SSMS rather than the read-only MCP user.
