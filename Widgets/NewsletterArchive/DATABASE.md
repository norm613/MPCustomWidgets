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

### `dp_Publications.Image_Name` *(Schema/10)*

```sql
ALTER TABLE dbo.dp_Publications
    ADD Image_Name NVARCHAR(50) NULL;
-- Seed: existing Pubs get dp_Pages.Image_Name (for the dp_Publications page row),
-- falling back to 'fa-newspaper-o' if dp_Pages has none set.
```

**Purpose:** Mirrors the `Image_Name` column on `dp_Pages` — a FontAwesome
icon name (e.g., `fa-newspaper-o`, `fa-envelope-open`) per Publication.
Used by the Newsletter Archive widget as each Pub's sidebar avatar.
Replaces the prior dp_Files-based avatar approach (the Tier-2 lookup that
became `Publication_Default_Image_URL` in Schema/09 — superseded by
Schema/12).

Per-Pub override: edit the Publication record in MP UI. Default for new
Pubs: NULL (widget falls back to first-letter monogram).

### `dp_Communications.Omit_from_Archive` *(Schema/11)*

```sql
ALTER TABLE dbo.dp_Communications
    ADD Omit_from_Archive BIT NOT NULL
        CONSTRAINT DF_dp_Communications_Omit_from_Archive DEFAULT (0);
```

**Purpose:** User-controlled "hide this Communication from the Newsletter
Archive widget" flag. Defaults to `0` (show) for every Communication
including existing rows. Replaces the use of `Active` as the widget's
visibility gate.

**Why a new column instead of reusing Active:** MP's `Active` field
auto-flips `1 → 0` when a Communication finishes sending through MP's
email pipeline (it removes the row from the active send queue). That
behavior is correct for MP's send subsystem but wrong for the archive —
"sent in the past" is exactly what we want to display. `Omit_from_Archive`
gives us a separate, stable, user-controlled bit with a single semantic.

Established 2026-05-18 via audit-log investigation of Communication 2992,
which was created+sent in MP UI on 2026-05-18 and auto-deactivated by
the send pipeline 6 seconds after creation, hiding it from the archive
despite being a valid Newsletter_Archive entry.

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
| 09 | Added `Publication_Default_Image_URL` result column — Tier-2 lookup only. Used by sidebar avatar. *Superseded by 12.* |
| 12 | Combined update: (a) dropped `Publication_Default_Image_URL`, replaced with `Publication_Icon_Name` reading from `p.Image_Name` (FA icon, no dp_Files lookup); (b) replaced filter `c.Active = 1` with `COALESCE(c.Omit_from_Archive, 0) = 0`. Per-row `Featured_Image_URL` cascade unchanged. |

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

-- Migration 10: Image_Name column added; every existing Pub seeded
SELECT * FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'dp_Publications' AND COLUMN_NAME = 'Image_Name';
SELECT Publication_ID, Title, Image_Name FROM dbo.dp_Publications
WHERE Domain_ID = 1 ORDER BY Publication_ID;

-- Migration 11: Omit_from_Archive column added with NOT NULL DEFAULT 0
SELECT * FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'dp_Communications' AND COLUMN_NAME = 'Omit_from_Archive';

-- Migration 12: SP returns Publication_Icon_Name and filters Omit_from_Archive
-- (replace @Username with any valid dp_Users.User_Name in your tenant).
EXEC dbo.api_Custom_GetMyNewsletterArchive
    @DomainID    = 1,
    @Username    = 'John.Norman',
    @Max_Results = 1;
-- Expected columns include Publication_Icon_Name (no longer
-- Publication_Default_Image_URL).

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
migration 12, also run (in order):

7. `09-alter-sp-add-publication-default-image-url.sql` — historical, only
   needed if you want to rebuild the pre-12 SP. Superseded by 12.
8. `10-add-pub-image-name-column.sql` — adds `Image_Name` to
   `dp_Publications` and seeds every existing Pub from
   `dp_Pages.Image_Name`. After this runs the column exists but the
   SP doesn't return it yet — that's what 12 wires up.
9. `11-add-comm-omit-from-archive-column.sql` — adds `Omit_from_Archive`
   to `dp_Communications` with NOT NULL DEFAULT 0. Existing rows get 0
   automatically; the widget will start showing every sent newsletter
   regardless of `Active` flag once 12 is applied.
10. `12-alter-sp-icon-name-and-omit-from-archive.sql` — SP rewrite. Drops
    `Publication_Default_Image_URL` from the result set, adds
    `Publication_Icon_Name = p.Image_Name`, replaces the WHERE filter
    `c.Active = 1` with `COALESCE(c.Omit_from_Archive, 0) = 0`. Widget
    avatar rendering changes from `<img>` overlay to FontAwesome `<i>`
    overlay; the SP filter no longer excludes UI-composed-and-sent
    Communications.

For audit / rollback, each migration's idempotency check means a re-run
just confirms state without making changes.

### Setting per-Publication icons (optional, MP UI)

After migration 10, every existing Publication is seeded with the same
FontAwesome icon name pulled from `dp_Pages.Image_Name`. To customize an
individual Publication's icon:

1. In MP, open the **Publications** page and select the record.
2. Edit the `Image_Name` field. Browse [Font Awesome](https://fontawesome.com/v5/search?m=free)
   for available icons; common picks for newsletters:
   - `fa-newspaper-o` (FA 4) / `fa-newspaper` (FA 5+) — default seed
   - `fa-envelope-open` / `fa-envelope-open-text`
   - `fa-rss` / `fa-rss-square`
   - `fa-bullhorn` (announcements)
   - `fa-book-open` (publications / journals)
3. Save. The widget picks up the new icon on the next page load — no
   cache flush needed since the SP reads `dp_Publications.Image_Name`
   live on every request.

Publications with NULL `Image_Name` will show a first-letter monogram
avatar — no error, just less visual identity.

### Hiding individual Communications from the archive (optional, MP UI)

After migration 11, every Communication has an `Omit_from_Archive` BIT
defaulting to 0 (show). To hide a specific newsletter:

1. In MP, open the Communication record.
2. Set `Omit_from_Archive = 1` and save.

The widget will exclude that row on its next load. To restore: flip the
flag back to 0.

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
