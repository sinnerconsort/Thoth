/* =============================================================================
 * Palimpsest v0.3.0  —  standalone gamebook shell for SillyTavern
 * -----------------------------------------------------------------------------
 * v0.3.0 — THE NODE LIFT
 *   - Story content moved OUT of code into ./story.json. Edit the story without
 *     touching index.js. Loaded via import.meta.url so the path is correct no
 *     matter where the folder is installed; cache-busted so a fresh edit shows
 *     up on reload instead of being served stale.
 *   - Malformed/edited JSON no longer dies silent: validateStory() reports what
 *     is wrong in a toast, and a built-in FALLBACK_STORY keeps the shell alive.
 *   - FULL EFFECTS VOCABULARY locked NOW (before emergent/dice arrive) so every
 *     future producer just pours into one socket — applyEffects():
 *         vars:{name:delta}  give:[id]  take:[id]
 *         setFlag:[f]  clearFlag:[f]  addStatus:[id]  removeStatus:[id]
 *     REQUIRES vocabulary (the gate): { item } | { flag } | { status } | { var:[name,op,val] }
 *   - statuses are a data row in story.json ({label, boosts:{var:+/-N}}); one
 *     statusModifier() sums them. That's the hook the resolve/dice seam will
 *     read later — built once, here, as a field + a function. No status engine.
 *
 * Carried intact from v0.2.2: inline-pinned takeover overlay (immune to theme
 * transforms), 100vw/100vh, three entry points, receipts, per-chat state.
 * ========================================================================== */

const NS = "palimpsest";
const Z  = 31000;
let DEBUG = true;            // <- set false once happy; gates diagnostic toasts
const VER = '0.4.0';

function getCtx() {
    try { return SillyTavern.getContext(); }
    catch (e) { return window.SillyTavern?.getContext?.() || null; }
}
function dbg(msg) { if (DEBUG) try { toastr.info(msg, 'Palimpsest'); } catch (e) {} }
function err(msg) { try { toastr.error(msg, 'Palimpsest', { timeOut: 9000 }); } catch (e) {} }
function warn(msg){ try { toastr.warning(msg, 'Palimpsest', { timeOut: 9000 }); } catch (e) {} }

/* ----------------------------------------------------------------------------
 * STORY (data) — loaded from story.json, never hardcoded.
 * -------------------------------------------------------------------------- */
let STORY = null;

const FALLBACK_STORY = {
    title: 'Fallback', start: 'start',
    initial: { vars: {}, inventory: [], flags: {}, statuses: [] },
    items: {}, statuses: {},
    nodes: { start: { id: 'start', mode: 'authored', location: 'story.json failed to load',
        prose: 'The shell is running, but the story file could not be read or parsed. Check the toast for the reason, fix story.json, and use Settings → Reload story.json.',
        image: null, choices: [] } },
};

async function loadStory() {
    try {
        const url = new URL('./story.json', import.meta.url);
        url.searchParams.set('t', Date.now());          // cache-bust every load
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching story.json');
        const data = JSON.parse(await res.text());      // throws on malformed JSON
        if (!data || typeof data !== 'object' || !data.nodes || !data.nodes[data.start]) {
            throw new Error('missing "nodes" or "start" does not point to a real node');
        }
        const issues = validateStory(data);             // soft issues -> warn, still load
        STORY = data;
        if (issues.length) warn('story.json loaded with ' + issues.length + ' issue(s): ' + issues.slice(0, 3).join(' | '));
        return true;
    } catch (e) {
        STORY = FALLBACK_STORY;
        err('story.json problem: ' + (e?.message || e) + ' — using fallback.');
        return false;
    }
}

/* Light validation: catches the edits that would silently break navigation. */
function validateStory(s) {
    const issues = [];
    const items = s.items || {}, statuses = s.statuses || {}, nodes = s.nodes || {};
    for (const [nid, node] of Object.entries(nodes)) {
        if (typeof node.prose !== 'string') issues.push(nid + ': no prose');
        if (!Array.isArray(node.choices))   { issues.push(nid + ': no choices array'); continue; }
        node.choices.forEach((ch, i) => {
            const where = nid + ' choice ' + (i + 1);
            if (ch.goto && !nodes[ch.goto]) issues.push(where + ': goto "' + ch.goto + '" is not a node');
            const r = ch.requires || {};
            if (r.item && !items[r.item])           issues.push(where + ': requires unknown item "' + r.item + '"');
            if (r.status && !statuses[r.status])    issues.push(where + ': requires unknown status "' + r.status + '"');
            const fx = ch.effects || {};
            (fx.give || []).concat(fx.take || []).forEach(id => { if (!items[id]) issues.push(where + ': effect item "' + id + '" not in items'); });
            (fx.addStatus || []).concat(fx.removeStatus || []).forEach(id => { if (!statuses[id]) issues.push(where + ': effect status "' + id + '" not in statuses'); });
        });
    }
    return issues;
}

/* convenience accessors */
const nodeById  = id => (STORY?.nodes || {})[id];
const itemName  = id => (STORY?.items || {})[id] || id;
const statusDef = id => (STORY?.statuses || {})[id] || { label: id, boosts: {} };

/* ----------------------------------------------------------------------------
 * STATE (per-chat) — derived from STORY.initial, mirrored to chat_metadata.
 * -------------------------------------------------------------------------- */
const FRESH = () => JSON.parse(JSON.stringify({
    current:   STORY?.start || 'start',
    vars:      STORY?.initial?.vars || {},
    flags:     STORY?.initial?.flags || {},
    inventory: STORY?.initial?.inventory || [],
    statuses:  STORY?.initial?.statuses || [],
    history:   [],
}));
let state = FRESH();

function loadState() {
    const c = getCtx();
    const saved = c?.chat_metadata?.[NS];
    state = saved ? Object.assign(FRESH(), saved) : FRESH();
    if (!nodeById(state.current)) state.current = STORY?.start || 'start';   // story changed under us
}
function persist() {
    const c = getCtx(); if (!c) return;
    c.chat_metadata = c.chat_metadata || {};
    c.chat_metadata[NS] = state;
    if (typeof c.saveMetadata === 'function') c.saveMetadata();
    else if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
}

async function commitReceipt(node, choiceLabel) {
    const c = getCtx(); if (!c?.chat) return;
    const tail = choiceLabel ? `\n\n→ *${choiceLabel}*` : '';
    const msg = { name: c.name2 || 'Story', is_user: false,
        mes: `〔${node.location}〕\n\n${node.prose}${tail}`,
        send_date: Date.now(), extra: { [NS]: true, palimpsestPage: node.id } };
    c.chat.push(msg);
    try { await c.saveChat?.(); } catch (e) {}
    try { c.addOneMessage?.(msg); } catch (e) {}
}

/* ----------------------------------------------------------------------------
 * THE WAIST — one consumer. Authored effects and (later) emergent/extracted
 * effects flow through THIS, never a parallel path. JS owns all the math.
 * -------------------------------------------------------------------------- */
function applyEffects(fx) {
    if (!fx) return;
    if (fx.vars) for (const [k, d] of Object.entries(fx.vars)) {
        const next = (state.vars[k] ?? 0) + d, cap = state.vars[k + 'Max'];
        state.vars[k] = Math.max(0, cap != null ? Math.min(next, cap) : next);
    }
    if (fx.give) for (const id of fx.give) if (!state.inventory.includes(id)) state.inventory.push(id);
    if (fx.take) for (const id of fx.take) state.inventory = state.inventory.filter(x => x !== id);
    if (fx.setFlag)   for (const f of fx.setFlag)   state.flags[f] = true;
    if (fx.clearFlag) for (const f of fx.clearFlag) state.flags[f] = false;
    if (fx.addStatus) for (const id of fx.addStatus) if (!state.statuses.includes(id)) state.statuses.push(id);
    if (fx.removeStatus) for (const id of fx.removeStatus) state.statuses = state.statuses.filter(x => x !== id);
}

/* Sum status boosts for one var. The resolve/dice seam will read this later. */
function statusModifier(varName) {
    return (state.statuses || []).reduce((m, id) => m + ((statusDef(id).boosts || {})[varName] || 0), 0);
}

/* The gate. Returns true, or a human reason string if locked. */
function lockReason(choice) {
    const r = choice.requires; if (!r) return true;
    if (r.item && !state.inventory.includes(r.item)) return 'Requires: ' + itemName(r.item);
    if (r.flag && !state.flags[r.flag])              return 'Requires: ' + r.flag;
    if (r.status && !state.statuses.includes(r.status)) return 'Requires: ' + statusDef(r.status).label;
    if (Array.isArray(r.var)) {
        const [name, op, val] = r.var, cur = state.vars[name] ?? 0;
        const ok = op === '>=' ? cur >= val : op === '<=' ? cur <= val : op === '>' ? cur > val
                 : op === '<' ? cur < val : op === '==' ? cur === val : true;
        if (!ok) return 'Requires: ' + name + ' ' + op + ' ' + val;
    }
    return true;
}

/* ----------------------------------------------------------------------------
 * NAVIGATION
 * -------------------------------------------------------------------------- */
async function goTo(nodeId, choice) {
    const node = nodeById(nodeId);
    if (!node) { err('No node: ' + nodeId); return; }
    if (choice?.effects) applyEffects(choice.effects);
    state.current = nodeId; state.history.push(nodeId);
    persist();
    await commitReceipt(node, choice?.label);
    render();
}
async function improvise(seedLabel) {
    const c = getCtx();
    if (typeof c?.generateQuietPrompt !== 'function') { err('generateQuietPrompt unavailable on this ST.'); return; }
    dbg('Improvising…');
    // NOTE (next phase): emergent will also EMIT effects into the vocabulary
    // above; the socket (applyEffects) is already here waiting for it.
    const quietPrompt =
        'You are the narrator of a second-person gamebook. Continue briefly (2-4 sentences) ' +
        'from: "' + seedLabel + '". Then offer 2-3 choices. Reply ONLY with fenced JSON:\n' +
        '```json\n{ "location": "...", "prose": "...", "choices": [ { "label": "..." } ] }\n```';
    try {
        const raw = await c.generateQuietPrompt({ quietPrompt });
        const data = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
        if (!data.prose || !Array.isArray(data.choices)) throw new Error('shape');
        const id = 'emergent_' + Date.now();
        STORY.nodes[id] = { id, mode: 'emergent', location: data.location || 'Improvised',
            prose: data.prose, image: null,
            choices: data.choices.slice(0, 3).map(ch => ({ label: ch.label, emergent: true })) };
        await goTo(id);
    } catch (e) { err('Could not parse the model output. Staying put.'); }
}

/* ----------------------------------------------------------------------------
 * RENDER
 * -------------------------------------------------------------------------- */
let activeTab = 'story';
const ORN = '<div class="palimpsest-orn">&gt;—&lt;&nbsp;&nbsp;&gt;—&lt;&nbsp;&nbsp;&gt;—&lt;</div>';

function statBar() {
    const v = state.vars;
    const cell = (l, val) => '<span class="palimpsest-stat">' + l + ' <b>[' + val + ']</b></span>';
    const cells = [];
    if (v.stamina != null)  cells.push(cell('STAMINA', v.stamina + '/5'));
    if (v.vitality != null) cells.push(cell('VITALITY', v.vitality + '/' + (v.vitalityMax ?? '?')));
    if (v.defense != null) {
        const mod = statusModifier('defense');
        cells.push(cell('DEFENSE', mod ? (v.defense + mod) + ' (' + (mod > 0 ? '+' : '') + mod + ')' : v.defense));
    }
    let html = '<div class="palimpsest-statbar">' + cells.join('') + '</div>';
    if (state.statuses && state.statuses.length) {
        const chips = state.statuses.map(id =>
            '<span style="display:inline-block;padding:2px 9px;margin:0 4px;border:1px solid #3a3a40;border-radius:11px;font-size:11px;letter-spacing:1.5px;color:#b9b6ab;">'
            + statusDef(id).label.toUpperCase() + '</span>').join('');
        html += '<div style="text-align:center;margin:-8px 0 18px;">' + chips + '</div>';
    }
    return html;
}

function storyView() {
    const node = nodeById(state.current) || nodeById(STORY.start);
    if (!node) return '<div class="palimpsest-empty">No story loaded.</div>';
    const choices = node.choices.map((ch, i) => {
        const lock = lockReason(ch);
        return lock !== true
            ? '<div class="palimpsest-choice locked">« ' + ch.label + ' »<div class="palimpsest-lock">' + lock + '</div></div>'
            : '<div class="palimpsest-choice" data-i="' + i + '">« ' + ch.label + ' »</div>';
    }).join('');
    return statBar()
        + '<div class="palimpsest-loc">' + node.location + '</div>' + ORN
        + '<div class="palimpsest-prose">' + node.prose + '</div>'
        + (node.image ? '<img class="palimpsest-img" src="' + node.image + '">' : '') + ORN
        + '<div class="palimpsest-choices">' + choices + '</div>';
}
function journalView() {
    const rows = state.history.length
        ? state.history.map(id => '<div class="palimpsest-row">' + (nodeById(id)?.location || id) + '</div>').join('')
        : '<div class="palimpsest-empty">No pages turned yet.</div>';
    return '<div class="palimpsest-loc">Journal</div>' + ORN + '<div class="palimpsest-list">' + rows + '</div>';
}
function inventoryView() {
    const rows = state.inventory.length
        ? state.inventory.map(id => '<div class="palimpsest-row">' + itemName(id) + '</div>').join('')
        : '<div class="palimpsest-empty">Empty.</div>';
    return '<div class="palimpsest-loc">Inventory</div>' + ORN + '<div class="palimpsest-list">' + rows + '</div>';
}
function settingsView() {
    const SUITE = ['LexiconAPI', 'CodexAPI', 'ChroniclerAPI', 'FortunaAPI', 'VoiceAPI'];
    const present = n => !!(getCtx()?.[n] || window?.[n]);
    const suite = SUITE.map(n => { const on = present(n); const nm = n.replace('API', '');
        return '<div class="palimpsest-row" style="cursor:default">' + nm + ' <b style="color:' + (on ? '#7fae6e' : '#6a685f') + '">' + (on ? '✓ detected' : '— not present') + '</b></div>'; }).join('');
    return '<div class="palimpsest-loc">Settings</div>' + ORN
        + '<div class="palimpsest-list">'
        + '<div class="palimpsest-row" id="palimpsest-reload">⟳ Reload story.json</div>'
        + '<div class="palimpsest-empty">Story: ' + (STORY?.title || '—') + ' · v' + VER + '</div>'
        + '<div class="palimpsest-empty">Optional suite integrations — the shell runs without any.</div>'
        + suite
        + '<div class="palimpsest-row" id="palimpsest-reset">↺ Reset this story</div>'
        + '</div>';
}

function render() {
    const $body = document.getElementById('palimpsest-body'); if (!$body) return;
    $body.innerHTML = activeTab === 'journal' ? journalView()
        : activeTab === 'inventory' ? inventoryView()
        : activeTab === 'settings' ? settingsView() : storyView();
    $body.querySelectorAll('.palimpsest-choice[data-i]').forEach(el => el.addEventListener('click', () => {
        const ch = nodeById(state.current).choices[Number(el.dataset.i)];
        if (ch.emergent) improvise(ch.label);
        else if (ch.goto) goTo(ch.goto, ch);
        else toastr.warning('No destination yet.', 'Palimpsest');
    }));
    const reset = document.getElementById('palimpsest-reset');
    if (reset) reset.addEventListener('click', () => { state = FRESH(); persist(); activeTab = 'story'; render(); dbg('Story reset.'); });
    const reload = document.getElementById('palimpsest-reload');
    if (reload) reload.addEventListener('click', async () => { await loadStory(); loadState(); render(); dbg('Reloaded ' + (STORY?.title || 'story') + '.'); });
    document.querySelectorAll('.palimpsest-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
}

/* ----------------------------------------------------------------------------
 * TAKEOVER + SHELL  (unchanged from v0.2.2 — inline-pinned, theme-immune)
 * -------------------------------------------------------------------------- */
const CHROME = ['#sheld', '#form_sheld', '#top-bar', '#top-settings-holder', '#leftNavDrawerIcon', '#rightNavDrawerIcon'];
let hiddenChrome = [];
function hideChrome() {
    hiddenChrome = [];
    CHROME.forEach(sel => { const el = document.querySelector(sel);
        if (el && el.style.display !== 'none') { hiddenChrome.push([el, el.style.display]); el.style.display = 'none'; } });
    document.body.classList.add('palimpsest-lock');
}
function restoreChrome() {
    hiddenChrome.forEach(([el, d]) => { el.style.display = d || ''; });
    hiddenChrome = []; document.body.classList.remove('palimpsest-lock');
}

function buildShell() {
    document.getElementById('palimpsest-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'palimpsest-overlay';
    overlay.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;' +
        'z-index:' + (Z + 1) + ';display:flex;flex-direction:column;' +
        'background:#0c0c0e;color:#d6d4cc;font-family:Georgia,"Times New Roman",serif;';
    const bar = 'flex:0 0 auto;display:flex;align-items:center;padding:14px 18px;' +
                'font-size:12px;letter-spacing:2.5px;text-transform:uppercase;color:#8a8880;';
    overlay.innerHTML =
        '<div style="' + bar + 'justify-content:space-between;border-bottom:1px solid #1c1c20;">' +
            '<span>' + (STORY?.title || 'Palimpsest') + ' · v' + VER + '</span><span id="palimpsest-close" style="cursor:pointer;letter-spacing:0;">✕</span></div>' +
        '<div id="palimpsest-body" style="flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;' +
            'padding:26px 22px 40px;width:100%;max-width:680px;margin:0 auto;box-sizing:border-box;"></div>' +
        '<div style="' + bar + 'justify-content:center;gap:28px;border-top:1px solid #1c1c20;">' +
            '<span class="palimpsest-tab" data-tab="journal" style="cursor:pointer;">JOURNAL</span>' +
            '<span class="palimpsest-tab" data-tab="inventory" style="cursor:pointer;">INVENTORY</span>' +
            '<span class="palimpsest-tab" data-tab="settings" style="cursor:pointer;">SETTINGS</span></div>';
    document.body.appendChild(overlay);
    document.getElementById('palimpsest-close')?.addEventListener('click', closeShell);
    overlay.querySelectorAll('.palimpsest-tab').forEach(t => t.addEventListener('click', () => {
        activeTab = (activeTab === t.dataset.tab) ? 'story' : t.dataset.tab; render();
    }));
}
function openShell() {
    try {
        dbg('opening…');
        buildShell(); loadState(); hideChrome();
        activeTab = 'story';
        document.getElementById('palimpsest-overlay').style.display = 'flex';
        try { render(); } catch (e) { err('Render failed: ' + (e?.message || e)); }
    } catch (e) { err('Open failed: ' + (e?.message || e)); }
}
function closeShell() { const o = document.getElementById('palimpsest-overlay'); if (o) o.style.display = 'none'; restoreChrome(); }
function toggleShell() { const o = document.getElementById('palimpsest-overlay'); (o && o.style.display !== 'none') ? closeShell() : openShell(); }

function buildFAB() {
    document.getElementById('palimpsest-fab')?.remove();
    const fab = document.createElement('button');
    fab.id = 'palimpsest-fab'; fab.title = 'Open Palimpsest'; fab.style.zIndex = Z;
    fab.innerHTML = '<i class="fa-solid fa-book-open"></i>';
    document.body.appendChild(fab);
    fab.addEventListener('click', () => { dbg('FAB tapped'); toggleShell(); });
}
function buildWand() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('palimpsest-wand')) return;
    const item = document.createElement('div');
    item.id = 'palimpsest-wand'; item.className = 'list-group-item flex-container flexGap5 interactable'; item.tabIndex = 0;
    item.innerHTML = '<i class="fa-solid fa-book-open"></i><span>Palimpsest</span>';
    item.addEventListener('click', () => { dbg('wand tapped'); toggleShell(); });
    menu.appendChild(item);
}
function registerSlash(c) {
    try {
        if (c?.SlashCommandParser?.addCommandObject && c?.SlashCommand?.fromProps) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'palimpsest', aliases: ['cyoa'], callback: () => { toggleShell(); return ''; }, helpString: 'Toggle Palimpsest' }));
            return 'modern';
        }
    } catch (e) {}
    try {
        if (typeof c?.registerSlashCommand === 'function') {
            c.registerSlashCommand('palimpsest', () => { toggleShell(); }, ['cyoa'], 'Toggle Palimpsest', true, true);
            return 'legacy';
        }
    } catch (e) {}
    return 'none';
}

/* INIT */
jQuery(async () => {
    await loadStory();                               // story ready before first open
    try { buildFAB(); } catch (e) { err('FAB build failed: ' + (e?.message || e)); }
    try { buildWand(); } catch (e) {}
    const c = getCtx();
    try {
        if (c?.eventSource?.on && c?.event_types?.CHAT_CHANGED) {
            c.eventSource.on(c.event_types.CHAT_CHANGED, () => {
                loadState();
                if (document.getElementById('palimpsest-overlay')?.style.display === 'flex') render();
            });
        }
    } catch (e) {}
    const slash = registerSlash(c);
    if (DEBUG) dbg('loaded v' + VER + ' (story: ' + (STORY?.title || 'fallback') + ', slash: ' + slash + ')');
    console.log('[palimpsest] ✅ loaded v' + VER + '; slash=' + slash);
});
