# NewsletterArchive

Authenticated-only archive of past publications (bulletins, newsletters, meeting
notes) for a logged-in user. Each archived item is rendered as a clickable
entry that expands to show the full HTML body inline. Images open in a
lightbox with keyboard navigation.

Audience visibility cascade — for each `Publication` row:

1. If `Targeted_Audience_ID` is **non-NULL** → visible to users in that
   Audience (via `Audience_Members`).
2. Else if `Congregation_ID` is **non-NULL** → visible to users whose
   Household is in that Congregation.
3. Else (both NULL) → visible to **all authenticated users**.

The widget is engagement-tracked: page-view, expand-to-read, image-zoom, and
link-click events are recorded against `api_Custom_LogClick` for downstream
analysis.

## Files

```
Widgets/NewsletterArchive/
├── README.md                                       — this file
├── Schema/
│   └── 01-add-targeted-audience-column.sql         — adds dp_Publications.Targeted_Audience_ID
├── StoredProc/
│   ├── api_Custom_CreatePublicationArchive.sql     — PA-callable ingestion target
│   └── api_Custom_GetMyNewsletterArchive.sql       — widget-callable cascade reader
└── Template/
    ├── cpp-newsletter-archive.js                   — widget JS
    └── cpp-newsletter-archive.css                  — widget styling
```

## Backend setup

1. Run `Schema/01-add-targeted-audience-column.sql` once per environment
   (sandbox and prod). Adds the custom `Targeted_Audience_ID` FK column to
   `dp_Publications`.
2. Run both files in `StoredProc/` to create the two SPs.
3. Register each SP in `dp_API_Procedures` and grant role-level access via
   `dp_Role_API_Procedures` (typically the Administrators role plus the
   member-facing role you intend to expose this widget to).
4. Ensure a `Communication_Type` named `Newsletter_Archive` exists. (At
   ArchO this is `Communication_Type_ID = 5` in both environments.)
5. Create a fallback `Publications` row titled `Unsorted` for any
   archived communication that doesn't match a known publication. The
   `api_Custom_CreatePublicationArchive` SP routes to it when no match
   is found.

## Frontend setup

Drop this markup on the page (Avia codeblock, native WP block, etc.):

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

The `cpp-newsletter-archive.js` script must load **before** `forceLogin.js` so
that `window.MPCustomWidgetsConfig.mpHost` is set when forceLogin evaluates.

## Per-deployment configuration

Edit the top of `Template/cpp-newsletter-archive.js`:

```js
window.MPCustomWidgetsConfig = { mpHost: 'mp.your-tenant.org' };

var API_HOST = 'your-tenant.cloudapps.ministryplatform.cloud';
```

ArchO production uses `mp.archomaha.org` + `archomaha.cloudapps.ministryplatform.cloud`.
ArchO sandbox uses `mpsandbox.archomaha.org` + `<tenant>sandbox.cloudapps.ministryplatform.cloud`
— note that prod is consolidated at the archdiocesan level, whereas sandbox
follows a per-tenant naming convention.

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

Each event records page URL, page title, target identifier, session ID,
user agent, and referrer.
