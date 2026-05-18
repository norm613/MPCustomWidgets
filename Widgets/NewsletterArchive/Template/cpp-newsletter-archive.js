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

    // --- View-mode persistence -----------------------------------------
    var VIEW_MODE_KEY = 'cna-view-mode';
    var VIEW_MODE_DEFAULT = 'compact';

    function getViewMode() {
        try {
            var v = localStorage.getItem(VIEW_MODE_KEY);
            return (v === 'compact' || v === 'expanded') ? v : VIEW_MODE_DEFAULT;
        } catch (e) { return VIEW_MODE_DEFAULT; }
    }

    function setViewMode(mode) {
        try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch (e) { /* swallow */ }
    }

    // --- Expanded-view extraction --------------------------------------
    // Pull a featured image + preview snippet from the email Body HTML.
    // Used only when view-mode = expanded; lazy-computed per render.

    function extractFeaturedImage(bodyHtml) {
        if (!bodyHtml) return null;
        try {
            var parser = new DOMParser();
            var doc = parser.parseFromString(bodyHtml, 'text/html');
            var imgs = doc.querySelectorAll('img');
            for (var i = 0; i < imgs.length; i++) {
                var img = imgs[i];
                var src = img.getAttribute('src') || '';
                if (!src) continue;
                // Skip data: URIs, mailto: links, and javascript: refs
                if (/^(data:|javascript:|mailto:)/i.test(src)) continue;
                // Skip <50x50 images — usually tracker pixels or banner glyphs
                var w = parseInt(img.getAttribute('width'), 10);
                var h = parseInt(img.getAttribute('height'), 10);
                if ((w && w < 50) || (h && h < 50)) continue;
                return { src: src, alt: img.getAttribute('alt') || '' };
            }
            return null;
        } catch (e) { return null; }
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
        var items = rows.map(function(r) {
            // Featured image preference cascade:
            //   1. SP-provided Featured_Image_URL (server-side 3-tier dp_Files cascade:
            //      Communication-attached → Publication-attached → Unsorted Publication-attached)
            //   2. JS-side extraction from first non-tiny <img> in Body HTML (fallback)
            //   3. Dashed placeholder if neither yields anything
            var img;
            if (r.Featured_Image_URL) {
                img = { src: r.Featured_Image_URL, alt: r.Publication_Title || r.Subject || '' };
            } else {
                img = extractFeaturedImage(r.Body);
            }
            var preview = extractPreview(r.Body, 240);
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
                +     '<div class="cna-entry-content">' + (r.Body || '') + '</div>'
                +   '</div>'
                + '</article>';
        }).join('');
        root.innerHTML =
            '<div class="cna-toolbar">'
            +   '<p class="cna-summary">' + rows.length + ' archived item' + (rows.length === 1 ? '' : 's') + ' available &mdash; click any to expand.</p>'
            +   '<div class="cna-view-toggle" role="group" aria-label="View mode">'
            +     '<button type="button" class="cna-view-btn" data-view-mode="compact" aria-pressed="' + (mode === 'compact' ? 'true' : 'false') + '">Compact</button>'
            +     '<button type="button" class="cna-view-btn" data-view-mode="expanded" aria-pressed="' + (mode === 'expanded' ? 'true' : 'false') + '">Expanded</button>'
            +   '</div>'
            + '</div>'
            + '<div class="cna-entries" data-view-mode="' + mode + '">' + items + '</div>';

        // View-mode toggle handler — switches between Compact and Expanded
        // via a data-view-mode attribute on .cna-entries (CSS handles the swap).
        // No re-render needed; localStorage remembers across visits.
        root.querySelectorAll('.cna-view-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var newMode = btn.getAttribute('data-view-mode');
                if (newMode !== 'compact' && newMode !== 'expanded') return;
                setViewMode(newMode);
                var entriesEl = root.querySelector('.cna-entries');
                if (entriesEl) entriesEl.setAttribute('data-view-mode', newMode);
                root.querySelectorAll('.cna-view-btn').forEach(function(b) {
                    b.setAttribute('aria-pressed', b.getAttribute('data-view-mode') === newMode ? 'true' : 'false');
                });
                logEngagement('newsletter-view-mode-change', newMode, '');
            });
        });

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
