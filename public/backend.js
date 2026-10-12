// Browser data layer for the Vercel version.
// Gives the portal the same small API it used on claude.ai (TED.use("db"), TED.use("user")),
// backed by Supabase. Also adds email sign-in and the admin "AI & discovery" panel.
(function () {
  "use strict";
  var sbPromise = fetch("/api/config", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (c) {
    if (!c.url || !c.anonKey || !window.supabase) throw new Error("Supabase is not configured");
    return window.supabase.createClient(c.url, c.anonKey, { auth: { persistSession: true, detectSessionInUrl: true, autoRefreshToken: true } });
  });
  var sessionPromise = sbPromise.then(function (sb) { return sb.auth.getSession().then(function (r) { return r.data.session; }); });

  // ---------- Field mapping (page uses camelCase, database uses snake_case) ----------
  var MAP = { start: "start_date", end: "end_date", startTime: "start_time", endTime: "end_time", costMin: "cost_min", sourceUrl: "source_url", dateConfidence: "date_confidence", autoTagged: "auto_tagged", createdAt: "created_at", updatedAt: "updated_at" };
  var COLS = ["id", "title", "organizer", "start_date", "end_date", "start_time", "end_time", "tz", "venue", "city", "country", "format", "status", "cost", "cost_min", "language", "url", "source_url", "date_confidence", "description", "categories", "niche", "groups", "scope", "approved", "auto_tagged", "source", "created_at", "updated_at"];
  var BACK = {}; Object.keys(MAP).forEach(function (k) { BACK[MAP[k]] = k; });
  function toRow(e) {
    var r = {};
    Object.keys(e).forEach(function (k) { var col = MAP[k] || k; if (COLS.indexOf(col) >= 0) r[col] = e[k]; });
    if ("start_time" in r && r.start_time == null) r.start_time = "";
    if ("end_time" in r && r.end_time == null) r.end_time = "";
    if (r.end_date === "") r.end_date = r.start_date;
    return r;
  }
  function fromRow(r) { var e = {}; Object.keys(r).forEach(function (k) { e[BACK[k] || k] = r[k]; }); return e; }
  function dbErr(e) {
    var m = (e && e.message) || "";
    return { code: (e && e.code === "42501") || /row-level security|permission denied|violates/i.test(m) ? "invalid_argument" : "unavailable", message: m };
  }

  // ---------- db shim ----------
  function makeDb(sb, session) {
    var uid = session && session.user ? session.user.id : null;
    var eventListeners = [], loading = null, timer = null;
    function loadEvents() {
      if (loading) return loading;
      loading = sb.from("events").select("*").order("start_date", { ascending: true }).then(function (r) {
        loading = null;
        if (r.error) throw r.error;
        var docs = r.data.map(function (row) { var e = fromRow(row); return { id: row.id, exists: true, data: function () { return e; } }; });
        eventListeners.forEach(function (l) { l.next({ docs: docs, size: docs.length, empty: !docs.length }); });
      }).catch(function (err) { loading = null; eventListeners.forEach(function (l) { l.error && l.error(dbErr(err)); }); });
      return loading;
    }
    function refreshSoon() { clearTimeout(timer); timer = setTimeout(loadEvents, 250); }
    try { sb.channel("events-live").on("postgres_changes", { event: "*", schema: "public", table: "events" }, refreshSoon).subscribe(); } catch (e) {}
    setInterval(loadEvents, 5 * 60 * 1000);

    function eventDoc(id) {
      return {
        set: function (d) { var row = toRow(Object.assign({}, d, { id: id })); return sb.from("events").upsert(row).then(function (r) { if (r.error) throw dbErr(r.error); refreshSoon(); }); },
        update: function (d) { return sb.from("events").update(toRow(d)).eq("id", id).select("id").then(function (r) { if (r.error) throw dbErr(r.error); if (!r.data || !r.data.length) throw { code: "invalid_argument", message: "Not allowed" }; refreshSoon(); }); },
        delete: function () { return sb.from("events").delete().eq("id", id).then(function (r) { if (r.error) throw dbErr(r.error); refreshSoon(); }); }
      };
    }
    function runsQuery(n) {
      return {
        orderBy: function () { return runsQuery(n); },
        limit: function (k) { return runsQuery(k); },
        onSnapshot: function (next, error) {
          function load() {
            sb.from("discovery_runs").select("*").order("ran_at", { ascending: false }).limit(n || 14).then(function (r) {
              if (r.error) return error && error(dbErr(r.error));
              next({ docs: r.data.map(function (x) { var d = { ranAt: x.ran_at, found: x.found, added: x.added, skipped: x.skipped, notes: x.notes, provider: x.provider, area: x.area, trigger: x.trigger, errors: x.errors }; return { id: String(x.id), data: function () { return d; } }; }) });
            });
          }
          load(); TED._reloadRuns = load;
          return function () {};
        }
      };
    }
    function planDoc() {
      var last = {};
      return {
        onSnapshot: function (next, error) {
          sb.from("plans").select("event_id,state,at").then(function (r) {
            if (r.error) return error && error(dbErr(r.error));
            var items = {}; r.data.forEach(function (p) { items[p.event_id] = { state: p.state, at: p.at }; });
            last = items;
            next({ exists: true, data: function () { return { items: items }; }, metadata: { hasPendingWrites: false } });
          });
          return function () {};
        },
        set: function (d) {
          var items = d.items || {}, del = [], up = [];
          Object.keys(last).forEach(function (k) { if (!items[k]) del.push(k); });
          Object.keys(items).forEach(function (k) { if (!last[k] || last[k].state !== items[k].state) up.push({ user_id: uid, event_id: k, state: items[k].state, at: items[k].at || new Date().toISOString() }); });
          var jobs = [];
          if (del.length) jobs.push(sb.from("plans").delete().eq("user_id", uid).in("event_id", del));
          if (up.length) jobs.push(sb.from("plans").upsert(up));
          return Promise.all(jobs).then(function (rs) { rs.forEach(function (r) { if (r.error) throw dbErr(r.error); }); last = items; });
        }
      };
    }
    return {
      collection: function (name) {
        if (name === "events") return { doc: eventDoc, onSnapshot: function (next, error) { eventListeners.push({ next: next, error: error }); loadEvents(); return function () {}; } };
        if (name === "runs") return runsQuery(14);
        throw new Error("Unknown collection " + name);
      },
      doc: function (path) { if (/^data\/users\/[^/]+\/plan$/.test(path) && uid) return planDoc(); throw new Error("Unknown doc " + path); }
    };
  }

  var isAdminPromise = Promise.all([sbPromise, sessionPromise]).then(function (a) {
    if (!a[1]) return false;
    return a[0].rpc("is_admin").then(function (r) { return r.data === true; });
  }).catch(function () { return false; });

  var TED = window.TED = {
    use: function (name) {
      return Promise.all([sbPromise, sessionPromise]).then(function (a) {
        var sb = a[0], session = a[1];
        if (name === "db") return makeDb(sb, session);
        if (name === "user") return {
          canEdit: function () { return isAdminPromise; },
          id: function () { return Promise.resolve(session && session.user ? session.user.id : null); },
          isOwner: function () { return isAdminPromise; }
        };
        return null;
      }).catch(function () { return null; });
    }
  };

  // ---------- Small helpers ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function api(method, body) {
    return sessionPromise.then(function (s) {
      return fetch("/api/admin/ai", { method: method, headers: { "content-type": "application/json", authorization: "Bearer " + (s ? s.access_token : "") }, body: body ? JSON.stringify(body) : undefined })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: "Server returned " + r.status }; }); });
    });
  }

  // ---------- Sign-in UI ----------
  function mountAuth() {
    var host = document.querySelector(".clocks"); if (!host) return;
    var btn = document.createElement("button"); btn.type = "button"; btn.className = "btn"; btn.id = "authBtn"; btn.textContent = "Sign in";
    host.insertBefore(btn, document.getElementById("adminBtn"));
    var dlg = document.createElement("div");
    dlg.id = "authDlg"; dlg.hidden = true;
    dlg.innerHTML = '<div class="scrim" data-auth-close="1"></div><div class="authbox" role="dialog" aria-modal="true" aria-labelledby="authTitle">' +
      '<h2 id="authTitle">Sign in</h2><p class="note">We email you a one-time sign-in link. Signing in saves your plan to your account and unlocks Admin if you are an admin.</p>' +
      '<form id="authForm" class="form" novalidate><label class="full" for="authEmail">Email<input id="authEmail" type="email" autocomplete="email" required></label>' +
      '<div class="row full"><button class="btn primary" type="submit">Email me a link</button><button class="btn ghost" type="button" data-auth-close="1">Cancel</button></div><p class="msg full" id="authMsg" hidden></p></form></div>';
    document.body.appendChild(dlg);
    var st = document.createElement("style");
    st.textContent = "#authDlg .authbox{position:fixed;z-index:31;top:50%;left:50%;transform:translate(-50%,-50%);width:min(440px,calc(100% - 32px));background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:10px}#authDlg .scrim{z-index:30}#authDlg h2{margin:0;font:700 22px var(--font-display);font-stretch:85%}" +
      ".ai .provider{display:flex;gap:8px;flex-wrap:wrap}.ai .provider label{flex-direction:row;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-weight:600;cursor:pointer}.ai .provider label:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}.ai details summary{cursor:pointer;font-weight:600;font-size:13px;color:var(--accent)}.ai ol{margin:6px 0 0;padding-left:20px;font-size:13px;display:flex;flex-direction:column;gap:4px}.ai .keyline{font:500 12px var(--font-mono);color:var(--muted)}";
    document.head.appendChild(st);

    Promise.all([sbPromise, sessionPromise]).then(function (a) {
      var sb = a[0], s = a[1];
      if (s && s.user) { btn.textContent = "Sign out"; btn.title = "Signed in as " + s.user.email; }
      btn.addEventListener("click", function () {
        if (s && s.user) { sb.auth.signOut().then(function () { location.reload(); }); return; }
        dlg.hidden = false; document.getElementById("authEmail").focus();
      });
      dlg.addEventListener("click", function (e) { if (e.target.dataset && e.target.dataset.authClose) dlg.hidden = true; });
      document.getElementById("authForm").addEventListener("submit", function (e) {
        e.preventDefault();
        var email = document.getElementById("authEmail").value.trim(), m = document.getElementById("authMsg");
        if (!/^\S+@\S+\.\S+$/.test(email)) { m.hidden = false; m.className = "msg full err"; m.textContent = "Enter a valid email address."; return; }
        sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } }).then(function (r) {
          m.hidden = false;
          if (r.error) { m.className = "msg full err"; m.textContent = r.error.message; }
          else { m.className = "msg full ok"; m.textContent = "Check " + email + " for your sign-in link. You can close this."; }
        });
      });
    }).catch(function () { btn.disabled = true; btn.title = "Sign-in is unavailable: Supabase is not configured"; });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAuth); else mountAuth();

  // ---------- Admin: AI & discovery panel ----------
  var KEY_STEPS = {
    claude: ["Go to <a href=\"https://platform.claude.com\" target=\"_blank\" rel=\"noopener\">platform.claude.com</a> and sign in or create an account.",
      "Add credit or a payment method under <a href=\"https://platform.claude.com/settings/billing\" target=\"_blank\" rel=\"noopener\">Settings › Billing</a>. API usage is billed separately from a Claude.ai subscription.",
      "Open <a href=\"https://platform.claude.com/settings/keys\" target=\"_blank\" rel=\"noopener\">Settings › API keys</a>, click <b>Create key</b>, name it (for example “event-desk”) and copy it. It starts with <code>sk-ant-</code> and is shown only once.",
      "Paste it below, click <b>Save key</b>, then <b>Test key</b>."],
    openai: ["Go to <a href=\"https://platform.openai.com/api-keys\" target=\"_blank\" rel=\"noopener\">platform.openai.com/api-keys</a> and sign in.",
      "Add credit under <a href=\"https://platform.openai.com/account/billing/overview\" target=\"_blank\" rel=\"noopener\">Billing</a>. A ChatGPT Plus subscription does not cover API usage.",
      "Click <b>Create new secret key</b>, name it, and copy it. It starts with <code>sk-</code> and is shown only once.",
      "Paste it below, click <b>Save key</b>, then <b>Test key</b>."],
    gemini: ["Go to <a href=\"https://aistudio.google.com/apikey\" target=\"_blank\" rel=\"noopener\">aistudio.google.com/apikey</a> and sign in with your Google account.",
      "Click <b>Create API key</b> and choose or import a Google Cloud project.",
      "Copy the key. There is a free tier; turn on billing in that project for higher limits.",
      "Paste it below, click <b>Save key</b>, then <b>Test key</b>."]
  };
  var ai = { status: null, loading: false, msg: null, busy: null, result: null };
  function loadStatus() {
    if (ai.loading) return; ai.loading = true;
    api("GET").then(function (r) { ai.loading = false; if (r.ok) ai.status = r; else ai.msg = ["err", r.error]; repaint(); });
  }
  function repaint() { var el = document.getElementById("aiPanel"); if (el) el.outerHTML = TED.aiPanel(TED._runs || []); }

  TED.aiPanel = function (runs) {
    TED._runs = runs;
    if (!ai.status && !ai.loading) setTimeout(loadStatus, 0);
    var s = ai.status, h = '<div id="aiPanel" class="ai form">';
    h += '<p class="note full">The daily job runs on Vercel once a day (between 06:00 and 06:59 BDST). It reads the free Claude daily feed and any other feeds, and, if you add an AI key here, also asks that provider to search the web for new events in one area (rotating daily). Results are checked, de-duplicated and published to the site straight away. No approval needed.</p>';
    if (ai.msg) h += '<p class="msg full ' + ai.msg[0] + '">' + esc(ai.msg[1]) + '</p>';
    if (!s) return h + '<p class="note full">' + (ai.loading ? "Loading AI settings…" : "") + '</p>' + runsList(runs) + '</div>';
    var set = s.settings, P = s.providers;
    h += '<div class="qitem full"><h5>AI provider</h5><div class="provider" role="radiogroup" aria-label="AI provider">' +
      ["claude", "openai", "gemini"].map(function (id) { return '<label for="aip-' + id + '"><input type="radio" name="aiProvider" id="aip-' + id + '" value="' + id + '"' + (set.provider === id ? " checked" : "") + '>' + esc(P[id].label) + '</label>'; }).join("") + '</div>' +
      '<div class="form" style="margin-top:8px">' +
      ["claude", "openai", "gemini"].map(function (id) { return '<label for="aim-' + id + '">' + esc(P[id].label) + ' model<input id="aim-' + id + '" value="' + esc(set.models[id]) + '" placeholder="' + esc(P[id].defaultModel) + '"></label>'; }).join("") +
      '<label for="aiMax">Web searches per run<input id="aiMax" type="number" min="1" max="30" value="' + esc(set.maxSearches) + '"></label>' +
      '<label class="chk full" for="aiOn"><input type="checkbox" id="aiOn"' + (set.enabled ? " checked" : "") + '><span>Run discovery every day</span></label>' +
      '<div class="row full"><button class="btn primary" type="button" data-ai="save-settings"' + (ai.busy ? " disabled" : "") + '>Save settings</button></div></div></div>';
    if (!s.canStoreKeys) h += '<p class="msg full err">To save keys from this page, add a <code>KEYS_SECRET</code> environment variable in Vercel (any random text, 16+ characters) and redeploy. Until then, add keys as Vercel environment variables.</p>';
    ["claude", "openai", "gemini"].forEach(function (id) {
      var p = P[id], active = set.provider === id;
      var src = p.source === "portal" ? "Saved in the portal (" + p.hint + ")" : p.source === "vercel" ? "From Vercel variable " + p.envKey + " (" + p.hint + ")" : "No key yet";
      h += '<div class="qitem full"><h5>' + esc(p.label) + (active ? ' <span class="pill s-open">In use</span>' : "") + '</h5><span class="keyline">' + esc(src) + '</span>' +
        '<div class="row"><input type="password" id="aik-' + id + '" autocomplete="off" placeholder="Paste a new API key" aria-label="' + esc(p.label) + ' API key" style="flex:1 1 220px;min-width:0">' +
        '<button class="btn small primary" type="button" data-ai="save-key" data-p="' + id + '"' + (s.canStoreKeys ? "" : " disabled") + '>Save key</button>' +
        '<button class="btn small" type="button" data-ai="test-key" data-p="' + id + '"' + (p.source ? "" : " disabled") + '>Test key</button>' +
        (p.source === "portal" ? '<button class="btn small danger" type="button" data-ai="remove-key" data-p="' + id + '">Remove</button>' : "") + '</div>' +
        '<p class="note">' + esc(p.searchNote) + '</p>' +
        '<details><summary>How to get a ' + esc(p.label.split(" (")[0]) + ' API key</summary><ol>' + KEY_STEPS[id].map(function (t) { return "<li>" + t + "</li>"; }).join("") + '</ol></details></div>';
    });
    h += '<div class="qitem full"><h5>Run discovery now</h5><div class="row"><label for="aiArea" class="note">Area</label><select id="aiArea">' +
      [["auto", "Today’s rotation"], ["trading", "Financial markets & trading"], ["tradesaas", "Trade, SaaS & fintech"], ["business", "Business, economy & leadership"], ["all", "All three (slower)"]].map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join("") +
      '</select><button class="btn primary small" type="button" data-ai="run"' + (ai.busy ? " disabled" : "") + '>' + (ai.busy === "run" ? "Searching… this can take 1 to 4 minutes" : "Run now") + '</button></div>';
    if (ai.result) h += '<p class="note">' + esc(ai.result) + '</p>';
    h += '</div>' + runsList(runs) + '</div>';
    return h;
  };
  function runsList(runs) {
    if (!runs || !runs.length) return '<div class="empty full"><strong>No runs logged yet</strong>The first run appears here after the daily job or “Run now”.</div>';
    return '<div class="full">' + runs.map(function (r) {
      var errs = (r.errors || []).map(function (e) { return e.source + ": " + e.error; }).join(" · ");
      return '<div class="qitem" style="margin-bottom:8px"><h5>' + esc(new Date(r.ranAt).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })) + ' BDST</h5>' +
        '<span class="meta">' + esc([r.provider, r.area, r.trigger].filter(Boolean).join(" · ")) + '</span><span class="meta">' + esc((r.found || 0) + " found · " + (r.added || 0) + " queued · " + (r.skipped || 0) + " skipped") + '</span>' +
        (r.notes ? '<p class="note">' + esc(r.notes) + '</p>' : "") + (errs ? '<p class="msg err">' + esc(errs) + '</p>' : "") + '</div>';
    }).join("") + '</div>';
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-ai]"); if (!b || ai.busy) return;
    var act = b.dataset.ai, p = b.dataset.p;
    function done(r, okMsg) { ai.busy = null; ai.msg = r.ok ? ["ok", okMsg || r.message || "Done."] : ["err", r.error || "Something went wrong."]; ai.status = null; repaint(); }
    if (act === "save-settings") {
      var provider = (document.querySelector('input[name="aiProvider"]:checked') || {}).value || "claude";
      var row = { provider: provider, model_claude: document.getElementById("aim-claude").value.trim() || null, model_openai: document.getElementById("aim-openai").value.trim() || null,
        model_gemini: document.getElementById("aim-gemini").value.trim() || null, max_searches: Math.min(30, Math.max(1, parseInt(document.getElementById("aiMax").value, 10) || 12)), enabled: document.getElementById("aiOn").checked };
      ai.busy = act; repaint();
      sbPromise.then(function (sb) { return sb.from("ai_settings").update(row).eq("id", 1).select("id"); }).then(function (r) {
        done(r.error || !r.data.length ? { ok: false, error: r.error ? r.error.message : "Not allowed" } : { ok: true }, "Settings saved. The next run uses " + ai.status.providers[provider].label + ".");
      });
      return;
    }
    if (act === "save-key") {
      var key = document.getElementById("aik-" + p).value.trim();
      if (!key) { ai.msg = ["err", "Paste a key first."]; repaint(); return; }
      ai.busy = act; repaint(); api("POST", { action: "save-key", provider: p, key: key }).then(function (r) { done(r); }); return;
    }
    if (act === "remove-key" || act === "test-key") { ai.busy = act; ai.msg = act === "test-key" ? ["ok", "Testing…"] : null; repaint(); api("POST", { action: act, provider: p }).then(function (r) { done(r); }); return; }
    if (act === "run") {
      var area = document.getElementById("aiArea").value; ai.busy = "run"; ai.result = null; ai.msg = null; repaint();
      api("POST", { action: "run", area: area }).then(function (r) {
        ai.busy = null;
        if (!r.ok) { ai.msg = ["err", r.error]; }
        else {
          ai.msg = [r.errors && r.errors.length && !r.added ? "err" : "ok", r.added + " new event" + (r.added === 1 ? "" : "s") + " queued for review (" + r.found + " found, " + r.skipped + " skipped)."];
          ai.result = (r.queued || []).join(" · ") + (r.errors && r.errors.length ? (r.queued && r.queued.length ? " | " : "") + "Issues: " + r.errors.map(function (x) { return x.source + ": " + x.error; }).join(" · ") : "");
        }
        if (TED._reloadRuns) TED._reloadRuns();
        repaint();
      });
    }
  });
})();
