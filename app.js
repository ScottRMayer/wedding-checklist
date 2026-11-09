// Wedding Build: shared planning checklist.
// Static front end (GitHub Pages) + Supabase (auth, Postgres, realtime).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";
import { CONFIG } from "./config.js";
import { REFERENCE } from "./reference.js";

const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
const $app = document.getElementById("app");
const $toasts = document.getElementById("toasts");

const VIEWS = [
  ["checklist", "Checklist"],
  ["vendors", "Vendors & Payments"],
  ["budget", "Budget"],
  ["reference", "Reference"],
  ["people", "People"],
  ["activity", "Activity"],
];

const state = {
  session: null,
  user: null,
  member: null,
  members: [],
  phases: [],
  items: [],
  vendors: [],
  budget: [],
  activity: [],
  view: localStorage.getItem("wb.view") || "checklist",
  phaseId: localStorage.getItem("wb.phase") || "p1",
  filters: { q: "", open: false, kind: "all", mine: false },
  openDetails: new Set(),
  adding: null,      // category key being added to
  editing: null,     // item id being edited
  pwFor: null,       // member email whose set-password form is open
  authMode: "signin",
  recovery: false,
  loaded: false,
  checking: false,
  pendingRender: false,
};

// ---------------------------------------------------------------- utilities
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function md(s) {
  let t = esc(s);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[\s(])\*([^*]+)\*/g, "$1<em>$2</em>");
  return t;
}
const money = (n) => (n == null || n === "" || isNaN(Number(n))) ? "" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(n));
const sum = (arr, k) => arr.reduce((a, r) => a + (Number(r[k]) || 0), 0);
function fmtDate(d) {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: y === new Date().getFullYear() ? undefined : "numeric" });
}
function relTime(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const todayISO = () => new Date().toLocaleDateString("en-CA");
const isOverdue = (it) => it.due_date && !it.done && it.due_date < todayISO();
const myEmail = () => (state.user?.email || "").toLowerCase();
function displayName(email) {
  if (!email) return "Someone";
  const m = state.members.find((x) => x.email === email.toLowerCase());
  if (m?.display_name) return m.display_name;
  return email.split("@")[0];
}
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const canEdit = () => ["owner", "editor"].includes(state.member?.role);
const isOwner = () => state.member?.role === "owner";
const tagClass = (t) => (t === "$" ? "money" : t);
const tagsHtml = (tags) => (tags || []).map((t) => `<span class="tag ${tagClass(t)}" title="${esc(tagTitle(t))}">${esc(t)}</span>`).join("");
function tagTitle(t) {
  const l = REFERENCE.legend.find((x) => x.tag === t);
  return l ? l.text : t;
}
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function dbError(err, what) {
  console.error(what, err);
  toast(`${what} failed: ${err?.message || err}`, "err");
}
const catKey = (it) => `${it.phase_id}::${it.category}`;

// ---------------------------------------------------------------- auth
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  state.user = session?.user || null;
  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      state.recovery = true;
      state.session = session; state.user = session?.user || null;
      render();
      return;
    }
    const was = state.user?.id;
    state.session = session;
    state.user = session?.user || null;
    if (event === "SIGNED_OUT") {
      state.member = null; state.loaded = false; state.recovery = false;
      unsubscribeRealtime();
      render();
    } else if (session && session.user.id !== was) {
      await enter();
    }
  });
  if (state.user) await enter(); else render();
}

async function enter() {
  state.checking = true;
  render(); // show the loading shell while we look up membership
  const { data: m, error } = await sb.from("members").select("*").eq("email", myEmail()).maybeSingle();
  if (error) { dbError(error, "Checking your access"); }
  state.member = m || null;
  state.checking = false;
  if (!state.member) { state.loaded = false; render(); return; }
  await loadAll();
  subscribeRealtime();
  state.loaded = true;
  render();
}

async function loadAll() {
  const [ph, it, ve, bu, me, ac] = await Promise.all([
    sb.from("phases").select("*").order("ord"),
    sb.from("items").select("*").order("phase_id").order("category_ord").order("ord"),
    sb.from("vendors").select("*").order("ord"),
    sb.from("budget").select("*").order("ord"),
    sb.from("members").select("*").order("created_at"),
    sb.from("activity").select("*").order("at", { ascending: false }).limit(150),
  ]);
  for (const r of [ph, it, ve, bu, me, ac]) if (r.error) dbError(r.error, "Loading");
  state.phases = ph.data || [];
  state.items = it.data || [];
  state.vendors = ve.data || [];
  state.budget = bu.data || [];
  state.members = me.data || [];
  state.activity = ac.data || [];
  if (!state.phases.find((p) => p.id === state.phaseId)) state.phaseId = state.phases[0]?.id || "p1";
}

// ---------------------------------------------------------------- realtime
let channel = null;
function subscribeRealtime() {
  unsubscribeRealtime();
  channel = sb.channel("wedding-build");
  for (const table of ["items", "vendors", "budget", "members", "activity"]) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => applyChange(table, payload));
  }
  channel.subscribe();
}
function unsubscribeRealtime() { if (channel) { sb.removeChannel(channel); channel = null; } }
function applyChange(table, payload) {
  const key = table === "members" ? "email" : "id";
  const arr = state[table];
  if (payload.eventType === "DELETE") {
    const id = payload.old?.[key];
    const i = arr.findIndex((r) => r[key] === id);
    if (i >= 0) arr.splice(i, 1);
  } else {
    const row = payload.new;
    const i = arr.findIndex((r) => r[key] === row[key]);
    if (i >= 0) arr[i] = { ...arr[i], ...row }; else if (table === "activity") arr.unshift(row); else arr.push(row);
    if (table === "items") sortItems();
    if (table === "activity") state.activity = state.activity.slice(0, 200);
    if (table === "members" && row.email === myEmail()) state.member = row;
  }
  if (table === "members" && payload.eventType === "DELETE" && payload.old?.email === myEmail()) {
    state.member = null; render(); return;
  }
  scheduleRender();
}
function sortItems() {
  state.items.sort((a, b) => a.phase_id.localeCompare(b.phase_id) || a.category_ord - b.category_ord || a.ord - b.ord);
}
function scheduleRender() {
  const ae = document.activeElement;
  if (ae && $app.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) { state.pendingRender = true; return; }
  render();
}
document.addEventListener("focusout", () => { if (state.pendingRender) { state.pendingRender = false; setTimeout(render, 50); } });

// ---------------------------------------------------------------- render root
function render() {
  if (!state.user) { $app.innerHTML = authHtml(); return; }
  if (state.recovery) { $app.innerHTML = recoveryHtml(); return; }
  if (state.checking || (state.member && !state.loaded)) {
    $app.innerHTML = `<div class="boot"><div class="boot-mark"></div><p>Loading the build…</p></div>`;
    return;
  }
  if (!state.member) { $app.innerHTML = noAccessHtml(); return; }
  $app.innerHTML = shellHtml() + `<main class="main">${viewHtml()}</main>`;
}

function brandHtml(small = false) {
  return `<div class="brand">
    <div class="brand-mark"><svg width="22" height="22" viewBox="0 0 64 64" fill="none"><path d="M18 34l10 10 18-22" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div><h1>Wedding Build</h1>${small ? "" : `<div class="sub">The planning checklist, built like a construction checklist</div>`}</div>
  </div>`;
}

function authHtml() {
  const signin = state.authMode === "signin";
  return `<div class="auth-wrap"><div class="auth-card">
    ${brandHtml()}
    <div class="auth-tabs">
      <button data-action="auth-mode" data-mode="signin" class="${signin ? "active" : ""}">Sign in</button>
      <button data-action="auth-mode" data-mode="signup" class="${signin ? "" : "active"}">Create account</button>
    </div>
    <form id="authForm" data-mode="${state.authMode}">
      ${signin ? "" : `<div class="field"><label>Your name</label><input name="name" autocomplete="name" placeholder="How the others will see you" required></div>`}
      <div class="field"><label>Email</label><input name="email" type="email" autocomplete="email" required placeholder="you@example.com"></div>
      <div class="field"><label>Password</label><input name="password" type="password" autocomplete="${signin ? "current-password" : "new-password"}" minlength="8" required placeholder="At least 8 characters"></div>
      <button class="btn block" type="submit">${signin ? "Sign in" : "Create account"}</button>
      <div id="authMsg"></div>
    </form>
    <div class="auth-foot">
      <span>${signin ? "If the couple made your account, sign in with the password they gave you." : "Only needed if the couple did not make your account for you. Use the exact email they put on the guest list."}</span>
      ${signin ? `<button class="btn link" data-action="forgot">Forgot password?</button>` : ""}
    </div>
    ${signin ? `<p class="small muted" style="margin:10px 0 0">Forgot it and no email arrives? Any owner can set a new password for you from the People tab.</p>` : ""}
  </div></div>`;
}

function recoveryHtml() {
  return `<div class="auth-wrap"><div class="auth-card">
    ${brandHtml()}
    <h2 style="margin:18px 0 10px;font-size:20px">Set a new password</h2>
    <form id="recoveryForm">
      <div class="field"><label>New password</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <div class="field"><label>Repeat it</label><input name="password2" type="password" minlength="8" required autocomplete="new-password"></div>
      <button class="btn block" type="submit">Save password</button>
      <div id="authMsg"></div>
    </form>
  </div></div>`;
}

function noAccessHtml() {
  return `<div class="auth-wrap"><div class="auth-card">
    ${brandHtml()}
    <div class="msg info" style="margin-top:18px">
      <b>${esc(state.user.email)}</b> is signed in but is not on the guest list yet.
      Ask the couple to add this exact email under <b>People</b>, then reload this page.
    </div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn ghost" data-action="reload">I've been added, reload</button>
      <button class="btn ghost" data-action="signout">Sign out</button>
    </div>
  </div></div>`;
}

function shellHtml() {
  const total = state.items.length;
  const done = state.items.filter((i) => i.done).length;
  const decisions = state.items.filter((i) => i.kind === "decision");
  const decided = decisions.filter((i) => i.choice || i.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const name = state.member.display_name || displayName(state.user.email);
  return `<header class="topbar">
    <div class="topbar-inner">
      ${brandHtml(true)}
      <nav class="nav">${VIEWS.map(([k, label]) => `<button data-action="view" data-view="${k}" class="${state.view === k ? "active" : ""}">${label}</button>`).join("")}</nav>
      <div class="user">
        <div class="avatar" title="${esc(state.user.email)}">${esc(initials(name))}</div>
        <div class="who"><div>${esc(name)}</div><div class="role">${esc(state.member.role)}</div></div>
        <button class="btn ghost sm" data-action="signout">Sign out</button>
      </div>
    </div>
    <div class="progress-strip">
      <span><b>${done}</b> of ${total} items done</span>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <span><b>${decided}</b> of ${decisions.length} decisions made</span>
    </div>
  </header>`;
}

function viewHtml() {
  switch (state.view) {
    case "vendors": return vendorsHtml();
    case "budget": return budgetHtml();
    case "reference": return referenceHtml();
    case "people": return peopleHtml();
    case "activity": return activityHtml();
    default: return checklistHtml();
  }
}

// ---------------------------------------------------------------- checklist
function phaseStats(pid) {
  const items = state.items.filter((i) => i.phase_id === pid);
  const done = items.filter((i) => i.done).length;
  const dec = items.filter((i) => i.kind === "decision");
  const decided = dec.filter((i) => i.choice || i.done).length;
  const todos = items.filter((i) => i.kind === "todo");
  const tdone = todos.filter((i) => i.done).length;
  const overdue = items.filter(isOverdue).length;
  return { total: items.length, done, dec: dec.length, decided, todos: todos.length, tdone, overdue };
}

function itemMatches(it) {
  const f = state.filters;
  if (f.open && it.done) return false;
  if (f.kind !== "all" && it.kind !== f.kind) return false;
  if (f.mine && (it.assignee || "").toLowerCase() !== myEmail()) return false;
  if (f.q) {
    const hay = `${it.title} ${it.category} ${(it.options || []).map((o) => o.label + " " + o.text).join(" ")} ${it.notes || ""}`.toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

function checklistHtml() {
  const phase = state.phases.find((p) => p.id === state.phaseId) || state.phases[0];
  if (!phase) return `<div class="empty">No phases loaded.</div>`;
  const st = phaseStats(phase.id);
  const items = state.items.filter((i) => i.phase_id === phase.id);
  // group by category preserving order
  const cats = [];
  for (const it of items) {
    let c = cats.find((x) => x.name === it.category);
    if (!c) { c = { name: it.category, ord: it.category_ord, items: [] }; cats.push(c); }
    c.items.push(it);
  }
  cats.sort((a, b) => a.ord - b.ord);
  const f = state.filters;
  return `<div class="checklist">
    <aside class="phase-rail">
      ${state.phases.map((p) => {
        const s = phaseStats(p.id);
        const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
        return `<button class="phase-card ${p.id === phase.id ? "active" : ""}" data-action="phase" data-phase="${p.id}">
          <div class="num">Phase ${p.ord}</div>
          <div class="title">${esc(p.title)}</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <div class="meta"><span>${s.done}/${s.total} done</span>${s.overdue ? `<span style="color:var(--red)">${s.overdue} overdue</span>` : `<span>${pct}%</span>`}</div>
        </button>`;
      }).join("")}
    </aside>
    <section>
      <div class="phase-head">
        <div class="num muted small">Phase ${phase.ord} of ${state.phases.length}</div>
        <h2>${esc(phase.title)}</h2>
        <div class="timing">${esc(phase.timing || "")}</div>
        <div class="lead">${md(phase.lead || "")}</div>
        <div class="stats">
          <span><b>${st.decided}</b> of ${st.dec} decisions made</span>
          <span><b>${st.tdone}</b> of ${st.todos} to-dos done</span>
          ${st.overdue ? `<span style="color:var(--red)"><b>${st.overdue}</b> overdue</span>` : ""}
        </div>
      </div>
      <div class="toolbar">
        <input type="search" id="searchBox" placeholder="Search this phase…" value="${esc(f.q)}">
        <button class="chip-toggle ${f.open ? "on" : ""}" data-action="filter" data-key="open">Open only</button>
        <button class="chip-toggle ${f.kind === "decision" ? "on" : ""}" data-action="filter" data-key="kind" data-val="decision">Decisions</button>
        <button class="chip-toggle ${f.kind === "todo" ? "on" : ""}" data-action="filter" data-key="kind" data-val="todo">To-dos</button>
        <button class="chip-toggle ${f.mine ? "on" : ""}" data-action="filter" data-key="mine">Mine</button>
      </div>
      ${cats.map((c) => categoryHtml(phase, c)).join("") || `<div class="empty">Nothing here yet.</div>`}
      ${canEdit() ? addCategoryHtml(phase) : ""}
    </section>
  </div>`;
}

function categoryHtml(phase, c) {
  const visible = c.items.filter(itemMatches);
  if (!visible.length && !(state.adding === `${phase.id}::${c.name}`)) {
    if (state.filters.q || state.filters.open || state.filters.kind !== "all" || state.filters.mine) return "";
  }
  const done = c.items.filter((i) => i.done).length;
  let html = `<div class="category">
    <div class="cat-bar"><h3>${esc(c.name)}</h3><span class="count">${done}/${c.items.length}</span></div>`;
  let lastGroup = Symbol();
  for (const it of visible) {
    const grp = it.kind === "todo" ? (it.group_label || "To do") : null;
    if (grp !== lastGroup) {
      if (grp) html += `<div class="group-label">${esc(grp)}</div>`;
      lastGroup = grp;
    }
    html += itemHtml(it);
  }
  if (!visible.length) html += `<div class="empty small">No items match the filters.</div>`;
  if (canEdit()) {
    const key = `${phase.id}::${c.name}`;
    html += state.adding === key
      ? addFormHtml(phase, c.name)
      : `<div class="add-item"><button class="btn link" data-action="add-start" data-cat="${esc(c.name)}">+ Add an item to ${esc(c.name)}</button></div>`;
  }
  return html + `</div>`;
}

function itemHtml(it) {
  const editable = canEdit();
  const open = state.openDetails.has(it.id);
  if (state.editing === it.id) return `<div class="item">${editFormHtml(it)}</div>`;
  const metaPills = [];
  if (it.kind === "decision" && it.choice) metaPills.push(`<span class="pill choice">Chose: ${esc(it.choice)}</span>`);
  if (it.assignee) metaPills.push(`<span class="pill">${esc(displayName(it.assignee))}</span>`);
  if (it.due_date) metaPills.push(`<span class="pill ${isOverdue(it) ? "overdue" : ""}">Due ${esc(fmtDate(it.due_date))}</span>`);
  if (it.notes && !open) metaPills.push(`<span class="pill" title="${esc(it.notes)}">Note: ${esc(it.notes.length > 70 ? it.notes.slice(0, 70) + "…" : it.notes)}</span>`);
  const stamp = it.updated_by && it.updated_at ? `${esc(displayName(it.updated_by))} · ${relTime(it.updated_at)}` : "";
  const dis = editable ? "" : "disabled";
  return `<div class="item ${it.done ? "done" : ""} ${it.kind}" data-id="${esc(it.id)}">
    <button class="check ${it.done ? "on" : ""}" data-action="toggle" data-id="${esc(it.id)}" ${dis} aria-label="${it.done ? "Mark not done" : "Mark done"}">${it.done ? "✓" : ""}</button>
    <div class="item-body">
      ${it.kind === "decision"
        ? `<div class="item-title"><span class="kind-pill">Decision</span>${esc(it.title)} ${tagsHtml(it.tags)}</div>
           <div class="options">${(it.options || []).map((o) => `<button class="option ${it.choice === o.label ? "on" : ""}" data-action="choose" data-id="${esc(it.id)}" data-label="${esc(o.label)}" ${dis}><span class="radio"></span><span><span class="label">${esc(o.label)}.</span> <span class="text">${md(o.text)}</span></span></button>`).join("")}</div>`
        : `<div class="todo-text">${md(it.title)} ${tagsHtml(it.tags)}</div>`}
      ${metaPills.length ? `<div class="item-meta">${metaPills.join("")}</div>` : ""}
      <div class="item-actions">
        <button data-action="details" data-id="${esc(it.id)}">${open ? "Hide details" : "Details"}</button>
        ${editable ? `<button data-action="edit-start" data-id="${esc(it.id)}">Edit</button>` : ""}
        ${stamp ? `<span class="muted small">${stamp}</span>` : ""}
      </div>
      ${open ? detailsHtml(it) : ""}
    </div>
  </div>`;
}

function detailsHtml(it) {
  const dis = canEdit() ? "" : "disabled";
  const people = state.members.map((m) => `<option value="${esc(m.email)}" ${it.assignee === m.email ? "selected" : ""}>${esc(m.display_name || m.email)}</option>`).join("");
  return `<div class="details" data-id="${esc(it.id)}">
    <div><label class="lbl">Notes (your choice, who you talked to, what it costs)</label>
      <textarea data-field="notes" data-id="${esc(it.id)}" ${dis} placeholder="Type notes here. They save when you click away.">${esc(it.notes || "")}</textarea></div>
    <div class="row">
      <div><label class="lbl">Who owns it</label>
        <select data-field="assignee" data-id="${esc(it.id)}" ${dis}><option value="">Unassigned</option>${people}</select></div>
      <div><label class="lbl">Due</label>
        <input type="date" data-field="due_date" data-id="${esc(it.id)}" value="${esc(it.due_date || "")}" ${dis}></div>
    </div>
    <div class="foot">
      <span>${it.kind === "decision" && it.choice && canEdit() ? `<button class="btn link" data-action="clear-choice" data-id="${esc(it.id)}">Clear the choice</button>` : ""}</span>
      <span>${it.updated_by ? `Last change ${esc(displayName(it.updated_by))} · ${relTime(it.updated_at)}` : ""}</span>
    </div>
  </div>`;
}

function addCategoryHtml(phase) {
  const key = `${phase.id}::__new__`;
  if (state.adding === key) return `<div class="category"><div class="cat-bar"><h3>New category</h3></div>${addFormHtml(phase, null)}</div>`;
  return `<div class="add-item" style="border:0;padding-left:0"><button class="btn ghost sm" data-action="add-start" data-cat="__new__">+ Add a new category to Phase ${phase.ord}</button></div>`;
}

function addFormHtml(phase, catName) {
  const isNew = catName === null;
  return `<div class="add-item"><form class="add-form" id="addForm" data-phase="${phase.id}" data-cat="${esc(catName ?? "")}">
    ${isNew ? `<div class="row"><label>Category</label><input name="category" required placeholder="e.g. Honeymoon logistics"></div>` : ""}
    <div class="row"><label>Kind</label><select name="kind" data-action="kind-switch"><option value="todo">To-do (a task, no choice)</option><option value="decision">Decision (options with trade-offs)</option></select></div>
    <div class="row"><label>Title</label><input name="title" required placeholder="${isNew ? "First item" : "What needs deciding or doing"}"></div>
    <div class="row opt-row hidden"><label>Options</label><div><textarea name="options" placeholder="Label | what it buys you and what it costs you&#10;Second label | its trade-off"></textarea><div class="hint">One option per line. Put a vertical bar between the short label and the trade-off.</div></div></div>
    <div class="row"><label>Tags</label><input name="tags" placeholder="Optional: R K $ L S (space separated)"></div>
    <div class="actions"><button type="button" class="btn ghost sm" data-action="add-cancel">Cancel</button><button class="btn sm" type="submit">Add</button></div>
  </form></div>`;
}

function editFormHtml(it) {
  const opts = (it.options || []).map((o) => `${o.label} | ${o.text}`).join("\n");
  return `<form class="add-form" id="editForm" data-id="${esc(it.id)}" style="grid-column:1 / -1">
    <div class="row"><label>Kind</label><select name="kind" data-action="kind-switch"><option value="todo" ${it.kind === "todo" ? "selected" : ""}>To-do</option><option value="decision" ${it.kind === "decision" ? "selected" : ""}>Decision</option></select></div>
    <div class="row"><label>Title</label><input name="title" required value="${esc(it.title)}"></div>
    <div class="row opt-row ${it.kind === "decision" ? "" : "hidden"}"><label>Options</label><div><textarea name="options">${esc(opts)}</textarea><div class="hint">One option per line: Label | trade-off. Changing a label clears a saved choice that used the old label.</div></div></div>
    <div class="row"><label>Tags</label><input name="tags" value="${esc((it.tags || []).join(" "))}" placeholder="R K $ L S"></div>
    <div class="actions">
      <button type="button" class="btn danger sm" data-action="delete-item" data-id="${esc(it.id)}">Delete item</button>
      <span style="flex:1"></span>
      <button type="button" class="btn ghost sm" data-action="edit-cancel">Cancel</button>
      <button class="btn sm" type="submit">Save</button>
    </div>
  </form>`;
}

function parseOptions(text) {
  return (text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [label, ...rest] = l.split("|");
    return { label: label.trim().replace(/\.$/, ""), text: rest.join("|").trim() };
  }).filter((o) => o.label);
}
const parseTags = (text) => (text || "").split(/[\s,]+/).map((t) => t.trim().replace(/[()]/g, "")).filter((t) => ["R", "K", "$", "L", "S"].includes(t));

// ---------------------------------------------------------------- vendors
function vendorsHtml() {
  const v = state.vendors;
  const unpaid = v.filter((r) => !r.paid && r.balance);
  const upcoming = unpaid.filter((r) => r.balance_due).sort((a, b) => a.balance_due.localeCompare(b.balance_due)).slice(0, 8);
  const cols = [
    ["role", "Role", "wide"], ["company", "Company", "wide"], ["contact", "Contact", ""], ["phone", "Phone", ""], ["email", "Email", "wide"],
    ["arrival_time", "Arrival", ""], ["deposit", "Deposit", "num"], ["deposit_date", "Deposit date", "date"], ["balance", "Balance", "num"],
    ["balance_due", "Balance due", "date"], ["paid", "Paid", "bool"], ["tip", "Tip", "num"], ["notes", "Notes", "wide"],
  ];
  return `<div class="panel">
    <div class="panel-head"><div><h2>Vendors & Payments</h2><p class="intro">Every vendor on one sheet: who, when they arrive, what is owed and when. Click any cell to edit. It saves when you click away.</p></div>
      ${canEdit() ? `<button class="btn sm" data-action="vendor-add">+ Add vendor</button>` : ""}</div>
    <div class="summary-row">
      <div class="stat"><div class="k">Deposits paid</div><div class="v">${money(sum(v, "deposit")) || "$0"}</div></div>
      <div class="stat"><div class="k">Balances still owed</div><div class="v">${money(sum(unpaid, "balance")) || "$0"}</div></div>
      <div class="stat"><div class="k">Tips planned</div><div class="v">${money(sum(v, "tip")) || "$0"}</div></div>
      <div class="stat"><div class="k">Vendors</div><div class="v">${v.filter((r) => r.company).length} booked / ${v.length}</div></div>
    </div>
    ${upcoming.length ? `<h3 style="font-size:15px;margin:6px 0 8px">Next payments due</h3><div class="due-list" style="margin-bottom:16px">${upcoming.map((r) => `<div class="due ${r.balance_due < todayISO() ? "overdue" : ""}"><span>${esc(r.company || r.role || "Vendor")}${r.company && r.role ? ` <span class="muted">· ${esc(r.role)}</span>` : ""}</span><span><b>${money(r.balance)}</b> · ${esc(fmtDate(r.balance_due))}</span></div>`).join("")}</div>` : ""}
    <div class="table-wrap"><table>
      <thead><tr>${cols.map(([k, label, cls]) => `<th class="${cls === "num" ? "num" : ""}">${label}</th>`).join("")}${canEdit() ? "<th></th>" : ""}</tr></thead>
      <tbody>${v.map((r) => `<tr data-id="${r.id}">${cols.map(([k, , cls]) => `<td class="${cls === "num" ? "num" : ""}">${cellInput("vendors", r, k, cls)}</td>`).join("")}${canEdit() ? `<td><button class="row-del" data-action="row-del" data-table="vendors" data-id="${r.id}" title="Remove">×</button></td>` : ""}</tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="6">Totals</td><td class="num">${money(sum(v, "deposit"))}</td><td></td><td class="num">${money(sum(v, "balance"))}</td><td></td><td></td><td class="num">${money(sum(v, "tip"))}</td><td></td>${canEdit() ? "<td></td>" : ""}</tr></tfoot>
    </table></div>
  </div>`;
}

function cellInput(table, row, key, cls) {
  const dis = canEdit() ? "" : "disabled";
  const val = row[key];
  if (cls === "bool") return `<input type="checkbox" data-table="${table}" data-id="${row.id}" data-field="${key}" ${val ? "checked" : ""} ${dis} style="width:18px;height:18px;margin:6px">`;
  if (cls === "num") return `<input class="cell-input num" type="number" step="0.01" inputmode="decimal" data-table="${table}" data-id="${row.id}" data-field="${key}" value="${val ?? ""}" ${dis}>`;
  if (cls === "date") return `<input class="cell-input date" type="date" data-table="${table}" data-id="${row.id}" data-field="${key}" value="${esc(val || "")}" ${dis}>`;
  return `<input class="cell-input ${cls}" type="text" data-table="${table}" data-id="${row.id}" data-field="${key}" value="${esc(val || "")}" ${dis}>`;
}

// ---------------------------------------------------------------- budget
function budgetHtml() {
  const b = state.budget;
  const cols = [["category", "Category", "wide"], ["typical_share", "Typical share", ""], ["estimate", "Estimate", "num"], ["deposit_paid", "Deposit paid", "num"], ["balance_due", "Balance due", "num"], ["actual", "Actual", "num"]];
  const est = sum(b, "estimate"), act = sum(b, "actual");
  return `<div class="panel">
    <div class="panel-head"><div><h2>Budget</h2><p class="intro">Typical shares are planning ranges for a large Orthodox wedding in the New York area, not quotes. Replace them with your numbers as contracts come in. Click a cell to edit.</p></div>
      ${canEdit() ? `<button class="btn sm" data-action="budget-add">+ Add line</button>` : ""}</div>
    <div class="summary-row">
      <div class="stat"><div class="k">Total estimate</div><div class="v">${money(est) || "$0"}</div></div>
      <div class="stat"><div class="k">Deposits paid</div><div class="v">${money(sum(b, "deposit_paid")) || "$0"}</div></div>
      <div class="stat"><div class="k">Balance due</div><div class="v">${money(sum(b, "balance_due")) || "$0"}</div></div>
      <div class="stat"><div class="k">Actual so far</div><div class="v">${money(act) || "$0"}${est && act ? ` <span class="small muted">(${Math.round((act / est) * 100)}% of estimate)</span>` : ""}</div></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>${cols.map(([k, label, cls]) => `<th class="${cls === "num" ? "num" : ""}">${label}</th>`).join("")}${canEdit() ? "<th></th>" : ""}</tr></thead>
      <tbody>${b.map((r) => `<tr data-id="${r.id}">${cols.map(([k, , cls]) => `<td class="${cls === "num" ? "num" : ""}">${cellInput("budget", r, k, cls)}</td>`).join("")}${canEdit() ? `<td><button class="row-del" data-action="row-del" data-table="budget" data-id="${r.id}" title="Remove">×</button></td>` : ""}</tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="2">Totals</td><td class="num">${money(est)}</td><td class="num">${money(sum(b, "deposit_paid"))}</td><td class="num">${money(sum(b, "balance_due"))}</td><td class="num">${money(act)}</td>${canEdit() ? "<td></td>" : ""}</tr></tfoot>
    </table></div>
  </div>`;
}

// ---------------------------------------------------------------- reference
function refTable(rows, opts = {}) {
  if (!rows?.length) return "";
  const [head, ...body] = rows;
  return `<div class="table-wrap"><table class="ref-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${body.map((r) => `<tr>${r.map((c, i) => `<td>${opts.status && i === 2 ? statusHtml(c) : md(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function statusHtml(c) {
  const cls = /^Open/.test(c) ? "status-open" : /^Closed/.test(c) ? "status-closed" : "status-mostly";
  return `<span class="${cls}">${esc(c)}</span>`;
}
function referenceHtml() {
  const R = REFERENCE;
  return `
  <div class="panel"><h2>How the checklist works</h2>
    <p class="intro">Decision items list every option with what it buys you and what it costs you. Nothing is a default. To-do groups hold the tasks that need no choice, only a deadline. Halachic requirements are tagged (R) because the rav's ruling is the spec, not a selection.</p>
    <ul>${R.legend.map((l) => `<li><span class="tag ${tagClass(l.tag)}">${esc(l.tag)}</span> ${esc(l.text)}</li>`).join("")}</ul>
    <h3 style="font-size:15px;margin:12px 0 8px">Phase timing</h3>${refTable(R.phase_timing)}
  </div>
  <div class="panel"><h2>2027 halachic calendar</h2>
    <p class="intro">Open and closed windows for a chuppah in 2027. Sefirah and Three Weeks boundaries follow common Ashkenazi practice and are the rav's call.</p>
    ${refTable(R.calendar, { status: true })}
    <p class="small muted" style="margin:10px 0 0">${md(R.calendar_source)}</p>
  </div>
  <div class="panel"><h2>Run of show template</h2>
    <p class="intro">A Sunday with a 6:30 PM chuppah. Shift every row by the same amount for your time and swap in your Phase 2 and Phase 3 choices where a row names an option.</p>
    ${refTable(R.run_of_show)}
  </div>
  <div class="panel"><h2>Headcount and quantities</h2>${refTable(R.headcount)}</div>
  <div class="panel"><h2>Packing lists</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px">
    ${Object.entries(R.packing).map(([k, list]) => `<div><h3 style="font-size:15px;margin-bottom:6px">${esc(k)}</h3><ul style="margin:0;padding-left:18px">${list.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`).join("")}
    </div>
  </div>
  <div class="panel"><h2>Sheva brachot week</h2><p class="intro">Seven meals, each with a minyan and at least one panim chadashot. Track the actual schedule as notes on the Phase 8 items.</p>${refTable(R.sheva)}</div>
  <div class="panel"><h2>Sources</h2>
    <ul>${R.resources.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>: ${esc(r.note)}</li>`).join("")}</ul>
    <p class="small muted">Halachic items describe common Ashkenazi practice in the New York area. Your mesader kiddushin's ruling governs wherever this checklist and his practice differ.</p>
  </div>`;
}

// ---------------------------------------------------------------- people
function peopleHtml() {
  const owner = isOwner();
  return `<div class="panel">
    <h2>People</h2>
    <p class="intro">Everyone on this list can sign in and see the build. <b>Owners</b> manage this list and accounts. <b>Editors</b> can check, choose, add, and edit. <b>Viewers</b> can see everything but change nothing.</p>
    ${owner ? `<div class="msg info" style="margin:0 0 14px">The easiest way to bring someone in: fill in their email, name, role, and a starter password, then send them this page's link and the password. Their account is ready immediately, no confirmation email. Leave the password blank to only add them to the list, in which case they create their own account with that exact email.</div>
    <form id="inviteForm" class="invite" style="margin-bottom:16px">
      <div class="field"><label>Email</label><input name="email" type="email" required placeholder="name@example.com"></div>
      <div class="field"><label>Name</label><input name="name" required placeholder="How they appear in the app"></div>
      <div class="field"><label>Role</label><select name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="owner">Owner</option></select></div>
      <div class="field"><label>Starter password (optional)</label><input name="password" type="text" minlength="8" autocomplete="off" placeholder="At least 8 characters"></div>
      <button class="btn" type="submit">Add</button>
    </form>` : ""}
    <div class="member-list">${state.members.map((m) => `<div class="member">
      <div class="avatar">${esc(initials(m.display_name || m.email))}</div>
      <div><div class="name">${esc(m.display_name || m.email)} ${m.email === myEmail() ? '<span class="muted small">(you)</span>' : ""}</div><div class="email">${esc(m.email)}</div>
        ${state.pwFor === m.email ? `<form class="pw-form" data-email="${esc(m.email)}" style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <input name="password" type="text" minlength="8" required autocomplete="off" placeholder="New password, 8+ characters" style="padding:6px 8px;border:1px solid var(--line-2);border-radius:6px;flex:1;min-width:200px">
            <button class="btn sm" type="submit">Save</button><button class="btn ghost sm" type="button" data-action="pw-cancel">Cancel</button>
          </form>` : ""}
      </div>
      <div class="member-controls">
        ${owner && m.email !== myEmail()
          ? `<select data-action="role-change" data-email="${esc(m.email)}"><option value="owner" ${m.role === "owner" ? "selected" : ""}>Owner</option><option value="editor" ${m.role === "editor" ? "selected" : ""}>Editor</option><option value="viewer" ${m.role === "viewer" ? "selected" : ""}>Viewer</option></select>
             <button class="btn ghost sm" data-action="pw-start" data-email="${esc(m.email)}">Set password</button>
             <button class="btn danger sm" data-action="member-remove" data-email="${esc(m.email)}">Remove</button>`
          : `<span class="role-badge ${m.role}">${esc(m.role)}</span>`}
      </div>
    </div>`).join("")}</div>
  </div>
  <div class="panel">
    <h2>Your account</h2>
    <p class="intro">Signed in as <b>${esc(state.user.email)}</b>. Change your password here any time. If you forget it, an owner can set a new one for you from the list above.</p>
    <form id="myPwForm" class="invite" style="grid-template-columns:1fr 1fr auto">
      <div class="field"><label>New password</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <div class="field"><label>Repeat it</label><input name="password2" type="password" minlength="8" required autocomplete="new-password"></div>
      <button class="btn ghost" type="submit">Change password</button>
    </form>
  </div>`;
}

async function manageMembers(body) {
  const { data, error } = await sb.functions.invoke("manage-members", { body });
  if (error) {
    let msg = error.message || "Request failed";
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ---------------------------------------------------------------- activity
function activityHtml() {
  if (!state.activity.length) return `<div class="panel"><h2>Activity</h2><div class="empty">Nothing yet. Check an item or make a choice and it shows up here for everyone.</div></div>`;
  return `<div class="panel"><h2>Activity</h2><p class="intro">What everyone has changed, newest first.</p>
    <div class="feed">${state.activity.map((e) => {
      const who = displayName(e.actor);
      let line;
      switch (e.action) {
        case "checked": line = `checked <b>${esc(e.target)}</b>`; break;
        case "unchecked": line = `unchecked <b>${esc(e.target)}</b>`; break;
        case "chose": line = `chose <b>${esc(e.detail)}</b> for ${esc(e.target)}`; break;
        case "noted": line = `added a note on <b>${esc(e.target)}</b>`; break;
        case "assigned": line = `assigned <b>${esc(e.target)}</b> to ${esc(displayName(e.detail))}`; break;
        case "set a due date": line = `set <b>${esc(e.target)}</b> due ${esc(fmtDate(e.detail))}`; break;
        case "added": line = `added <b>${esc(e.target)}</b>${e.detail && !/^p\d$/.test(e.detail) ? ` (${esc(e.detail)})` : ""}`; break;
        case "removed": line = `removed <b>${esc(e.target)}</b>`; break;
        case "updated": line = `updated <b>${esc(e.target)}</b> (${esc(e.detail)})`; break;
        default: line = `${esc(e.action)} <b>${esc(e.target || "")}</b>`;
      }
      return `<div class="event"><div class="avatar" style="width:28px;height:28px;font-size:11px">${esc(initials(who))}</div>
        <div><b>${esc(who)}</b> ${line}${e.action === "noted" && e.detail ? `<div class="detail">${esc(e.detail)}</div>` : ""}</div>
        <div class="when" title="${esc(new Date(e.at).toLocaleString())}">${relTime(e.at)}</div></div>`;
    }).join("")}</div></div>`;
}

// ---------------------------------------------------------------- data ops
async function updateItem(id, patch) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  const before = { ...it };
  Object.assign(it, patch, { updated_by: myEmail(), updated_at: new Date().toISOString() });
  render();
  const { error } = await sb.from("items").update(patch).eq("id", id);
  if (error) { Object.assign(it, before); render(); dbError(error, "Saving"); }
}
async function insertRow(table, row) {
  const { data, error } = await sb.from(table).insert(row).select().single();
  if (error) { dbError(error, "Adding"); return null; }
  const arr = state[table];
  if (!arr.find((r) => r.id === data.id)) arr.push(data);
  if (table === "items") sortItems();
  render();
  return data;
}
async function updateRow(table, id, patch) {
  const arr = state[table];
  const r = arr.find((x) => x.id === id);
  if (r) Object.assign(r, patch);
  const { error } = await sb.from(table).update(patch).eq("id", id);
  if (error) dbError(error, "Saving");
  else if (state.view !== "checklist") scheduleRender();
}
async function deleteRow(table, id) {
  const arr = state[table];
  const i = arr.findIndex((x) => x.id === id);
  const backup = i >= 0 ? arr.splice(i, 1)[0] : null;
  render();
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) { if (backup) arr.splice(i, 0, backup); render(); dbError(error, "Removing"); }
}

// ---------------------------------------------------------------- events
$app.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const a = btn.dataset.action;
  const id = btn.dataset.id;
  switch (a) {
    case "auth-mode": state.authMode = btn.dataset.mode; render(); break;
    case "forgot": {
      const email = document.querySelector('#authForm [name=email]')?.value?.trim();
      if (!email) { setAuthMsg("Type your email first, then click Forgot password.", "err"); return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      setAuthMsg(error ? error.message : "If that email is registered, a reset link is on its way.", error ? "err" : "ok");
      break;
    }
    case "signout": await sb.auth.signOut(); break;
    case "reload": location.reload(); break;
    case "view": state.view = btn.dataset.view; localStorage.setItem("wb.view", state.view); state.adding = null; state.editing = null; render(); window.scrollTo({ top: 0 }); break;
    case "phase": state.phaseId = btn.dataset.phase; localStorage.setItem("wb.phase", state.phaseId); state.adding = null; state.editing = null; render(); break;
    case "filter": {
      const k = btn.dataset.key;
      if (k === "kind") state.filters.kind = state.filters.kind === btn.dataset.val ? "all" : btn.dataset.val;
      else state.filters[k] = !state.filters[k];
      render(); break;
    }
    case "toggle": {
      if (!canEdit()) return;
      const it = state.items.find((x) => x.id === id);
      await updateItem(id, { done: !it.done });
      break;
    }
    case "choose": {
      if (!canEdit()) return;
      const it = state.items.find((x) => x.id === id);
      const label = btn.dataset.label;
      if (it.choice === label) await updateItem(id, { choice: null, done: false });
      else await updateItem(id, { choice: label, done: true });
      break;
    }
    case "clear-choice": await updateItem(id, { choice: null, done: false }); break;
    case "details": state.openDetails.has(id) ? state.openDetails.delete(id) : state.openDetails.add(id); render(); break;
    case "add-start": state.adding = `${state.phaseId}::${btn.dataset.cat}`; state.editing = null; render(); document.querySelector("#addForm input[name=title], #addForm input[name=category]")?.focus(); break;
    case "add-cancel": state.adding = null; render(); break;
    case "edit-start": state.editing = id; state.adding = null; render(); break;
    case "edit-cancel": state.editing = null; render(); break;
    case "delete-item": {
      const it = state.items.find((x) => x.id === id);
      if (!confirm(`Delete "${it.title}"? This removes it for everyone.`)) return;
      state.editing = null;
      await deleteRow("items", id);
      break;
    }
    case "vendor-add": await insertRow("vendors", { role: "", ord: (Math.max(0, ...state.vendors.map((v) => v.ord || 0)) + 1) }); break;
    case "budget-add": await insertRow("budget", { category: "New line", ord: (Math.max(0, ...state.budget.map((v) => v.ord || 0)) + 1) }); break;
    case "row-del": {
      const table = btn.dataset.table;
      const r = state[table].find((x) => x.id === id);
      const label = table === "vendors" ? (r?.company || r?.role || "this vendor") : (r?.category || "this line");
      if (!confirm(`Remove ${label}?`)) return;
      await deleteRow(table, id);
      break;
    }
    case "member-remove": {
      const email = btn.dataset.email;
      if (!confirm(`Remove ${email} from the guest list and delete their account? They lose access immediately.`)) return;
      btn.disabled = true;
      try {
        await manageMembers({ action: "delete", email });
        const i = state.members.findIndex((m) => m.email === email);
        if (i >= 0) state.members.splice(i, 1);
        render();
        toast(`${displayName(email)} removed`);
      } catch (err) {
        btn.disabled = false;
        toast(`Removing failed: ${err.message}`, "err");
      }
      break;
    }
    case "pw-start": state.pwFor = btn.dataset.email; render(); document.querySelector(".pw-form input")?.focus(); break;
    case "pw-cancel": state.pwFor = null; render(); break;
  }
});

$app.addEventListener("change", async (e) => {
  const el = e.target;
  // checklist details
  if (el.dataset.field && el.closest(".details")) {
    const id = el.dataset.id;
    let val = el.value;
    if (el.dataset.field === "due_date") val = val || null;
    if (el.dataset.field === "assignee") val = val || null;
    if (el.dataset.field === "notes") val = val.trim() || null;
    const it = state.items.find((x) => x.id === id);
    if (it && (it[el.dataset.field] || null) === val) return;
    const patch = { [el.dataset.field]: val };
    Object.assign(it, patch, { updated_by: myEmail(), updated_at: new Date().toISOString() });
    const { error } = await sb.from("items").update(patch).eq("id", id);
    if (error) dbError(error, "Saving"); else toast("Saved");
    return;
  }
  // vendor / budget cells
  if (el.dataset.table && el.dataset.field) {
    let val;
    if (el.type === "checkbox") val = el.checked;
    else if (el.type === "number") val = el.value === "" ? null : Number(el.value);
    else val = el.value === "" ? null : el.value;
    await updateRow(el.dataset.table, el.dataset.id, { [el.dataset.field]: val });
    return;
  }
  if (el.dataset.action === "role-change") {
    const email = el.dataset.email;
    const m = state.members.find((x) => x.email === email);
    const prev = m.role; m.role = el.value;
    const { error } = await sb.from("members").update({ role: el.value }).eq("email", email);
    if (error) { m.role = prev; render(); dbError(error, "Changing role"); } else toast(`${displayName(email)} is now ${el.value}`);
    return;
  }
  if (el.dataset.action === "kind-switch") {
    const row = el.closest("form").querySelector(".opt-row");
    row.classList.toggle("hidden", el.value !== "decision");
  }
});

$app.addEventListener("input", (e) => {
  if (e.target.id === "searchBox") {
    state.filters.q = e.target.value;
    // re-render only the categories; keep the search box focused
    const section = $app.querySelector(".checklist > section");
    if (!section) return;
    const pos = e.target.selectionStart;
    render();
    const box = document.getElementById("searchBox");
    if (box) { box.focus(); box.setSelectionRange(pos, pos); }
  }
});

$app.addEventListener("submit", async (e) => {
  const form = e.target;
  e.preventDefault();
  if (form.id === "authForm") {
    const fd = new FormData(form);
    const email = String(fd.get("email")).trim().toLowerCase();
    const password = String(fd.get("password"));
    setBusy(form, true);
    if (form.dataset.mode === "signin") {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) setAuthMsg(error.message, "err");
    } else {
      const name = String(fd.get("name")).trim();
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: location.origin + location.pathname } });
      if (error) setAuthMsg(error.message, "err");
      else if (!data.session) setAuthMsg("Account created. Click the confirmation link in your email, then come back to this page and sign in. If the page the link opens does not load, the confirmation still went through.", "ok");
      else {
        // record the display name on the guest list if the owner left it blank
        const { data: m } = await sb.from("members").select("*").eq("email", email).maybeSingle();
        if (m && !m.display_name) await sb.from("members").update({ display_name: name }).eq("email", email);
      }
    }
    setBusy(form, false);
    return;
  }
  if (form.id === "recoveryForm") {
    const fd = new FormData(form);
    if (fd.get("password") !== fd.get("password2")) { setAuthMsg("The two passwords do not match.", "err"); return; }
    setBusy(form, true);
    const { error } = await sb.auth.updateUser({ password: String(fd.get("password")) });
    setBusy(form, false);
    if (error) { setAuthMsg(error.message, "err"); return; }
    state.recovery = false;
    toast("Password saved");
    history.replaceState(null, "", location.pathname);
    await enter();
    return;
  }
  if (form.id === "inviteForm") {
    const fd = new FormData(form);
    const email = String(fd.get("email")).trim().toLowerCase();
    const role = String(fd.get("role"));
    const display_name = String(fd.get("name")).trim();
    const password = String(fd.get("password") || "");
    setBusy(form, true);
    try {
      if (password) {
        if (password.length < 8) throw new Error("The starter password needs at least 8 characters");
        await manageMembers({ action: "create", email, password, display_name, role });
        const { data } = await sb.from("members").select("*").eq("email", email).maybeSingle();
        if (data) {
          const i = state.members.findIndex((m) => m.email === email);
          if (i >= 0) state.members[i] = data; else state.members.push(data);
        }
        render();
        toast(`Account ready for ${display_name}. Send them the link and the password.`);
      } else {
        const row = { email, role, display_name, added_by: myEmail() };
        const { data, error } = await sb.from("members").upsert(row).select().single();
        if (error) throw error;
        const i = state.members.findIndex((m) => m.email === data.email);
        if (i >= 0) state.members[i] = data; else state.members.push(data);
        render();
        toast(`${data.display_name} added as ${data.role}. They can create their own account with that email.`);
      }
    } catch (err) {
      setBusy(form, false);
      toast(`Adding failed: ${err.message}`, "err");
    }
    return;
  }
  if (form.classList.contains("pw-form")) {
    const fd = new FormData(form);
    const email = form.dataset.email;
    setBusy(form, true);
    try {
      await manageMembers({ action: "reset_password", email, password: String(fd.get("password")) });
      state.pwFor = null;
      render();
      toast(`New password set for ${displayName(email)}`);
    } catch (err) {
      setBusy(form, false);
      toast(`Setting the password failed: ${err.message}`, "err");
    }
    return;
  }
  if (form.id === "myPwForm") {
    const fd = new FormData(form);
    if (fd.get("password") !== fd.get("password2")) { toast("The two passwords do not match.", "err"); return; }
    setBusy(form, true);
    const { error } = await sb.auth.updateUser({ password: String(fd.get("password")) });
    setBusy(form, false);
    if (error) { toast(`Could not change the password: ${error.message}`, "err"); return; }
    form.reset();
    toast("Your password is changed");
    return;
  }
  if (form.id === "addForm") {
    const fd = new FormData(form);
    const phaseId = form.dataset.phase;
    const existingCat = form.dataset.cat;
    const category = existingCat || String(fd.get("category")).trim();
    if (!category) return;
    const inPhase = state.items.filter((i) => i.phase_id === phaseId);
    const sameCat = inPhase.filter((i) => i.category === category);
    const category_ord = sameCat[0]?.category_ord ?? (Math.max(0, ...inPhase.map((i) => i.category_ord)) + 1);
    const kind = String(fd.get("kind"));
    const row = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      phase_id: phaseId, category, category_ord,
      ord: Math.max(0, ...sameCat.map((i) => i.ord)) + 1,
      kind, title: String(fd.get("title")).trim(),
      tags: parseTags(fd.get("tags")),
      options: kind === "decision" ? parseOptions(fd.get("options")) : [],
      group_label: kind === "todo" ? "Added by " + displayName(myEmail()) : null,
    };
    if (kind === "decision" && row.options.length < 2) { toast("A decision needs at least two options.", "err"); return; }
    state.adding = null;
    await insertRow("items", row);
    toast("Added");
    return;
  }
  if (form.id === "editForm") {
    const fd = new FormData(form);
    const id = form.dataset.id;
    const it = state.items.find((x) => x.id === id);
    const kind = String(fd.get("kind"));
    const options = kind === "decision" ? parseOptions(fd.get("options")) : [];
    if (kind === "decision" && options.length < 2) { toast("A decision needs at least two options.", "err"); return; }
    const patch = { kind, title: String(fd.get("title")).trim(), tags: parseTags(fd.get("tags")), options };
    if (it.choice && !options.find((o) => o.label === it.choice)) patch.choice = null;
    state.editing = null;
    await updateItem(id, patch);
    toast("Saved");
  }
});

function setAuthMsg(text, kind) {
  const el = document.getElementById("authMsg");
  if (el) el.innerHTML = `<div class="msg ${kind}">${esc(text)}</div>`;
}
function setBusy(form, busy) {
  form.querySelectorAll("button[type=submit]").forEach((b) => { b.disabled = busy; });
}

init().catch((err) => {
  console.error(err);
  $app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h2>Could not start</h2><p class="muted">${esc(err.message || err)}</p><button class="btn" data-action="reload">Reload</button></div></div>`;
});
