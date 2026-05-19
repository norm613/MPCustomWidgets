# NewsletterArchive

Authenticated-only archive of past publications (bulletins, newsletters, meeting
notes, etc.) for a logged-in MP user. Each archived item is rendered as a
clickable entry that expands to show the full HTML body inline. Images open in
a lightbox with keyboard navigation. A sticky, collapsible left sidebar
(titled **Newsletters** in the UI) lists the publications in the result set
with a per-Pub avatar, lets the user filter and reorder them, and exposes a
"Collapse all messages" footer button. Two orthogonal toolbar toggles control
grouping and display density.

> **Terminology note.** The MP data model calls these records `Publications`,
> and that's the technical name used throughout the schema, the SP body,
> engagement event labels, and most of this document. The user-facing rail
> is titled **Newsletters** to match how parishioners think about the
> content (newsletter issues grouped by publication series).

## Visibility cascade

For each `Publications` row, who can see it on the archive page:

1. If `Targeted_Audience_ID` is **non-NULL** → visible to users in that
   Audience (via `Audience_Members`).
2. Else if `Congregation_ID` is **non-NULL** → visible to users whose
   Household is in that Congregation.
3. Else (both NULL) → visible to **all authenticated users**.

In addition, every Communication has an **`Omit_from_Archive`** flag.
When `Omit_from_Archive = 1` (or the column is NULL — defaults to FALSE),
the SP returns the row. When set to `1` the row is excluded regardless
of visibility cascade. This is the user-controlled "hide from archive"
flag, separate from MP's `Active` flag (which is auto-managed by MP's
email-send pipeline and unsuitable for archive gating — see Schema/11
header for the full rationale).

The widget is fully engagement-tracked — every page view, entry expand,
link click, image zoom, view-control change, sidebar filter / sort /
collapse action, and "Collapse all messages" click is recorded against
`api_Custom_LogClick` for downstream analysis. See the **Engagement
events** section near the bottom of this file for the full table.

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
│   ├── 08-add-pub-use-body-image-flag.sql                 — Use_First_Body_Image_For_Featured column + Pub 14 opt-in
│   ├── 09-alter-sp-add-publication-default-image-url.sql  — Publication_Default_Image_URL (superseded by 12)
│   ├── 10-add-pub-image-name-column.sql                   — dp_Publications.Image_Name (Font Awesome icon name, seeded from dp_Pages)
│   ├── 11-add-comm-omit-from-archive-column.sql           — dp_Communications.Omit_from_Archive BIT (replaces Active filter)
│   └── 12-alter-sp-icon-name-and-omit-from-archive.sql    — SP rewrite: drops Publication_Default_Image_URL, adds Publication_Icon_Name, filters Omit_from_Archive
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

Five user-controlled dimensions, each persisted to its own `localStorage`
key. All combinations compose freely — filter runs before grouping; the
manual sort order affects both the sidebar list and the By-Publication
group order; density only affects per-entry rendering; sidebar width is
purely visual.

| Control | Values | localStorage key | Default |
|---|---|---|---|
| **Publication filter** | per-Pub show/hide | `cna-hidden-pub-ids` (JSON array) | all shown |
| **Publication order** | drag-and-drop reorder | `cna-pub-sort-order` (JSON array of Pub IDs) | derived (newest-pub-first) |
| **Sidebar width** | expanded / collapsed (icon-only) | `cna-sidebar-collapsed` (`0`/`1`) | expanded |
| **Grouping** | Inbox / By Publication | `cna-grouping` | `inbox` |
| **Display density** | Compact / Expanded | `cna-view-mode` | `compact` |
| **Search (`noReGreps`)** | substring filter on Subject + Publication Title + plaintext body | (in-memory; not persisted) | empty |

**Newsletters sidebar (left rail)** lists every publication that appears
in the current SP result set. Each row is a clickable toggle that shows or
hides that publication's entries from the main listing. The row shows a
small square Pub-identity avatar, the publication title, and a count of
how many entries are currently in the dataset for that publication. The
row dims when hidden.

The avatar renders a **FontAwesome icon** from
`dp_Publications.Image_Name` (e.g. `fa-newspaper-o`, `fa-envelope-open`,
or any other FA icon name the operator sets on the Publication record in
MP). The widget emits both `fa` and `fas` classes so the same name
renders correctly on whichever FontAwesome version the host page has
loaded (Enfold ships FA by default on cppnebraska.org).

Each avatar is a 26×26 square with 4px rounded corners on a CPP-blue
background. When the Publication's `Image_Name` is NULL, the slot falls
back to a first-letter monogram on the same square. Both layers are
rendered in the same DOM slot — the letter is always present as the
base layer, with the FA `<i>` overlaying it when an icon name is
provided.

Per migration 10, every existing Publication is seeded with the same icon
value that `dp_Pages.Image_Name` holds for the dp_Publications row, so
all Pubs start with the platform-level default. Per-Pub customization
is a simple edit to the Publication record in MP UI.

A collapse button at the top of the sidebar shrinks the rail to a 56px
icon-only column (only the square avatars — image or first-letter
fallback — remain visible; labels and counts are hidden). At the bottom
of the rail,
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

**Sticky behavior.** On desktop the sidebar is `position: sticky` — pinned
to the top of the viewport with a height cap so it stays in view as you
scroll through entries. The publications list scrolls internally if the
list outgrows the viewport. This keeps the actions row and the **Collapse
all messages** footer button always visible at the bottom of the rail.
On mobile (< 800px) the sticky behavior is dropped and the sidebar
returns to inline flow at the top of the content area.

**Collapse all messages.** A dedicated footer button below the actions
row closes every currently-expanded entry in the main listing. Acts
directly on the DOM (no re-render) so scroll position is preserved. In
collapsed-rail mode the button shrinks to its icon (↥); in mobile pill-
row mode the button remains visible in the actions area.

**Search (`noReGreps`).** A search input sits above the toolbar. Typing
filters the loaded entries by case-insensitive substring match against:

1. `Subject`
2. `Publication_Title`
3. Plaintext-extracted body (HTML stripped, lazy-cached per row on first
   match attempt so re-typing doesn't re-parse huge bodies)

Debounced 300ms; Enter commits immediately; Escape clears. The Clear
(×) button on the right of the input wipes the term in one click.

While a search is active:
- The sidebar's per-Pub counts override to reflect **matches** in that
  Pub (not total entries), so the rail tells you where the matches live.
- The summary line reads "N matches for &lsquo;term&rsquo; in the loaded
  M newsletters."
- Pubs with zero matches still show in the sidebar (with count 0) so the
  user can clear the search and get back to the full list trivially.

**Phase 1 scope (current):** searches only the currently-loaded N entries
(N = `MAX_RESULTS` in the widget config, default 25). Phase 2 (future
follow-on) will add a "Search older archives" button that POSTs to the
SP with `@Search` populated, lifting search beyond the loaded window to
the full MP archive.

The search logic lives in a single `noReGreps` namespace at the top of
the widget JS, so it can be lifted into a shared module if/when other
widgets need the same primitive.

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

### Sidebar avatar (FontAwesome icon — independent of the cascade)

Separately from the per-row `Featured_Image_URL` cascade, the SP returns a
`Publication_Icon_Name` column on every row — the value of
`dp_Publications.Image_Name`, which holds a FontAwesome icon name per
Publication. The widget captures this once per Publication when deriving
the sidebar pubs list and renders a FA `<i>` tag inside the avatar slot.

This replaces the previous Tier-2 `dp_Files`-based avatar approach (the
`Publication_Default_Image_URL` column introduced in Schema/09). The
icon-based approach is simpler architecturally — operators set an icon
name on the Pub record in MP UI rather than uploading and attaching
image files — and works without dp_Files attachments.

Schema migrations:
- `Schema/10-add-pub-image-name-column.sql` — column add + seed from
  `dp_Pages.Image_Name`
- `Schema/12-alter-sp-icon-name-and-omit-from-archive.sql` — SP rewrite
  exposing `Publication_Icon_Name`

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
`sanitizeBodyForDisplay()`. Sanitization is per-row cached on the row object
(`_cnaSanitizedBody`) so the search index and the render path share the same
cleaned source.

What gets stripped:

1. **Outlook external-sender caution banner** ("You don't often get email
   from..." / "CAUTION: This email originated from outside..."). Detected
   by `textContent` pattern AND size constraint (< 600 chars, to avoid
   stripping a whole body that happens to mention the word "caution").
2. **1×1 / 2×2 tracker pixels** (SendGrid open-trackers, similar beacons).
3. **`<script>` and `<style>` blocks** — defensive (XSS prevention against
   any source) and cleans up the plaintext extraction used for preview text
   + `noReGreps` search.
4. **Mailchimp archive chrome** — only when the body's `<body>` element has
   `id="archivebody"` (Mailchimp's archive-view marker). Two specific
   removals:
   - **`<div id="awesomewrap">`** — the entire toolbar with "Campaign URL /
     Copy / Twitter / Subscribe / Past Issues / RSS / Translate" plus the
     full ~70-language translate list. ~13.5 KB on a typical campaign.
     Without this strip, the toolbar's text leaks into the compact-view
     preview ("Campaign URL Copy Twitter 0 tweets Subscribe Past Issues
     RSS Translate English العربية Afrikaans...") and into search indexing.
   - **"View this email in your browser"** wrapping block — removed by
     anchor-text match + nearest small ancestor (table row preferred).

Publication-branded headers + footers (church mastheads, copyright
notices, social-icon blocks, "Update preferences" / "Unsubscribe" links)
are **intentionally preserved** — those are the publisher's identity, not
platform chrome.

AxiosHQ-specific chrome is also left intact for the same reason.

Sanitization runs at **render time** on every row, so it applies
retroactively to historical rows (no data churn / no UPDATE pass needed)
and prospectively to every future arrival via the PA Converter flow.

Fails open: on parse error the original HTML is returned unchanged.

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
   files reflect current canonical production state (post-migration-09).
3. The `05-register-procedures.sql` migration handles `dp_API_Procedures`
   registration and `dp_Role_API_Procedures` grants — adjust the role IDs
   if your tenant differs.
4. Ensure a `Communication_Type` named `Newsletter_Archive` exists. (At
   ArchO this is `Communication_Type_ID = 5` in both environments.)
5. The `Publications` row titled `Unsorted` (Pub 11) is seeded by
   `02-seed-lookup-data.sql`; `api_Custom_CreatePublicationArchive`
   routes to it when no other publication matches.
6. **Set per-Publication icons via MP UI** (optional — every Pub starts
   seeded by migration 10 from `dp_Pages.Image_Name`). To override the
   default for any Publication, edit its `Image_Name` field in MP to a
   FontAwesome icon name (`fa-newspaper-o`, `fa-bullhorn`, etc.). Browse
   the [Font Awesome library](https://fontawesome.com/v5/search?m=free)
   for the catalog. NULL `Image_Name` falls back to a first-letter
   monogram avatar — no error, just less visual identity. See
   DATABASE.md for the icon-naming convention.

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
| `newsletter-collapse-all` | User clicks "Collapse all messages" (target = number of entries that were expanded at click time) |
| `newsletter-search` | User commits a `noReGreps` search (label = `filter` or `clear`; target = first 100 chars of the term) |

Each event records page URL, page title, target identifier, session ID,
user agent, and referrer.
