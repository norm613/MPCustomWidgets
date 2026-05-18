# NewsletterArchive

Authenticated-only archive of past publications (bulletins, newsletters, meeting
notes, etc.) for a logged-in MP user. Each archived item is rendered as a
clickable entry that expands to show the full HTML body inline. Images open in
a lightbox with keyboard navigation. A collapsible left sidebar lists the
publications in the result set and lets the user filter which ones are
visible; two orthogonal toolbar toggles control grouping and display density.

## Visibility cascade

For each `Publications` row, who can see it on the archive page:

1. If `Targeted_Audience_ID` is **non-NULL** → visible to users in that
   Audience (via `Audience_Members`).
2. Else if `Congregation_ID` is **non-NULL** → visible to users whose
   Household is in that Congregation.
3. Else (both NULL) → visible to **all authenticated users**.

The widget is engagement-tracked: page-view, expand-to-read, image-zoom, link
click, view-mode change, and grouping change events are recorded against
`api_Custom_LogClick` for downstream analysis.

## Files

```
Widgets/NewsletterArchive/
├── README.md                                              — this file
├── DATABASE.md                                            — production MP schema changes
├── Schema/
│   ├── 01-add-targeted-audience-column.sql                — dp_Publications.Targeted_Audience_ID column
│   ├── 02-seed-lookup-data.sql                            — Audience + Unsorted Pub 11 + ID anchors
│   ├── 05-register-procedures.sql                         — dp_API_Procedures + dp_Role_API_Procedures grants
│   ├── 06-smoke-test.sql                                  — cross-tenant verification queries
│   ├── 07-alter-sp-GetMyNewsletterArchive-image-cascade.sql — 4-tier dp_Files cascade
│   └── 08-add-pub-use-body-image-flag.sql                 — Use_First_Body_Image_For_Featured column + Pub 14 opt-in
├── StoredProc/
│   ├── api_Custom_CreatePublicationArchive.sql            — PA-callable ingestion target
│   └── api_Custom_GetMyNewsletterArchive.sql              — widget-callable cascade reader (current canonical state)
└── Template/
    ├── cpp-newsletter-archive.js                          — widget JS
    └── cpp-newsletter-archive.css                         — widget styling
```

See **DATABASE.md** for the ordered list of changes to production MP and what
each migration does.

## View options

Three independent dimensions, each persisted to `localStorage`. The four
combinations of grouping × density combine with the publication filter so
the user can land on any of `2 × 2 × 2^N` view states (where N is the
number of publications in the result set).

| Control | Values | localStorage key | Default |
|---|---|---|---|
| **Publication filter** | per-Pub show/hide | `cna-hidden-pub-ids` (JSON array) | all shown |
| **Publication order** | drag-and-drop reorder | `cna-pub-sort-order` (JSON array of Pub IDs) | derived (newest-pub-first) |
| **Sidebar width** | expanded / collapsed (icon-only) | `cna-sidebar-collapsed` (`0`/`1`) | expanded |
| **Grouping** | Inbox / By Publication | `cna-grouping` | `inbox` |
| **Display density** | Compact / Expanded | `cna-view-mode` | `compact` |

**Publications sidebar (left rail)** lists every publication that appears
in the current SP result set. Each row is a clickable toggle that shows or
hides that publication's entries from the main listing. The row shows a
first-letter avatar, the publication title, and a count of how many entries
are currently in the dataset for that publication. The avatar tints gray
and the row dims when hidden.

A collapse button at the top of the sidebar shrinks the rail to a 56px
icon-only column (first-letter avatars only). At the bottom of the rail,
"Show all" clears the hidden set, and "Hide all" marks every currently-known
publication hidden — the second is useful for "filter to a single Pub" (hide
all, then click one). The filter runs before grouping, so all combinations
compose cleanly.

The hidden set tracks only what's been explicitly hidden, so any new
Publication that appears in the result set later is visible by default.

**Drag-to-reorder.** Each sidebar item is draggable (native HTML5 DnD —
desktop instantly; iOS/Android via long-press). Drop another publication
before or after a target to set a manual sort order. The order persists
in `cna-pub-sort-order` and drives both the sidebar list and the
By Publication group section order.

The order is a SOFT override: pubs you've reordered come first, in that
order; pubs not yet in the manual array follow in their original derived
order (so new publications appearing in a later SP result set append
automatically). A "Reset order" button appears in the sidebar footer
once a manual order exists; clicking it removes the override.

Drop-indicator visuals adapt to layout: a colored bar on the top/bottom
edge in desktop sidebar mode, on the leading/trailing edge in mobile
horizontal-pill mode.

On screens narrower than 800px the sidebar reflows to a horizontal
scrolling pill row above the toolbar — no off-canvas drawer.

**Inbox** is a flat list ordered by `Sent_Date DESC` (whatever the SP returns
top-down).

**By Publication** groups entries under section headings keyed on
`Publication_ID`, with each group's entries date-sorted within. Group order
is newest-first by each group's most recent entry (a consequence of the SP's
overall date-desc ordering). Publications hidden via the sidebar do not
appear as groups in this mode.

**Compact** shows a one-line entry per row (subject + publication + date).

**Expanded** adds a 148×80 thumbnail (96×52 on mobile) and a two-line text
preview drawn from the email body. Both dimensions follow MP's canonical
widget image ratio of **59:32** — see *Featured-image cascade* below.

## Featured-image cascade

Each rendered entry shows a featured image. Selection has two phases —
server-side (the SP) then client-side (the JS fallback).

### Server-side: 4-tier `dp_Files` cascade

`api_Custom_GetMyNewsletterArchive` looks for an image in this order and
returns the first match as `Featured_Image_URL`:

| Tier | Record type | Page lookup | Use case |
|---|---|---|---|
| 1 | `dp_Communications.Communication_ID` | `dp_Pages WHERE Table_Name = 'dp_Communications'` | Per-issue: one-off newsletter gets its own image |
| 2 | `dp_Publications.Publication_ID` | `dp_Pages WHERE Table_Name = 'dp_Publications'` | Per-series: e.g., CPP Weekly Bulletin uses a consistent header thumb |
| 3 | `dp_Publications` for **`Publication_ID = 11` (Unsorted)** | same as tier 2 | Tenant default for unrouted communications |
| 4 | `dp_Domains.Domain_ID` | `dp_Pages WHERE Table_Name = 'dp_Domains'` | Institutional fallback (archdiocesan logo / crest) |

Each tier filters `dp_Files` to rows where `Image_Width IS NOT NULL`
(rules out non-image attachments), `COALESCE(Publicly_Accessible, 1) = 1`
(MP semantics: NULL = public-by-default, the column EXCLUDES rather than
includes), and `Domain_ID = @DomainID`. Ordering within each tier:
`Default_Image DESC, UTC_Date_Added DESC`.

Returned URL pattern:
`https://mp.archomaha.org/ministryplatformapi/files/<Unique_Name>` —
note the `api` suffix on the path.

### Client-side: 3-tier body extraction (fallback)

When the SP returns no `Featured_Image_URL` (no `dp_Files` matched any
tier), the widget JS scans the email body for an inline `<img>`:

| Tier | Match | Notes |
|---|---|---|
| A | `src` query contains `axImg=1` | AxiosHQ tags every content image with this marker — bypasses brand/social chrome |
| B | `width` attribute ≥ 300 (largest wins) | Substantial content image, not a logo |
| C | First non-tiny `<img>` | Last-resort fallback |

All tiers skip tracker pixels (< 50×50), `data:` URIs, `javascript:`/
`mailto:` refs.

If neither phase yields anything, the slot renders a dashed placeholder.

### Per-Publication opt-out

When a Publication's content is best represented by its per-issue body image
rather than any `dp_Files` attachment (e.g., AxiosHQ-curated newsletters
where the first content image IS the hero), set:

```sql
UPDATE dbo.dp_Publications
SET Use_First_Body_Image_For_Featured = 1
WHERE Publication_ID = <N>;
```

The SP returns `NULL` for `Featured_Image_URL` on rows from that Pub,
causing the JS body-extraction (3-tier) to take over. Currently opt-in:
Brother's Keeper (Pub 14, AxiosHQ-hosted).

For the general pattern of adding new per-Pub flags, see the **Feature
flags** section below.

## Feature flags

Per-Publication customizations are expressed as `BIT` columns on
`dp_Publications` and honored by SP logic via `CASE WHEN COALESCE(p.flag,
0) = 1 THEN <override> ELSE <default> END`. This keeps the toggle exactly
where Admins look (MP's Publications page), survives MP upgrades, and is
auditable in SQL.

**Naming:** `Use_<X>_For_<Y>` or `<X>_Override`. Descriptive enough that
the SP body can be read without consulting a separate spec.

**Adding a new flag:**

1. Identify the behavior that varies by Publication. Phrase it as "when
   flag = 1, do X; otherwise default."
2. Add the column to `dp_Publications` (idempotent — guard with
   `INFORMATION_SCHEMA.COLUMNS` check).
3. Set the flag for opt-in Publications.
4. Modify the relevant SP with the `CASE WHEN` branch.
5. Document in the SP body comment and in this README.

Established flags (as of `eebb0b4`):

| Flag column | Behavior when = 1 | Opt-in Pubs |
|---|---|---|
| `Use_First_Body_Image_For_Featured` | SP returns `NULL` for `Featured_Image_URL` → widget JS body-extracts first non-tiny `<img>` | 14 (Brother's Keeper) |

## Body sanitization

Before render and image extraction, each entry's body HTML is passed through
`sanitizeBodyForDisplay()`. It strips two universal email-chrome elements:

1. **Outlook external-sender caution banner** ("You don't often get email
   from..." / "CAUTION: This email originated from outside..."). Detected
   by `textContent` pattern AND size constraint (< 600 chars, to avoid
   stripping a whole body that happens to mention the word "caution").
2. **1×1 / 2×2 tracker pixels** (SendGrid open-trackers, similar beacons).

AxiosHQ-specific chrome (masthead/footer) is left intact to preserve
publication identity in expanded view.

Sanitization fails open — on parse error the original HTML is returned.

## Image dimensions (MP 59:32 standard)

Thumbnails follow MP's canonical widget image ratio used across
event-finder, opportunity-finder, group-finder, and mission-trip-finder
widgets.

| Spec | Value |
|---|---|
| Aspect ratio | **59 : 32** (≈ 1.844 : 1) |
| Desktop rendered size | 148 × 80 px |
| Mobile rendered size (< 600px) | 96 × 52 px |
| Recommended upload | 1200 × 648 (retina) or 800 × 433 (MP canonical) |
| Crop behavior | `object-fit: cover; object-position: center` |

The 59:32 ratio is compatible with Facebook OG (1.91:1) and LinkedIn share
(1.91:1) — the ~3% ratio difference is absorbed by center-crop, so one
source asset works for both the widget and social posts. Avoid square or
portrait uploads (heavy center-crop, often loses subject).

## Backend setup

1. Run migrations in `Schema/` in numeric order, once per environment
   (sandbox first, then prod when verified). Each migration is idempotent
   (guarded with `INFORMATION_SCHEMA.COLUMNS` or `EXISTS` checks).
2. Run both files in `StoredProc/` to create / replace the two SPs. The SP
   files reflect current canonical production state.
3. The `05-register-procedures.sql` migration handles `dp_API_Procedures`
   registration and `dp_Role_API_Procedures` grants — adjust the role IDs
   if your tenant differs.
4. Ensure a `Communication_Type` named `Newsletter_Archive` exists. (At
   ArchO this is `Communication_Type_ID = 5` in both environments.)
5. The `Publications` row titled `Unsorted` (Pub 11) is seeded by
   `02-seed-lookup-data.sql`; `api_Custom_CreatePublicationArchive`
   routes to it when no other publication matches.

See **DATABASE.md** for the full migration history and what each migration
changed in production.

## Frontend setup

### Option A — WordPress shortcode plugin (recommended)

The widget is deployed as a thin shortcode plugin
(`cpp-newsletter-archive`) that emits `<link>`, container `<div>`s, and
`<script>` tags directly. This bypasses both `wp_kses` (which strips
inline scripts on `update_post`) and Avia's `_aviaLayoutBuilderCleanData`
post-meta cache (which renders from its own sanitized copy of the
content, not `wp_posts.post_content`).

The plugin lives separately at `OneDrive\Attachments\cpp-engagement-phase3a\
cpp-newsletter-archive.php`. Place a single shortcode on the page:

```
[cpp_newsletter_archive commit="<short-sha>"]
```

The plugin sources both JS and CSS from jsDelivr at
`norm613/MPCustomWidgets@<commit>`. Bump the `commit` attribute on each
deploy.

### Option B — Direct embed

For non-WP deployments, drop this markup (the script-tag flavor that WP
can't reliably persist):

```html
<link rel="stylesheet" href="https://your-cdn/Template/cpp-newsletter-archive.css" />
<mpp-user-login></mpp-user-login>
<div class="cna">
  <p class="cna-subhead">Your accessible newsletter archive.</p>
  <div id="auth-status" class="pending"><strong>Loading&hellip;</strong> waiting for MP login.</div>
  <div id="cna-root" class="cna-loading">Loading your newsletters&hellip;</div>
</div>
<script src="https://your-cdn/Template/cpp-newsletter-archive.js"></script>
<script src="https://cdn.jsdelivr.net/gh/norm613/MPCustomWidgets@latest/dist/js/forceLogin.js"></script>
```

The `cpp-newsletter-archive.js` script must load **before** `forceLogin.js`
so that `window.MPCustomWidgetsConfig.mpHost` is set when forceLogin
evaluates.

## Per-deployment configuration

Edit the top of `Template/cpp-newsletter-archive.js`:

```js
window.MPCustomWidgetsConfig = { mpHost: 'mp.your-tenant.org' };

var API_HOST = 'your-tenant.cloudapps.ministryplatform.cloud';
```

ArchO production uses `mp.archomaha.org` +
`archomaha.cloudapps.ministryplatform.cloud`. ArchO sandbox uses
`mpsandbox.archomaha.org` +
`<tenant>sandbox.cloudapps.ministryplatform.cloud` — note that prod is
consolidated at the archdiocesan level, whereas sandbox follows a
per-tenant naming convention.

## Debug mode

Append `?debug=1` to the page URL to surface an on-screen diagnostic panel
that logs script entry, auth state, fetch URLs (auth tokens redacted),
fetch responses, and any unhandled errors. Useful on iOS where DevTools
aren't available by default.

## Stale-flag self-recovery

`forceLogin.js` treats `?mpCustomWidgetAuth=true` in the URL as "auth is
finalizing — wait." If a prior auth round left that flag in URL history
without a token landing (autocomplete on iOS, abandoned tab), forceLogin
will sit indefinitely. This widget detects that state 3 seconds after
`DOMContentLoaded` and self-recovers by stripping the flag and reloading.
A `sessionStorage` marker (`cna-stale-strip-attempted`) prevents reload
loops; if recovery has already been attempted in the current tab, the
widget falls back to surfacing a manual-login CTA instead.

## Engagement events

The widget fires these `api_Custom_LogClick` events:

| `Element_Type` | When |
|---|---|
| `newsletter-page-view` | Once per load, after first render |
| `newsletter-expand` | User opens an archived entry |
| `newsletter-link-click` | User clicks any link inside an expanded body |
| `newsletter-image-zoom` | User clicks an image (opens lightbox) |
| `newsletter-view-mode-change` | User toggles Compact ↔ Expanded |
| `newsletter-grouping-change` | User toggles Inbox ↔ By Publication |
| `newsletter-pub-filter` | User shows / hides a publication in the sidebar (label = `show` / `hide` / `show-all` / `hide-all`; target = Publication_ID for per-item events) |
| `newsletter-pub-sort` | User reorders the sidebar (label = `reorder`, target = `<srcId>-><tgtId>:before\|after`) or resets it (label = `reset`) |
| `newsletter-sidebar-collapse` | User toggles the sidebar to collapsed / expanded |

Each event records page URL, page title, target identifier, session ID,
user agent, and referrer.
