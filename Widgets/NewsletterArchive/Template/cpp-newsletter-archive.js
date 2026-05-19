/* ============================================================
 * cpp-newsletter-archive.js
 * v0 widget JS for the My Newsletters page on cppnebraska.org.
 * Loaded by Avia page at /my-newsletters/ via <script src>.
 *
 * Source: OneDrive\Attachments\mp-engagement-newsletter-archive-widget\
 * Deployed to: wp-content/uploads/cpp/cpp-newsletter-archive.js
 *
 * Must be loaded BEFORE forceLogin.js so MPCustomWidgetsConfig is set.
 *
 * Engagement-tracking events fired via api_Custom_LogClick:
 *   - 'newsletter-page-view'     (once per load, after first render)
 *   - 'newsletter-expand'        (each time user opens an archived entry)
 *   - 'newsletter-link-click'    (each <a> click inside an expanded body)
 *
 * Debug mode: append ?debug=1 to the URL to surface an on-screen
 * diagnostic panel (auth state, storage probes, fetch URL/response,
 * window errors). Designed for iOS Safari where DevTools aren't
 * available by default.
 * ============================================================ */

window.MPCustomWidgetsConfig = { mpHost: 'mp.archomaha.org' };

(function() {
    var API_HOST = 'archomaha.cloudapps.ministryplatform.cloud';
    var API_PATH = '/sky/api/CustomWidget';
    var SP_NAME = 'api_Custom_GetMyNewsletterArchive';
    var LOG_SP_NAME = 'api_Custom_LogClick';
    var DOMAIN_ID = 1;
    var MAX_RESULTS = 25;

    // --- Debug instrumentation -----------------------------------------
    // Enable on-screen diagnostic panel by appending ?debug=1 to the URL.
    // iOS Safari has no DevTools by default; this panel surfaces auth /
    // storage / fetch state directly on the page.
    var DEBUG = /[?&]debug(=|&|$)/.test(window.location.search || '');
    var _dbgPanel = null;

    function dbg(label, data) {
        if (!DEBUG) return;
        if (!_dbgPanel) _initDebugPanel();
        if (!_dbgPanel) return; // body not ready yet — drop the log
        var t = new Date().toISOString().substring(11, 23);
        var payload = '';
        try {
            if (data !== undefined) {
                payload = (typeof data === 'string') ? data : JSON.stringify(data, null, 2);
            }
        } catch (e) {
            payload = '[stringify failed: ' + String(e) + ']';
        }
        _dbgPanel.textContent += '[' + t + '] ' + label + (payload ? '\n  ' + payload.replace(/\n/g, '\n  ') : '') + '\n';
        _dbgPanel.scrollTop = _dbgPanel.scrollHeight;
    }

    function _initDebugPanel() {
        var parent = document.body || document.documentElement;
        if (!parent) return;
        _dbgPanel = document.createElement('pre');
        _dbgPanel.id = 'cna-debug';
        _dbgPanel.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:45vh;overflow:auto;background:#000;color:#0f0;font:11px/1.3 ui-monospace,Menlo,Consolas,monospace;z-index:99999;padding:8px 8px 40px 8px;margin:0;white-space:pre-wrap;word-break:break-all;border-top:2px solid #0f0;-webkit-user-select:text;user-select:text;';
        parent.appendChild(_dbgPanel);
        var closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close debug';
        closeBtn.setAttribute('aria-label', 'Close debug panel');
        closeBtn.style.cssText = 'position:fixed;bottom:6px;right:8px;z-index:100000;background:#c00;color:#fff;border:none;font:bold 12px sans-serif;padding:6px 10px;cursor:pointer;border-radius:4px;';
        closeBtn.addEventListener('click', function() {
            if (_dbgPanel) _dbgPanel.remove();
            closeBtn.remove();
            _dbgPanel = null;
        });
        parent.appendChild(closeBtn);
    }

    function safeLs(key) {
        try {
            return { ok: true, value: localStorage.getItem(key) };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }

    function dumpStorage() {
        var out = { localStorage: {}, sessionStorage: {}, cookies: '', error: null };
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                var v = localStorage.getItem(k);
                out.localStorage[k] = (v === null) ? null
                    : (v.length > 80 ? v.substring(0, 40) + '…(' + v.length + ' chars)…' + v.substring(v.length - 8) : v);
            }
        } catch (e) { out.error = 'localStorage: ' + String(e); }
        try {
            for (var j = 0; j < sessionStorage.length; j++) {
                var sk = sessionStorage.key(j);
                var sv = sessionStorage.getItem(sk);
                out.sessionStorage[sk] = (sv === null) ? null
                    : (sv.length > 80 ? sv.substring(0, 40) + '…(' + sv.length + ' chars)' : sv);
            }
        } catch (e) { out.error = (out.error ? out.error + '; ' : '') + 'sessionStorage: ' + String(e); }
        try {
            out.cookies = document.cookie ? document.cookie.substring(0, 500) : '(empty)';
        } catch (e) { out.cookies = '[error: ' + String(e) + ']'; }
        return out;
    }

    function customElementInfo(name) {
        try {
            var ctor = customElements.get(name);
            return { registered: !!ctor, ctorName: ctor ? (ctor.name || '?') : null };
        } catch (e) {
            return { error: String(e) };
        }
    }

    // --- Stale-flag self-recovery --------------------------------------
    // forceLogin's decision tree treats `?mpCustomWidgetAuth=true` in the URL
    // as "auth is finalizing — wait." If a prior auth round left the flag in
    // the URL but no token ever landed (e.g. URL history autocomplete on
    // iOS, abandoned tab), forceLogin sits forever and the page hangs at
    // "waiting for MP login." This helper detects that state 3s after
    // DOMContentLoaded and self-recovers by stripping the flag and reloading
    // — on the next load forceLogin sees no flag, no token, and redirects
    // to SSO fresh. Guarded with a sessionStorage marker so we never
    // recover more than once per browser tab.
    function stripMpCustomWidgetAuthFromSearch(search) {
        try {
            var p = new URLSearchParams(search);
            p.delete('mpCustomWidgetAuth');
            var s = p.toString();
            return s ? '?' + s : '';
        } catch (e) {
            return search
                .replace(/(\?|&)mpCustomWidgetAuth=true/, function(m, p1) { return p1 === '?' ? '?' : ''; })
                .replace(/^\?$/, '')
                .replace(/^\?&/, '?')
                .replace(/&$/, '');
        }
    }

    function attemptStaleFlagRecovery() {
        try {
            if (!/[?&]mpCustomWidgetAuth=true/.test(window.location.search || '')) return;
            var ls = safeLs('mpp-widgets_AuthToken');
            if (ls.ok && ls.value) {
                dbg('stale-flag check: token already present, no recovery needed');
                return;
            }
            var alreadyAttempted = false;
            try {
                alreadyAttempted = !!sessionStorage.getItem('cna-stale-strip-attempted');
            } catch (e) { /* storage blocked — treat as not-attempted */ }
            if (alreadyAttempted) {
                dbg('!! stale-flag recovery ALREADY attempted this tab — surfacing manual-login fallback');
                setAuthStatus('failure', '<strong>Sign-in didn\'t complete.</strong> Please use the <strong>Login</strong> link above to sign in manually.');
                return;
            }
            try {
                sessionStorage.setItem('cna-stale-strip-attempted', '1');
            } catch (e) { /* storage blocked — proceed anyway, worst case we loop once */ }
            dbg('STALE-FLAG RECOVERY: stripping mpCustomWidgetAuth=true and reloading', { from: window.location.search });
            var newSearch = stripMpCustomWidgetAuthFromSearch(window.location.search);
            var newUrl = window.location.pathname + newSearch + window.location.hash;
            history.replaceState(null, '', newUrl);
            window.location.reload();
        } catch (e) {
            dbg('!! stale-flag recovery error', { error: String(e) });
        }
    }

    function tokenInfo(token) {
        if (!token) return null;
        var s = String(token);
        return {
            length: s.length,
            first8: s.substring(0, 8),
            last4: s.length > 4 ? s.substring(s.length - 4) : s
        };
    }

    if (DEBUG) {
        window.addEventListener('error', function(e) {
            dbg('!! window.onerror', { message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno });
        });
        window.addEventListener('unhandledrejection', function(e) {
            dbg('!! unhandledrejection', { reason: e && e.reason ? String(e.reason) : '?' });
        });
        // Catch any postMessage traffic — MP's auth flow may use postMessage
        // from a hidden iframe; iOS Safari ITP can drop these silently.
        window.addEventListener('message', function(e) {
            var d = e.data;
            var dPreview = '';
            try {
                dPreview = (typeof d === 'string') ? d.substring(0, 200) : JSON.stringify(d).substring(0, 200);
            } catch (err) { dPreview = '[unserializable]'; }
            dbg('window.message received', { origin: e.origin, source: e.source ? '(window)' : null, dataPreview: dPreview });
        });
        // SCRIPT_ENTRY fires immediately even if body isn't ready (panel
        // init falls through, log is dropped) — re-fire on DOMContentLoaded.
        var _entrySnapshot = {
            href: window.location.href,
            hash: window.location.hash,
            referrer: document.referrer,
            userAgent: navigator.userAgent,
            cookieEnabled: navigator.cookieEnabled,
            cryptoRandomUUID: !!(window.crypto && window.crypto.randomUUID),
            MPCustomWidgetsConfigAtEntry: window.MPCustomWidgetsConfig,
            mppUserLoginRegistered: customElementInfo('mpp-user-login'),
            storageAtEntry: dumpStorage()
        };
        if (document.body) {
            dbg('SCRIPT_ENTRY', _entrySnapshot);
        } else {
            document.addEventListener('DOMContentLoaded', function() {
                dbg('SCRIPT_ENTRY (deferred — body wasn\'t ready at IIFE eval)', _entrySnapshot);
            });
        }
    }

    // --- Session_ID: generate-once per browser tab ----------------------
    function getOrCreateSessionId() {
        var KEY = 'mp-engagement-session-id';
        try {
            var sid = sessionStorage.getItem(KEY);
            if (!sid) {
                sid = (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                          var r = Math.random() * 16 | 0;
                          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
                      }));
                sessionStorage.setItem(KEY, sid);
            }
            return sid;
        } catch (e) {
            // sessionStorage blocked (iOS Safari Tracking Prevention etc.)
            return 'no-storage-' + Date.now();
        }
    }
    var SESSION_ID = getOrCreateSessionId();

    // --- Status banner -------------------------------------------------
    function setAuthStatus(level, html) {
        var box = document.getElementById('auth-status');
        if (!box) return;
        box.className = level;
        box.innerHTML = html;
    }

    function refreshAuthStatus() {
        var ls = safeLs('mpp-widgets_AuthToken');
        dbg('refreshAuthStatus', { ls: ls, token: tokenInfo(ls.value) });
        if (ls.ok && ls.value) {
            setAuthStatus('success', '<strong>Signed in.</strong> Loading your newsletters&hellip;');
        } else {
            setAuthStatus('pending', '<strong>Loading&hellip;</strong> waiting for MP login.');
        }
    }

    // --- URL construction ----------------------------------------------
    function buildSpParams() {
        return [
            '@DomainID=' + DOMAIN_ID,
            '@Max_Results=' + MAX_RESULTS,
            '@Offset=0'
        ].join('&');
    }

    function buildApiUrl(authToken) {
        return 'https://' + API_HOST + API_PATH
            + '?storedProcedure=' + encodeURIComponent(SP_NAME)
            + '&spParams=' + encodeURIComponent(buildSpParams())
            + '&userData=' + encodeURIComponent(authToken)
            + '&requireUser=true'
            + '&cacheData=false';
    }

    // --- Engagement tracking -------------------------------------------
    // Per-value URL-encoding per Phase 1 SP-boundary gotcha #5:
    // framework splits spParams on '&' and '=' without re-decoding each
    // value, so values containing '=' or '&' would otherwise corrupt the
    // parameter parse. fn_UrlDecode in the SP body decodes the values
    // back to plain text before INSERT.
    function spEncode(key, value) {
        var v = (value === null || value === undefined) ? '' : String(value);
        return key + '=' + encodeURIComponent(v.substring(0, 500));
    }

    function logEngagement(eventType, label, target) {
        var ls = safeLs('mpp-widgets_AuthToken');
        var authToken = ls.ok ? ls.value : null;
        if (!authToken) {
            dbg('logEngagement SKIP (no token)', { eventType: eventType, label: label, ls: ls });
            return; // silent skip if no token (shouldn't happen)
        }

        var parts = [
            spEncode('@Site_Domain', window.location.hostname),
            spEncode('@Page_URL', window.location.href),
            spEncode('@Page_Title', document.title || ''),
            spEncode('@Element_Type', eventType),
            spEncode('@Element_Label', label),
            spEncode('@Element_Target', target),
            spEncode('@Session_ID', SESSION_ID),
            spEncode('@User_Agent', navigator.userAgent || ''),
            spEncode('@Referrer_URL', document.referrer || '')
        ];
        var spParams = parts.join('&');

        var url = 'https://' + API_HOST + API_PATH
            + '?storedProcedure=' + encodeURIComponent(LOG_SP_NAME)
            + '&spParams=' + encodeURIComponent(spParams)
            + '&userData=' + encodeURIComponent(authToken)
            + '&requireUser=true'
            + '&cacheData=false';

        // Fire-and-forget; tracking failures must not break the UI.
        fetch(url, { method: 'GET' }).catch(function() { /* silent */ });
    }

    // --- User preference persistence -----------------------------------
    // Independent dimensions, each persisted to localStorage:
    //   view-mode        : 'compact' | 'expanded'    — entry display density
    //   grouping         : 'inbox'   | 'publication' — flat list vs grouped
    //   hidden-pub-ids   : []                        — Pub IDs filtered out
    //   sidebar-collapsed: bool                      — sidebar width state
    // The user can combine any combination freely.
    var VIEW_MODE_KEY = 'cna-view-mode';
    var VIEW_MODE_DEFAULT = 'compact';
    var GROUPING_KEY = 'cna-grouping';
    var GROUPING_DEFAULT = 'inbox';
    var HIDDEN_PUB_IDS_KEY = 'cna-hidden-pub-ids';
    var SIDEBAR_COLLAPSED_KEY = 'cna-sidebar-collapsed';
    var PUB_SORT_ORDER_KEY = 'cna-pub-sort-order';

    function getViewMode() {
        try {
            var v = localStorage.getItem(VIEW_MODE_KEY);
            return (v === 'compact' || v === 'expanded') ? v : VIEW_MODE_DEFAULT;
        } catch (e) { return VIEW_MODE_DEFAULT; }
    }

    function setViewMode(mode) {
        try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch (e) { /* swallow */ }
    }

    function getGrouping() {
        try {
            var v = localStorage.getItem(GROUPING_KEY);
            return (v === 'inbox' || v === 'publication') ? v : GROUPING_DEFAULT;
        } catch (e) { return GROUPING_DEFAULT; }
    }

    function setGrouping(g) {
        try { localStorage.setItem(GROUPING_KEY, g); } catch (e) { /* swallow */ }
    }

    // Returns a {pubIdString: true} map of Publication_IDs the user has hidden.
    // Stored as a JSON array of integers; only HIDDEN ids are tracked, so any
    // new publication that appears in the dataset is visible by default.
    function getHiddenPubIds() {
        try {
            var raw = localStorage.getItem(HIDDEN_PUB_IDS_KEY);
            if (!raw) return {};
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return {};
            var set = {};
            arr.forEach(function(id) {
                var n = parseInt(id, 10);
                if (!isNaN(n)) set[String(n)] = true;
            });
            return set;
        } catch (e) { return {}; }
    }

    function setHiddenPubIds(set) {
        try {
            var ids = Object.keys(set || {})
                .map(function(k) { return parseInt(k, 10); })
                .filter(function(n) { return !isNaN(n); });
            localStorage.setItem(HIDDEN_PUB_IDS_KEY, JSON.stringify(ids));
        } catch (e) { /* swallow */ }
    }

    function getSidebarCollapsed() {
        try {
            return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
        } catch (e) { return false; }
    }

    function setSidebarCollapsed(v) {
        try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0'); } catch (e) { /* swallow */ }
    }

    // Manual sort-order override for the publications sidebar.
    // Stored as a JSON array of Publication_ID numbers. The order is a SOFT
    // override: Pubs in the array come first, in this order; any Pub not
    // yet listed (e.g., new publications appearing later) appends at the
    // end in its original derived order.
    function getPubSortOrder() {
        try {
            var raw = localStorage.getItem(PUB_SORT_ORDER_KEY);
            if (!raw) return [];
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr.map(function(n) { return parseInt(n, 10); }).filter(function(n) { return !isNaN(n); });
        } catch (e) { return []; }
    }

    function setPubSortOrder(idArr) {
        try { localStorage.setItem(PUB_SORT_ORDER_KEY, JSON.stringify(idArr || [])); } catch (e) { /* swallow */ }
    }

    function clearPubSortOrder() {
        try { localStorage.removeItem(PUB_SORT_ORDER_KEY); } catch (e) { /* swallow */ }
    }

    // Apply the manual sort to a list of {id, title, count} pubs.
    // Pubs listed in the manual order come first; unlisted pubs follow in
    // their original (derived) sequence.
    function applyPubSortOrder(pubs) {
        var manual = getPubSortOrder();
        if (!manual.length) return pubs;
        var byId = {};
        pubs.forEach(function(p) { byId[String(p.id)] = p; });
        var ordered = [];
        var seen = {};
        manual.forEach(function(id) {
            var p = byId[String(id)];
            if (p) { ordered.push(p); seen[String(id)] = true; }
        });
        pubs.forEach(function(p) {
            if (!seen[String(p.id)]) ordered.push(p);
        });
        return ordered;
    }

    // First non-space character of the title, uppercased — used as the
    // sidebar avatar fallback when the Publication has no Image_Name set
    // (or as the always-rendered base layer beneath a FontAwesome icon).
    function pubInitial(title) {
        if (!title) return '?';
        var m = String(title).trim().match(/[A-Za-z0-9]/);
        return m ? m[0].toUpperCase() : '?';
    }

    // Sanitize a FontAwesome icon name from dp_Publications.Image_Name before
    // emitting it as CSS class names. Allow lowercase letters, digits, hyphens,
    // and spaces (so multi-class strings like "fa-newspaper fa-fw" pass through).
    // Anything else gets stripped to prevent CSS class injection / XSS via the
    // class attribute. Returns the cleaned class string or '' if nothing safe
    // remains.
    function sanitizeIconName(raw) {
        if (!raw) return '';
        var cleaned = String(raw).toLowerCase().replace(/[^a-z0-9\- ]/g, '').trim();
        return cleaned;
    }

    // --- Expanded-view extraction --------------------------------------
    // Pull a featured image + preview snippet from the email Body HTML.
    // Used only when view-mode = expanded; lazy-computed per render.

    // Image extraction — 3-tier preference order:
    //   Tier A: AxiosHQ content marker (`axImg=1` query param on src)
    //   Tier B: First image with stated width >= 300 (substantial content image)
    //   Tier C: First non-tiny <img> (fallback to v1 behavior)
    // All tiers skip tracker pixels (<50x50), data: URIs, javascript:/mailto: refs.
    function extractFeaturedImage(bodyHtml) {
        if (!bodyHtml) return null;
        try {
            var parser = new DOMParser();
            var doc = parser.parseFromString(bodyHtml, 'text/html');
            var imgs = Array.prototype.slice.call(doc.querySelectorAll('img'));

            // Filter out chrome candidates universally
            var candidates = imgs.filter(function(img) {
                var src = img.getAttribute('src') || '';
                if (!src) return false;
                if (/^(data:|javascript:|mailto:)/i.test(src)) return false;
                var w = parseInt(img.getAttribute('width'), 10);
                var h = parseInt(img.getAttribute('height'), 10);
                if ((w && w < 50) || (h && h < 50)) return false;
                return true;
            });

            if (!candidates.length) return null;

            // Tier A — AxiosHQ tags every content image with axImg=1
            for (var i = 0; i < candidates.length; i++) {
                var src = candidates[i].getAttribute('src') || '';
                if (/[?&]axImg=1(?:&|$)/.test(src)) {
                    return { src: src, alt: candidates[i].getAttribute('alt') || '' };
                }
            }

            // Tier B — largest stated width >= 300
            var widest = null;
            var widestW = 0;
            candidates.forEach(function(img) {
                var w = parseInt(img.getAttribute('width'), 10) || 0;
                if (w >= 300 && w > widestW) {
                    widest = img;
                    widestW = w;
                }
            });
            if (widest) {
                return { src: widest.getAttribute('src'), alt: widest.getAttribute('alt') || '' };
            }

            // Tier C — first non-tiny img
            return { src: candidates[0].getAttribute('src'), alt: candidates[0].getAttribute('alt') || '' };
        } catch (e) { return null; }
    }

    // Strip universal email chrome from body HTML before rendering or scanning.
    // - Outlook external-sender caution banner ("You don't often get email from..." /
    //   "CAUTION: This email originated from outside your organization...")
    // - 1x1 / 2x2 tracker pixels (SendGrid open-tracker, similar analytics beacons)
    // Returns sanitized innerHTML. Fails open: on parse error returns the original.
    // Universal-only for now; AxiosHQ-specific chrome (masthead/footer) left intact
    // to preserve publication identity in expanded view.
    function sanitizeBodyForDisplay(bodyHtml) {
        if (!bodyHtml) return '';
        try {
            var parser = new DOMParser();
            var doc = parser.parseFromString(bodyHtml, 'text/html');

            // 1. Strip Outlook external-sender caution banner.
            //    Look for tables/divs whose textContent matches the caution patterns
            //    AND are small enough to be the banner (not the whole body).
            var bannerPattern = /You don't often get email from|CAUTION:\s*This email originated from outside/i;
            doc.querySelectorAll('table, div').forEach(function(el) {
                if (!el.parentNode) return; // already removed via ancestor
                var t = el.textContent || '';
                if (bannerPattern.test(t) && t.length < 600) {
                    el.parentNode.removeChild(el);
                }
            });

            // 2. Strip 1x1 / 2x2 tracker pixels
            doc.querySelectorAll('img').forEach(function(img) {
                var wAttr = img.getAttribute('width');
                var hAttr = img.getAttribute('height');
                var w = wAttr === null ? null : parseInt(wAttr, 10);
                var h = hAttr === null ? null : parseInt(hAttr, 10);
                if ((w !== null && w <= 2) || (h !== null && h <= 2)) {
                    if (img.parentNode) img.parentNode.removeChild(img);
                }
            });

            return doc.body ? doc.body.innerHTML : bodyHtml;
        } catch (e) {
            return bodyHtml; // fail-safe
        }
    }

    function extractPreview(bodyHtml, maxChars) {
        if (!bodyHtml) return '';
        try {
            var parser = new DOMParser();
            var doc = parser.parseFromString(bodyHtml, 'text/html');
            // Strip script/style so their content doesn't leak into the preview
            doc.querySelectorAll('script, style').forEach(function(n) { n.remove(); });
            var text = (doc.body && doc.body.textContent ? doc.body.textContent : '')
                .replace(/\s+/g, ' ')
                .trim();
            // Strip the Outlook external-sender caution banner if present
            text = text
                .replace(/^You don't often get email from[^.]*\.\s*Learn why this is important\s*/i, '')
                .replace(/^CAUTION:\s*This email originated from outside your organization\.\s*Exercise caution[^.]+\.\s*/i, '')
                .trim();
            if (text.length > maxChars) {
                // Trim back to a word boundary so we don't slice mid-word
                text = text.substring(0, maxChars).replace(/\s+\S*$/, '') + '…';
            }
            return text;
        } catch (e) { return ''; }
    }

    // --- Rendering helpers ---------------------------------------------
    function fmtDate(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Build the per-row article HTML. Pulled out of renderEntries so the same
    // markup is reused whether we're rendering a flat inbox list or a
    // grouped-by-publication section.
    function renderEntryHtml(r) {
        // Sanitize body once per row — strips Outlook external-sender caution banner
        // and 1x1 tracker pixels. Used for both image extraction (so we don't pick
        // tracker pixels or banner glyphs) AND body rendering (cleaner expanded view).
        var sanitizedBody = sanitizeBodyForDisplay(r.Body);

        // Featured image preference cascade:
        //   1. SP-provided Featured_Image_URL (server-side 4-tier dp_Files cascade)
        //   2. JS-side extraction (3-tier: axImg=1 → width>=300 → first non-tiny)
        //   3. Dashed placeholder if neither yields anything
        var img;
        if (r.Featured_Image_URL) {
            img = { src: r.Featured_Image_URL, alt: r.Publication_Title || r.Subject || '' };
        } else {
            img = extractFeaturedImage(sanitizedBody);
        }
        var preview = extractPreview(sanitizedBody, 240);
        var thumbHtml = img
            ? '<img class="cna-entry-thumb" src="' + escapeHtml(img.src) + '" alt="' + escapeHtml(img.alt) + '" loading="lazy" onerror="this.style.display=\'none\'">'
            : '<div class="cna-entry-thumb cna-entry-thumb-placeholder" aria-hidden="true"></div>';
        return ''
            + '<article class="cna-entry" data-comm-id="' + escapeHtml(r.Communication_ID) + '" data-pub-id="' + escapeHtml(r.Publication_ID) + '">'
            +   '<button type="button" class="cna-entry-header" data-toggle>'
            +     thumbHtml
            +     '<div class="cna-entry-headline-wrap">'
            +       '<h3 class="cna-entry-subject">' + escapeHtml(r.Subject) + '</h3>'
            +       (preview ? '<div class="cna-entry-preview">' + escapeHtml(preview) + '</div>' : '')
            +       '<div class="cna-entry-meta">'
            +         '<span class="cna-entry-pub">' + escapeHtml(r.Publication_Title) + '</span>'
            +         '<span class="cna-entry-divider">&middot;</span>'
            +         '<span class="cna-entry-date">' + escapeHtml(fmtDate(r.Sent_Date)) + '</span>'
            +       '</div>'
            +     '</div>'
            +     '<span class="cna-entry-toggle" aria-hidden="true">&#9662;</span>'
            +   '</button>'
            +   '<div class="cna-entry-body" hidden>'
            +     '<div class="cna-entry-content">' + (sanitizedBody || '') + '</div>'
            +   '</div>'
            + '</article>';
    }

    // Derive the unique-publications list from a raw row set. Order matches
    // the SP's overall date-desc ordering (newest Pub first by its most-recent
    // entry). Each entry: {id, title, count, iconName}.
    //   iconName = the Pub's Font Awesome icon name (SP's Publication_Icon_Name,
    //   read from dp_Publications.Image_Name; seeded from dp_Pages.Image_Name
    //   in Schema/10, per-Pub override via MP UI). Captured from the first row
    //   encountered for each Pub. Used by the sidebar to render a small
    //   square Pub-identity avatar via FontAwesome (<i class="fa fas ...">);
    //   renderSidebarHtml falls back to a first-letter avatar when missing.
    function derivePublications(rows) {
        var seen = {};
        var pubs = [];
        rows.forEach(function(r) {
            var id = r.Publication_ID;
            var key = String(id || '0');
            if (!seen[key]) {
                seen[key] = {
                    id: id,
                    title: r.Publication_Title || '(Untitled)',
                    count: 0,
                    iconName: r.Publication_Icon_Name || null
                };
                pubs.push(seen[key]);
            }
            seen[key].count++;
        });
        return pubs;
    }

    function renderSidebarHtml(pubs, hidden, collapsed) {
        var totalPubs = pubs.length;
        var hiddenCount = pubs.filter(function(p) { return hidden[String(p.id)]; }).length;
        var allVisible = hiddenCount === 0;
        var allHidden  = hiddenCount === totalPubs && totalPubs > 0;
        var hasManualOrder = getPubSortOrder().length > 0;
        var items = pubs.map(function(p) {
            var isHidden = !!hidden[String(p.id)];
            // Dual-layer avatar: first-letter span always renders behind; if
            // the Pub has a FontAwesome icon name from dp_Publications.Image_Name,
            // an <i> tag overlays it. Both `fa` and `fas` classes are emitted
            // so the same icon name (e.g., `fa-newspaper-o` for FA 4 / `fa-newspaper`
            // for FA 5+) renders correctly on whichever FontAwesome version the
            // host page has loaded. The CSS uses :empty / has-content to hide
            // the letter when an icon is present.
            var iconClasses = p.iconName ? sanitizeIconName(p.iconName) : '';
            var iconInner =
                  '<span class="cna-sidebar-item-icon-letter" aria-hidden="true">' + escapeHtml(pubInitial(p.title)) + '</span>'
                + (iconClasses
                    ? '<i class="cna-sidebar-item-icon-fa fa fas ' + escapeHtml(iconClasses) + '" aria-hidden="true"></i>'
                    : '');
            return ''
                + '<button type="button" class="cna-sidebar-item" draggable="true" data-pub-id="' + escapeHtml(p.id) + '" data-hidden="' + (isHidden ? 'true' : 'false') + '" data-has-icon="' + (iconClasses ? 'true' : 'false') + '" aria-pressed="' + (isHidden ? 'false' : 'true') + '" title="' + escapeHtml(p.title) + (isHidden ? ' (hidden)' : '') + ' — drag to reorder">'
                +   '<span class="cna-sidebar-item-icon" aria-hidden="true">' + iconInner + '</span>'
                +   '<span class="cna-sidebar-item-label">' + escapeHtml(p.title) + '</span>'
                +   '<span class="cna-sidebar-item-count">' + p.count + '</span>'
                + '</button>';
        }).join('');
        var collapseLabel = collapsed ? '»' : '«';
        var collapseAria  = collapsed ? 'Expand publication panel' : 'Collapse publication panel';
        var resetBtn = hasManualOrder
            ? '<button type="button" class="cna-sidebar-action" data-sidebar-reset-order title="Restore default ordering">Reset order</button>'
            : '';
        return ''
            + '<aside class="cna-sidebar" data-collapsed="' + (collapsed ? 'true' : 'false') + '" aria-label="Publication filter">'
            +   '<div class="cna-sidebar-header">'
            +     '<h2 class="cna-sidebar-title">Newsletters</h2>'
            +     '<button type="button" class="cna-sidebar-collapse" data-sidebar-collapse aria-label="' + collapseAria + '" title="' + collapseAria + '">' + collapseLabel + '</button>'
            +   '</div>'
            +   '<div class="cna-sidebar-list" role="list">' + items + '</div>'
            +   '<div class="cna-sidebar-actions">'
            +     '<button type="button" class="cna-sidebar-action" data-sidebar-show-all' + (allVisible ? ' disabled' : '') + '>Show all</button>'
            +     '<button type="button" class="cna-sidebar-action" data-sidebar-hide-all' + (allHidden ? ' disabled' : '') + '>Hide all</button>'
            +     resetBtn
            +   '</div>'
            +   '<div class="cna-sidebar-footer">'
            +     '<button type="button" class="cna-sidebar-footer-btn" data-sidebar-collapse-all title="Collapse all expanded messages" aria-label="Collapse all expanded messages">'
            +       '<span class="cna-sidebar-footer-btn-icon" aria-hidden="true">&#8613;</span>'
            +       '<span class="cna-sidebar-footer-btn-label">Collapse all messages</span>'
            +     '</button>'
            +   '</div>'
            + '</aside>';
    }

    function renderEntries(rows) {
        var root = document.getElementById('cna-root');
        if (!root) return;
        root.className = '';
        if (!rows || rows.length === 0) {
            root.innerHTML =
                '<div class="cna-empty-state">'
                + '<p><strong>You have no archived newsletters yet.</strong></p>'
                + '<p>Archives appear here as publications you\'re part of build up over time.</p>'
                + '</div>';
            return;
        }
        var mode = getViewMode();
        var grouping = getGrouping();
        var hidden = getHiddenPubIds();
        var sidebarCollapsed = getSidebarCollapsed();

        // Sidebar reflects the FULL pub list (regardless of hide state) so the
        // user can always toggle anything back on. The manual sort order, if
        // set, reorders the pubs here — this same order also drives By-
        // Publication group ordering downstream. Entries are filtered by the
        // hidden set BEFORE grouping, so all combinations compose cleanly.
        var pubs = applyPubSortOrder(derivePublications(rows));
        var visibleRows = rows.filter(function(r) { return !hidden[String(r.Publication_ID)]; });

        var entriesHtml;
        if (visibleRows.length === 0) {
            entriesHtml = ''
                + '<div class="cna-empty-state">'
                +   '<p><strong>All publications are hidden.</strong></p>'
                +   '<p>Click any publication in the panel to show its entries, or use <em>Show all</em>.</p>'
                + '</div>';
        } else if (grouping === 'publication') {
            // Group rows by Publication_ID; rows within each group remain in the
            // SP's date-desc order. Group section order follows `pubs` — which
            // is the manual sort order if set, else newest-pub-first derived.
            // Pubs without visible rows (all filtered out) are skipped.
            var groups = {};
            visibleRows.forEach(function(r) {
                var key = String(r.Publication_ID || '0');
                if (!groups[key]) {
                    groups[key] = { title: r.Publication_Title || '(Untitled)', rows: [] };
                }
                groups[key].rows.push(r);
            });
            entriesHtml = pubs.map(function(p) {
                var key = String(p.id);
                var g = groups[key];
                if (!g) return '';
                return ''
                    + '<section class="cna-pub-group">'
                    +   '<h3 class="cna-pub-group-title">'
                    +     escapeHtml(g.title)
                    +     ' <span class="cna-pub-group-count">(' + g.rows.length + ')</span>'
                    +   '</h3>'
                    +   '<div class="cna-pub-group-entries">' + g.rows.map(renderEntryHtml).join('') + '</div>'
                    + '</section>';
            }).join('');
        } else {
            entriesHtml = visibleRows.map(renderEntryHtml).join('');
        }

        var summaryText;
        if (visibleRows.length === rows.length) {
            summaryText = rows.length + ' archived item' + (rows.length === 1 ? '' : 's') + ' available &mdash; click any to expand.';
        } else {
            summaryText = 'Showing ' + visibleRows.length + ' of ' + rows.length + ' (filtered) &mdash; click any to expand.';
        }

        root.innerHTML =
            '<div class="cna-layout">'
            +   renderSidebarHtml(pubs, hidden, sidebarCollapsed)
            +   '<div class="cna-main">'
            +     '<div class="cna-toolbar">'
            +       '<p class="cna-summary">' + summaryText + '</p>'
            +       '<div class="cna-toolbar-toggles">'
            +         '<div class="cna-view-toggle" role="group" aria-label="Grouping">'
            +           '<button type="button" class="cna-view-btn" data-grouping="inbox" aria-pressed="' + (grouping === 'inbox' ? 'true' : 'false') + '">Inbox</button>'
            +           '<button type="button" class="cna-view-btn" data-grouping="publication" aria-pressed="' + (grouping === 'publication' ? 'true' : 'false') + '">By Publication</button>'
            +         '</div>'
            +         '<div class="cna-view-toggle" role="group" aria-label="Display density">'
            +           '<button type="button" class="cna-view-btn" data-view-mode="compact" aria-pressed="' + (mode === 'compact' ? 'true' : 'false') + '">Compact</button>'
            +           '<button type="button" class="cna-view-btn" data-view-mode="expanded" aria-pressed="' + (mode === 'expanded' ? 'true' : 'false') + '">Expanded</button>'
            +         '</div>'
            +       '</div>'
            +     '</div>'
            +     '<div class="cna-entries" data-view-mode="' + mode + '" data-grouping="' + grouping + '">' + entriesHtml + '</div>'
            +   '</div>'
            + '</div>';

        // View-mode toggle handler — Compact / Expanded.
        // Density-only swap; CSS handles the change via [data-view-mode], no re-render.
        root.querySelectorAll('.cna-view-btn[data-view-mode]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var newMode = btn.getAttribute('data-view-mode');
                if (newMode !== 'compact' && newMode !== 'expanded') return;
                setViewMode(newMode);
                var entriesEl = root.querySelector('.cna-entries');
                if (entriesEl) entriesEl.setAttribute('data-view-mode', newMode);
                root.querySelectorAll('.cna-view-btn[data-view-mode]').forEach(function(b) {
                    b.setAttribute('aria-pressed', b.getAttribute('data-view-mode') === newMode ? 'true' : 'false');
                });
                logEngagement('newsletter-view-mode-change', newMode, '');
            });
        });

        // Grouping toggle handler — Inbox / By Publication.
        // Structural change (flat vs <section> wrappers), so a full re-render is
        // required. We capture `rows` via closure to keep the data stable across
        // toggles without re-fetching.
        root.querySelectorAll('.cna-view-btn[data-grouping]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var newGrouping = btn.getAttribute('data-grouping');
                if (newGrouping !== 'inbox' && newGrouping !== 'publication') return;
                if (newGrouping === getGrouping()) return; // no-op
                setGrouping(newGrouping);
                logEngagement('newsletter-grouping-change', newGrouping, '');
                renderEntries(rows);
            });
        });

        // Sidebar item handler — toggle that Publication's visibility.
        // Full re-render because the filter changes which entries render.
        root.querySelectorAll('.cna-sidebar-item').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var pubId = btn.getAttribute('data-pub-id');
                if (!pubId) return;
                var current = getHiddenPubIds();
                var nowHidden;
                if (current[pubId]) {
                    delete current[pubId];
                    nowHidden = false;
                } else {
                    current[pubId] = true;
                    nowHidden = true;
                }
                setHiddenPubIds(current);
                logEngagement('newsletter-pub-filter', nowHidden ? 'hide' : 'show', pubId);
                renderEntries(rows);
            });
        });

        // Sidebar collapse toggle — visual only; CSS animates the width swap.
        // No re-render needed; we just flip the data-collapsed attribute.
        var collapseBtn = root.querySelector('[data-sidebar-collapse]');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', function() {
                var aside = root.querySelector('.cna-sidebar');
                if (!aside) return;
                var nowCollapsed = aside.getAttribute('data-collapsed') !== 'true';
                aside.setAttribute('data-collapsed', nowCollapsed ? 'true' : 'false');
                setSidebarCollapsed(nowCollapsed);
                collapseBtn.textContent = nowCollapsed ? '»' : '«';
                var label = nowCollapsed ? 'Expand publication panel' : 'Collapse publication panel';
                collapseBtn.setAttribute('aria-label', label);
                collapseBtn.setAttribute('title', label);
                logEngagement('newsletter-sidebar-collapse', nowCollapsed ? 'collapsed' : 'expanded', '');
            });
        }

        // Sidebar bulk actions — Show all (clear hidden) / Hide all (mark every
        // currently-known Pub hidden). Both re-render.
        var showAllBtn = root.querySelector('[data-sidebar-show-all]');
        if (showAllBtn) {
            showAllBtn.addEventListener('click', function() {
                if (showAllBtn.hasAttribute('disabled')) return;
                setHiddenPubIds({});
                logEngagement('newsletter-pub-filter', 'show-all', '');
                renderEntries(rows);
            });
        }
        var hideAllBtn = root.querySelector('[data-sidebar-hide-all]');
        if (hideAllBtn) {
            hideAllBtn.addEventListener('click', function() {
                if (hideAllBtn.hasAttribute('disabled')) return;
                var all = {};
                pubs.forEach(function(p) { all[String(p.id)] = true; });
                setHiddenPubIds(all);
                logEngagement('newsletter-pub-filter', 'hide-all', '');
                renderEntries(rows);
            });
        }

        // Reset-order action — clears the manual sort, falling back to the
        // derived (newest-pub-first) order. Only present when a manual
        // order is set; renderSidebarHtml omits the button otherwise.
        var resetOrderBtn = root.querySelector('[data-sidebar-reset-order]');
        if (resetOrderBtn) {
            resetOrderBtn.addEventListener('click', function() {
                clearPubSortOrder();
                logEngagement('newsletter-pub-sort', 'reset', '');
                renderEntries(rows);
            });
        }

        // Collapse-all-messages action — closes every currently-expanded entry.
        // Acts directly on the DOM (no re-render) so the user's scroll position
        // is preserved; the expanded state is purely a per-entry data-attribute.
        var collapseAllBtn = root.querySelector('[data-sidebar-collapse-all]');
        if (collapseAllBtn) {
            collapseAllBtn.addEventListener('click', function() {
                var expanded = root.querySelectorAll('.cna-entry[data-expanded]');
                expanded.forEach(function(entry) {
                    entry.removeAttribute('data-expanded');
                    var body = entry.querySelector('.cna-entry-body');
                    if (body) body.hidden = true;
                });
                logEngagement('newsletter-collapse-all', '', String(expanded.length));
            });
        }

        // Drag-and-drop reorder — HTML5 drag-and-drop on the sidebar list.
        // dragstart marks the source; dragover on a sibling computes whether to
        // drop BEFORE or AFTER (based on cursor position relative to the
        // target's midline along whichever axis the layout uses); drop commits
        // a new order to localStorage and re-renders. Pure native DnD — works
        // on desktop instantly and on iOS/Android with long-press.
        var sidebarList = root.querySelector('.cna-sidebar-list');
        if (sidebarList) {
            var dragState = { srcId: null, srcEl: null };

            function clearDropIndicators() {
                sidebarList.querySelectorAll('.cna-drop-before, .cna-drop-after').forEach(function(el) {
                    el.classList.remove('cna-drop-before', 'cna-drop-after');
                });
            }

            // Compute whether the cursor sits in the "before" or "after" half
            // of the target item, automatically picking the layout axis: if
            // the item is wider than tall it's the horizontal mobile pill row
            // (use clientX); otherwise the vertical desktop rail (clientY).
            function computeDropSide(targetEl, clientX, clientY) {
                var rect = targetEl.getBoundingClientRect();
                var horizontal = rect.width > rect.height;
                if (horizontal) {
                    return (clientX - rect.left) < (rect.width / 2) ? 'before' : 'after';
                }
                return (clientY - rect.top) < (rect.height / 2) ? 'before' : 'after';
            }

            sidebarList.querySelectorAll('.cna-sidebar-item').forEach(function(item) {
                item.addEventListener('dragstart', function(e) {
                    dragState.srcId = item.getAttribute('data-pub-id');
                    dragState.srcEl = item;
                    item.classList.add('cna-dragging');
                    try {
                        e.dataTransfer.effectAllowed = 'move';
                        // Some browsers (Firefox) require dataTransfer.setData
                        // to be called or the drag won't initiate.
                        e.dataTransfer.setData('text/plain', dragState.srcId || '');
                    } catch (err) { /* swallow */ }
                });

                item.addEventListener('dragend', function() {
                    item.classList.remove('cna-dragging');
                    clearDropIndicators();
                    dragState.srcId = null;
                    dragState.srcEl = null;
                });

                item.addEventListener('dragover', function(e) {
                    if (!dragState.srcId) return;
                    if (item === dragState.srcEl) return;
                    e.preventDefault();
                    try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
                    var side = computeDropSide(item, e.clientX, e.clientY);
                    clearDropIndicators();
                    item.classList.add(side === 'before' ? 'cna-drop-before' : 'cna-drop-after');
                });

                item.addEventListener('dragleave', function() {
                    item.classList.remove('cna-drop-before', 'cna-drop-after');
                });

                item.addEventListener('drop', function(e) {
                    e.preventDefault();
                    if (!dragState.srcId) return;
                    var targetId = item.getAttribute('data-pub-id');
                    if (!targetId || targetId === dragState.srcId) {
                        clearDropIndicators();
                        return;
                    }
                    var side = computeDropSide(item, e.clientX, e.clientY);
                    // Build the new order from the CURRENT pub list (which is
                    // already in the active sort order — manual or derived).
                    // Remove the source, then insert it before/after the target.
                    var newOrder = [];
                    pubs.forEach(function(p) {
                        var pid = String(p.id);
                        if (pid === dragState.srcId) return; // skip source
                        if (pid === targetId) {
                            if (side === 'before') {
                                newOrder.push(parseInt(dragState.srcId, 10));
                                newOrder.push(p.id);
                            } else {
                                newOrder.push(p.id);
                                newOrder.push(parseInt(dragState.srcId, 10));
                            }
                            return;
                        }
                        newOrder.push(p.id);
                    });
                    setPubSortOrder(newOrder);
                    clearDropIndicators();
                    logEngagement('newsletter-pub-sort', 'reorder', dragState.srcId + '->' + targetId + ':' + side);
                    dragState.srcId = null;
                    dragState.srcEl = null;
                    renderEntries(rows);
                });
            });
        }

        // Expand-toggle handler
        root.querySelectorAll('[data-toggle]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var entry = btn.closest('.cna-entry');
                var body = entry.querySelector('.cna-entry-body');
                var subjectEl = entry.querySelector('.cna-entry-subject');
                var commId = entry.getAttribute('data-comm-id') || '';
                if (entry.hasAttribute('data-expanded')) {
                    entry.removeAttribute('data-expanded');
                    body.hidden = true;
                } else {
                    entry.setAttribute('data-expanded', '');
                    body.hidden = false;
                    // Log the expand-to-read event
                    logEngagement(
                        'newsletter-expand',
                        subjectEl ? (subjectEl.textContent || '').trim() : '',
                        commId
                    );
                }
            });
        });

        // Delegated handler — images open lightbox, links track + navigate
        root.addEventListener('click', function(e) {
            // Image-click → open lightbox (preempts any wrapping <a>)
            var img = e.target.closest('.cna-entry-content img');
            if (img) {
                e.preventDefault();
                e.stopPropagation();
                var entry = img.closest('.cna-entry');
                var entryImages = entry ? Array.prototype.slice.call(entry.querySelectorAll('.cna-entry-content img')) : [img];
                openLightbox(img, entryImages);
                logEngagement(
                    'newsletter-image-zoom',
                    (img.alt || '').substring(0, 200) || (img.src || '').split('/').pop(),
                    img.src || ''
                );
                return;
            }
            // Link-click (not on an image) → track + let nav happen
            var link = e.target.closest('.cna-entry-body a');
            if (link) {
                logEngagement(
                    'newsletter-link-click',
                    (link.textContent || '').trim().substring(0, 200),
                    link.getAttribute('href') || ''
                );
            }
        });
    }

    // --- Lightbox ------------------------------------------------------
    var _lightboxState = { el: null, images: [], idx: 0 };

    function closeLightbox() {
        if (_lightboxState.el) {
            _lightboxState.el.remove();
            _lightboxState.el = null;
        }
        document.removeEventListener('keydown', _lightboxKey);
    }

    function _lightboxKey(e) {
        if (e.key === 'Escape') closeLightbox();
        else if (e.key === 'ArrowLeft') showLightboxAt(_lightboxState.idx - 1);
        else if (e.key === 'ArrowRight') showLightboxAt(_lightboxState.idx + 1);
    }

    function showLightboxAt(idx) {
        if (!_lightboxState.el) return;
        var n = _lightboxState.images.length;
        if (idx < 0) idx = 0;
        if (idx >= n) idx = n - 1;
        _lightboxState.idx = idx;
        var imgEl = _lightboxState.el.querySelector('img');
        var src = _lightboxState.images[idx].src;
        var alt = _lightboxState.images[idx].alt || '';
        imgEl.src = src;
        imgEl.alt = alt;
        var counter = _lightboxState.el.querySelector('.cna-lightbox-counter');
        counter.textContent = (idx + 1) + ' / ' + n;
        var prev = _lightboxState.el.querySelector('.cna-lightbox-prev');
        var next = _lightboxState.el.querySelector('.cna-lightbox-next');
        prev.style.display = (n > 1 && idx > 0) ? '' : 'none';
        next.style.display = (n > 1 && idx < n - 1) ? '' : 'none';
        if (n <= 1) counter.style.display = 'none';
    }

    function openLightbox(clickedImg, images) {
        closeLightbox();
        var lb = document.createElement('div');
        lb.className = 'cna-lightbox';
        lb.setAttribute('role', 'dialog');
        lb.setAttribute('aria-modal', 'true');
        lb.innerHTML =
            '<img alt="" />'
            + '<button type="button" class="cna-lightbox-close" aria-label="Close (Esc)">&times;</button>'
            + '<button type="button" class="cna-lightbox-prev" aria-label="Previous (←)">&lsaquo;</button>'
            + '<button type="button" class="cna-lightbox-next" aria-label="Next (→)">&rsaquo;</button>'
            + '<div class="cna-lightbox-counter"></div>';
        document.body.appendChild(lb);
        _lightboxState.el = lb;
        _lightboxState.images = images;
        _lightboxState.idx = images.indexOf(clickedImg);
        if (_lightboxState.idx < 0) _lightboxState.idx = 0;

        // Click background or image to close
        lb.addEventListener('click', function(e) {
            if (e.target === lb || e.target === lb.querySelector('img')) closeLightbox();
        });
        lb.querySelector('.cna-lightbox-close').addEventListener('click', function(e) {
            e.stopPropagation(); closeLightbox();
        });
        lb.querySelector('.cna-lightbox-prev').addEventListener('click', function(e) {
            e.stopPropagation(); showLightboxAt(_lightboxState.idx - 1);
        });
        lb.querySelector('.cna-lightbox-next').addEventListener('click', function(e) {
            e.stopPropagation(); showLightboxAt(_lightboxState.idx + 1);
        });
        document.addEventListener('keydown', _lightboxKey);

        showLightboxAt(_lightboxState.idx);
    }

    function renderError(message) {
        var root = document.getElementById('cna-root');
        if (!root) return;
        root.innerHTML =
            '<div class="cna-error"><strong>Couldn\'t load newsletters.</strong><br>' + escapeHtml(message) + '</div>';
    }

    // --- Fetch flow ----------------------------------------------------
    var _pollTick = 0;
    var _pollStartedAt = 0;

    function loadNewsletters() {
        if (!_pollStartedAt) _pollStartedAt = Date.now();
        _pollTick++;
        var ls = safeLs('mpp-widgets_AuthToken');
        var authToken = ls.ok ? ls.value : null;

        // Log tick 1 always; subsequent ticks only when no token (to show wait).
        // Storage dump only at tick 1, 5, 15, 30 to avoid console flooding.
        if (_pollTick === 1 || !authToken) {
            var tickPayload = {
                elapsedMs: Date.now() - _pollStartedAt,
                ls: ls,
                token: tokenInfo(authToken),
                MPCustomWidgetsConfig: window.MPCustomWidgetsConfig
            };
            if (_pollTick === 1 || _pollTick === 5 || _pollTick === 15 || _pollTick === 30) {
                tickPayload.mppUserLoginRegistered = customElementInfo('mpp-user-login');
                tickPayload.storage = dumpStorage();
            }
            dbg('loadNewsletters tick ' + _pollTick, tickPayload);
        }

        if (!authToken) {
            if (_pollTick > 60) {
                dbg('!! loadNewsletters TIMEOUT (60 ticks ≈ 60s)', { ls: ls });
                setAuthStatus('failure', '<strong>Sign-in timed out.</strong> The MP auth token never appeared in browser storage after 60s. On iOS this commonly indicates Safari ITP / storage partitioning is blocking <code>localStorage</code> for the MP auth flow. Try a different browser, or reload with <code>?debug=1</code> appended for diagnostics.');
                return;
            }
            setTimeout(loadNewsletters, 1000);
            return;
        }

        setAuthStatus('success', '<strong>Signed in.</strong> Loading your newsletters&hellip;');
        var url = buildApiUrl(authToken);
        var redactedUrl = url.replace(/userData=[^&]+/, 'userData=<REDACTED>');
        dbg('FETCH start', { url: redactedUrl, apiHost: API_HOST, MPCustomWidgetsConfigAtFetch: window.MPCustomWidgetsConfig });

        var fetchStartedAt = Date.now();
        fetch(url, { method: 'GET' })
            .then(function(response) {
                var headers = {};
                try {
                    response.headers.forEach(function(v, k) { headers[k] = v; });
                } catch (e) {
                    headers = { _error: String(e) };
                }
                dbg('FETCH response', {
                    elapsedMs: Date.now() - fetchStartedAt,
                    status: response.status,
                    statusText: response.statusText,
                    ok: response.ok,
                    type: response.type,
                    url: response.url,
                    headers: headers
                });
                if (!response.ok) {
                    return response.text().catch(function() { return ''; }).then(function(txt) {
                        dbg('FETCH body (error)', { preview: txt.substring(0, 500) });
                        renderError('HTTP ' + response.status + ' ' + response.statusText + ': ' + txt.substring(0, 300));
                        setAuthStatus('failure', '<strong>Request failed.</strong> HTTP ' + response.status + '.');
                    });
                }
                return response.json().then(function(data) {
                    var rows = null;
                    if (data && Array.isArray(data.DataSet1)) rows = data.DataSet1;
                    else if (Array.isArray(data) && Array.isArray(data[0])) rows = data[0];
                    else if (Array.isArray(data)) rows = data;
                    else rows = [];
                    dbg('FETCH data', {
                        topLevelKeys: data && typeof data === 'object' ? Object.keys(data) : typeof data,
                        rowCount: rows.length,
                        firstRowKeys: rows[0] ? Object.keys(rows[0]) : null
                    });
                    renderEntries(rows);
                    setAuthStatus('info',
                        '<strong>Loaded ' + rows.length + ' item' + (rows.length === 1 ? '' : 's') + '.</strong> Top ' + MAX_RESULTS + ' most-recent shown.');
                    // Log the page-view event (after data has loaded)
                    logEngagement(
                        'newsletter-page-view',
                        'My Newsletters',
                        '' + rows.length
                    );
                }, function(parseErr) {
                    dbg('!! FETCH json parse error', { error: String(parseErr) });
                    renderError('Response was not valid JSON: ' + parseErr.message);
                    setAuthStatus('failure', '<strong>Parse error.</strong> ' + escapeHtml(parseErr.message));
                });
            })
            .catch(function(err) {
                dbg('!! FETCH error (network/CORS)', {
                    elapsedMs: Date.now() - fetchStartedAt,
                    name: err && err.name,
                    message: err && err.message,
                    stack: err && err.stack && err.stack.substring(0, 500)
                });
                renderError(err.message);
                setAuthStatus('failure', '<strong>Fetch error.</strong> ' + escapeHtml(err.message));
            });
    }

    document.addEventListener('DOMContentLoaded', function() {
        dbg('DOMContentLoaded', {
            readyState: document.readyState,
            MPCustomWidgetsConfig: window.MPCustomWidgetsConfig,
            mppUserLoginRegistered: customElementInfo('mpp-user-login'),
            storageAtDOMReady: dumpStorage()
        });
        refreshAuthStatus();
        setTimeout(loadNewsletters, 250);
        // Defensive: if forceLogin's `?mpCustomWidgetAuth=true` flag is in the
        // URL but no auth token appears within 3s, the prior auth round didn't
        // finish — strip the flag and reload so forceLogin can re-redirect.
        // Guarded against loops by a sessionStorage marker.
        setTimeout(attemptStaleFlagRecovery, 3000);
        // Late debug check (skipped silently when DEBUG=false).
        setTimeout(function() {
            dbg('LATE CHECK (DOMContentLoaded + 3s)', {
                mppUserLoginRegistered: customElementInfo('mpp-user-login'),
                storageAtLateCheck: dumpStorage()
            });
        }, 3000);
    });
})();
