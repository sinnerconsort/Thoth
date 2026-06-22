/* =============================================================================
 * CYOA Shell v0.2.0  —  a STANDALONE gamebook shell for SillyTavern
 * -----------------------------------------------------------------------------
 * WHAT CHANGED FROM v0.1 (the three things you flagged):
 *
 *   1. STANDALONE — zero hard dependencies. manifest requires: []. The suite
 *      (Lexicon/Codex/Fortuna/Chronicler) is OPTIONAL: detected at runtime and
 *      used only if present. With none of them, this is still a complete game.
 *      See suiteStatus() — shown live in the Settings tab.
 *
 *   2. TAKEOVER — opening hides ST's chat, input bar, and nav, and locks body
 *      scroll; closing restores exactly what was hidden. The screen is OURS.
 *      Tappable choices, never "type 1/2/3".
 *
 *   3. BULLETPROOF + SELF-ANNOUNCING ENTRY — three ways in (FAB, wand menu,
 *      /cyoa), each best-effort and independent. Every tap toasts so you can
 *      SEE it fire without a console. Open path is fully try/caught and will
 *      TOAST THE ACTUAL ERROR if anything throws (this is what was silently
 *      failing in v0.1). Flip DEBUG to false once it's behaving.
 * ========================================================================== */

const NS = "cyoa-shell";  // v0.2.1
const Z  = 31000;
let DEBUG = true;   // <- set to false later; gates the diagnostic toasts

/* Robust context getter — never assume the global is the right shape. */
function getCtx() {
    try { return SillyTavern.getContext(); }
    catch (e) { return window.SillyTavern?.getContext?.() || null; }
}
function dbg(msg) { if (DEBUG) try { toastr.info(msg, 'CYOA'); } catch (e) {} }
function err(msg) { try { toastr.error(msg, 'CYOA', { timeOut: 9000 }); } catch (e) {} }

/* ----------------------------------------------------------------------------
 * STATE  (per-chat, in chat_metadata)
 * -------------------------------------------------------------------------- */
const FRESH = () => ({
    current:   'oythe_great_hall',
    vars:      { vitality: 39, vitalityMax: 44, stamina: 5, defense: 2 },
    flags:     { alerted: false },
    inventory: ['kellsei', 'wooden_cross'],
    history:   [],
});
let state = FRESH();

const NODES = {
    oythe_great_hall: {
        id: 'oythe_great_hall', mode: 'authored',
        location: 'Oythe Castle — Great Hall',
        prose: 'I creep down the stairs and peer into the entrance hall. A knight stands guard, sword and shield raised, his gaze darting about. A faint clinking comes from the chains connecting his helmet to his gambeson.',
        image: null,
        choices: [
            { label: 'Attack the Crusader', goto: 'combat_crusader', effects: { setFlag: ['alerted'] } },
            { label: 'Slip through the side door', goto: 'upper_floor', requires: { item: 'castle_key' } },
            { label: 'Return to the Upper Floor', goto: 'upper_floor' },
        ],
        skeleton: { mustHit: ['the knight has not seen me yet'], exits: ['combat_crusader', 'upper_floor'] },
    },
    combat_crusader: {
        id: 'combat_crusader', mode: 'authored',
        location: 'Oythe Castle — The Crusader',
        prose: 'He turns at the scrape of my boot. Steel rings free. There is no more creeping now — only the few feet of cold air between us, and what I choose to do with them.',
        image: null,
        // resolve: { engine: 'fortuna', stakes: 'FRAGILE' }   // <- Fortuna seam (optional, see resolveRoll)
        choices: [
            { label: 'Strike first', goto: 'upper_floor', effects: { vars: { vitality: -3 } } },
            { label: 'Throw down my blade and run', goto: 'upper_floor' },
        ],
        skeleton: { mustHit: ['the fight is joined'], exits: ['upper_floor'] },
    },
    upper_floor: {
        id: 'upper_floor', mode: 'authored',
        location: 'Oythe Castle — Upper Floor',
        prose: 'Cold flagstones, a guttering torch, the smell of old smoke. The stairwell yawns back down toward the hall. Whatever waits below, it is quieter up here.',
        image: null,
        choices: [
            { label: 'Descend again', goto: 'oythe_great_hall' },
            { label: 'Improvise from here  (✨ emergent)', emergent: true },
        ],
        skeleton: { mustHit: ['a moment of quiet'], exits: ['oythe_great_hall'] },
    },
};
const ITEM_NAMES = { kellsei: 'Kellsei', wooden_cross: 'Wooden Cross', castle_key: 'Castle Key' };

/* ----------------------------------------------------------------------------
 * OPTIONAL SUITE DETECTION — enhancement only, never required.
 * -------------------------------------------------------------------------- */
const SUITE = ['LexiconAPI', 'CodexAPI', 'ChroniclerAPI', 'FortunaAPI', 'VoiceAPI'];
function apiPresent(name) { const c = getCtx(); return !!(c?.[name] || window?.[name]); }
function suiteStatus() { return SUITE.map(n => ({ name: n.replace('API', ''), on: apiPresent(n) })); }

/* Resolution that degrades: use Fortuna if present, else a built-in d20.
   (Not wired to a choice in v0.2 — here so the fallback path is documented.) */
function resolveRoll(stakes) {
    const c = getCtx();
    if (c?.FortunaAPI?.roll) { try { return c.FortunaAPI.roll({ stakes }); } catch (e) {} }
    return { total: 1 + Math.floor(Math.random() * 20), source: 'builtin' };
}

/* ----------------------------------------------------------------------------
 * PERSISTENCE
 * -------------------------------------------------------------------------- */
function loadState() {
    const c = getCtx();
    const saved = c?.chat_metadata?.[NS];
    state = saved ? Object.assign(FRESH(), saved) : FRESH();
}
function persist() {
    const c = getCtx(); if (!c) return;
    c.chat_metadata = c.chat_metadata || {};
    c.chat_metadata[NS] = state;
    if (typeof c.saveMetadata === 'function') c.saveMetadata();
    else if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
}

/* RECEIPTS — every committed page writes one message to the real chat. */
async function commitReceipt(node, choiceLabel) {
    const c = getCtx(); if (!c?.chat) return;
    const tail = choiceLabel ? `\n\n→ *${choiceLabel}*` : '';
    const msg = {
        name: c.name2 || 'Story', is_user: false,
        mes: `〔${node.location}〕\n\n${node.prose}${tail}`,
        send_date: Date.now(), extra: { [NS]: true, cyoaPage: node.id },
    };
    c.chat.push(msg);
    try { await c.saveChat?.(); } catch (e) {}
    try { c.addOneMessage?.(msg); } catch (e) {}
}

/* RULES — JS owns the math. */
function applyEffects(fx) {
    if (!fx) return;
    if (fx.vars) for (const [k, d] of Object.entries(fx.vars)) {
        const next = (state.vars[k] ?? 0) + d, cap = state.vars[k + 'Max'];
        state.vars[k] = Math.max(0, cap != null ? Math.min(next, cap) : next);
    }
    if (fx.give) for (const id of fx.give) if (!state.inventory.includes(id)) state.inventory.push(id);
    if (fx.take) for (const id of fx.take) state.inventory = state.inventory.filter(x => x !== id);
    if (fx.setFlag) for (const f of fx.setFlag) state.flags[f] = true;
    if (fx.clearFlag) for (const f of fx.clearFlag) state.flags[f] = false;
}
function lockReason(choice) {
    const r = choice.requires; if (!r) return true;
    if (r.item && !state.inventory.includes(r.item)) return `Requires: ${ITEM_NAMES[r.item] || r.item}`;
    if (r.flag && !state.flags[r.flag]) return `Requires: ${r.flag}`;
    return true;
}

/* NAVIGATION */
async function goTo(nodeId, choice) {
    const node = NODES[nodeId];
    if (!node) { err(`No node: ${nodeId}`); return; }
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
    const quietPrompt =
        `You are the narrator of a second-person gamebook. Continue briefly (2-4 sentences) ` +
        `from: "${seedLabel}". Then offer 2-3 choices. Reply ONLY with fenced JSON:\n` +
        '```json\n{ "location": "...", "prose": "...", "choices": [ { "label": "..." } ] }\n```';
    try {
        const raw = await c.generateQuietPrompt({ quietPrompt });
        const data = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
        if (!data.prose || !Array.isArray(data.choices)) throw new Error('shape');
        const id = 'emergent_' + Date.now();
        NODES[id] = {
            id, mode: 'emergent', location: data.location || 'Improvised',
            prose: data.prose, image: null,
            choices: data.choices.slice(0, 3).map(ch => ({ label: ch.label, emergent: true })),
        };
        await goTo(id);
    } catch (e) { err('Could not parse the model output. Staying put.'); }
}

/* ----------------------------------------------------------------------------
 * RENDER
 * -------------------------------------------------------------------------- */
let activeTab = 'story';
const ORN = `<div class="cyoa-orn">&gt;—&lt;&nbsp;&nbsp;&gt;—&lt;&nbsp;&nbsp;&gt;—&lt;</div>`;
function statBar() {
    const v = state.vars, cell = (l, val) => `<span class="cyoa-stat">${l} <b>[${val}]</b></span>`;
    return `<div class="cyoa-statbar">${cell('STAMINA', `${v.stamina}/5`)}${cell('VITALITY', `${v.vitality}/${v.vitalityMax}`)}${cell('DEFENSE', v.defense)}</div>`;
}
function storyView() {
    const node = NODES[state.current] || NODES.oythe_great_hall;
    const choices = node.choices.map((ch, i) => {
        const lock = lockReason(ch);
        return lock !== true
            ? `<div class="cyoa-choice locked">« ${ch.label} »<div class="cyoa-lock">${lock}</div></div>`
            : `<div class="cyoa-choice" data-i="${i}">« ${ch.label} »</div>`;
    }).join('');
    return `${statBar()}<div class="cyoa-loc">${node.location}</div>${ORN}
        <div class="cyoa-prose">${node.prose}</div>
        ${node.image ? `<img class="cyoa-img" src="${node.image}">` : ''}${ORN}
        <div class="cyoa-choices">${choices}</div>`;
}
function journalView() {
    const rows = state.history.length
        ? state.history.map(id => `<div class="cyoa-row">${NODES[id]?.location || id}</div>`).join('')
        : `<div class="cyoa-empty">No pages turned yet.</div>`;
    return `<div class="cyoa-loc">Journal</div>${ORN}<div class="cyoa-list">${rows}</div>`;
}
function inventoryView() {
    const rows = state.inventory.length
        ? state.inventory.map(id => `<div class="cyoa-row">${ITEM_NAMES[id] || id}</div>`).join('')
        : `<div class="cyoa-empty">Empty.</div>`;
    return `<div class="cyoa-loc">Inventory</div>${ORN}<div class="cyoa-list">${rows}</div>`;
}
function settingsView() {
    const suite = suiteStatus().map(s =>
        `<div class="cyoa-row" style="cursor:default">${s.name} <b style="color:${s.on ? '#7fae6e' : '#6a685f'}">${s.on ? '✓ detected' : '— not present'}</b></div>`
    ).join('');
    return `<div class="cyoa-loc">Settings</div>${ORN}
        <div class="cyoa-list">
            <div class="cyoa-empty">Optional suite integrations — the shell runs without any of them.</div>
            ${suite}
            <div class="cyoa-row" id="cyoa-reset">↺ Reset this story</div>
        </div>`;
}
function render() {
    const $body = document.getElementById('cyoa-body'); if (!$body) return;
    $body.innerHTML = activeTab === 'journal' ? journalView()
        : activeTab === 'inventory' ? inventoryView()
        : activeTab === 'settings' ? settingsView() : storyView();
    $body.querySelectorAll('.cyoa-choice[data-i]').forEach(el => el.addEventListener('click', () => {
        const ch = NODES[state.current].choices[Number(el.dataset.i)];
        if (ch.emergent) improvise(ch.label);
        else if (ch.goto) goTo(ch.goto, ch);
        else toastr.warning('No destination yet.', 'CYOA');
    }));
    const reset = document.getElementById('cyoa-reset');
    if (reset) reset.addEventListener('click', () => { state = FRESH(); persist(); activeTab = 'story'; render(); dbg('Story reset.'); });
    document.querySelectorAll('.cyoa-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
}

/* ----------------------------------------------------------------------------
 * TAKEOVER — hide ST chrome on open, restore exactly on close.
 * -------------------------------------------------------------------------- */
const CHROME = ['#sheld', '#form_sheld', '#top-bar', '#top-settings-holder', '#leftNavDrawerIcon', '#rightNavDrawerIcon'];
let hiddenChrome = [];
function hideChrome() {
    hiddenChrome = [];
    CHROME.forEach(sel => { const el = document.querySelector(sel);
        if (el && el.style.display !== 'none') { hiddenChrome.push([el, el.style.display]); el.style.display = 'none'; } });
    document.body.classList.add('cyoa-lock');
}
function restoreChrome() {
    hiddenChrome.forEach(([el, d]) => { el.style.display = d || ''; });
    hiddenChrome = [];
    document.body.classList.remove('cyoa-lock');
}

/* ----------------------------------------------------------------------------
 * SHELL
 * -------------------------------------------------------------------------- */
function buildShell() {
    if (document.getElementById('cyoa-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'cyoa-overlay';
    // Load-bearing layout is pinned INLINE so ST's theme CSS can't collapse it.
    // (style.css now only handles cosmetics: type, choice colors, ornaments.)
    overlay.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;z-index:' + (Z + 1) + ';' +
        'display:flex;flex-direction:column;background:#0c0c0e;color:#d6d4cc;' +
        'font-family:Georgia,"Times New Roman",serif;';
    const bar = 'flex:0 0 auto;display:flex;align-items:center;padding:14px 18px;' +
                'font-size:12px;letter-spacing:2.5px;text-transform:uppercase;color:#8a8880;';
    overlay.innerHTML =
        '<div style="' + bar + 'justify-content:space-between;border-bottom:1px solid #1c1c20;">' +
            '<span>KENAM MOORWAK</span><span id="cyoa-close" style="cursor:pointer;letter-spacing:0;">✕</span></div>' +
        '<div id="cyoa-body" style="flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;' +
            'padding:26px 22px 40px;width:100%;max-width:680px;margin:0 auto;box-sizing:border-box;"></div>' +
        '<div style="' + bar + 'justify-content:center;gap:28px;border-top:1px solid #1c1c20;">' +
            '<span class="cyoa-tab" data-tab="journal" style="cursor:pointer;">JOURNAL</span>' +
            '<span class="cyoa-tab" data-tab="inventory" style="cursor:pointer;">INVENTORY</span>' +
            '<span class="cyoa-tab" data-tab="settings" style="cursor:pointer;">SETTINGS</span></div>';
    document.body.appendChild(overlay);
    document.getElementById('cyoa-close')?.addEventListener('click', closeShell);
    overlay.querySelectorAll('.cyoa-tab').forEach(t => t.addEventListener('click', () => {
        activeTab = (activeTab === t.dataset.tab) ? 'story' : t.dataset.tab; render();
    }));
}
function openShell() {
    try {
        dbg('opening…');
        buildShell();
        loadState();
        hideChrome();
        activeTab = 'story';
        document.getElementById('cyoa-overlay').style.display = 'flex';
        try { render(); } catch (e) { err('Render failed: ' + (e?.message || e)); }
    } catch (e) {
        err('Open failed: ' + (e?.message || e));   // <- the v0.1 silent failure now speaks
    }
}
function closeShell() {
    const o = document.getElementById('cyoa-overlay');
    if (o) o.style.display = 'none';
    restoreChrome();
}
function toggleShell() {
    const o = document.getElementById('cyoa-overlay');
    (o && o.style.display !== 'none') ? closeShell() : openShell();
}

/* ENTRY POINTS — three, independent, best-effort. */
function buildFAB() {
    document.getElementById('cyoa-fab')?.remove();   // kill any stale FAB, then rebind fresh
    const fab = document.createElement('button');
    fab.id = 'cyoa-fab'; fab.title = 'Open CYOA'; fab.style.zIndex = Z;
    fab.innerHTML = '<i class="fa-solid fa-book-open"></i>';
    document.body.appendChild(fab);
    fab.addEventListener('click', () => { dbg('FAB tapped'); toggleShell(); });
}
function buildWand() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('cyoa-wand')) return;
    const item = document.createElement('div');
    item.id = 'cyoa-wand'; item.className = 'list-group-item flex-container flexGap5 interactable'; item.tabIndex = 0;
    item.innerHTML = '<i class="fa-solid fa-book-open"></i><span>CYOA Shell</span>';
    item.addEventListener('click', () => { dbg('wand tapped'); toggleShell(); });
    menu.appendChild(item);
}
function registerSlash(c) {
    try {
        if (c?.SlashCommandParser?.addCommandObject && c?.SlashCommand?.fromProps) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'cyoa', callback: () => { toggleShell(); return ''; }, helpString: 'Toggle the CYOA shell',
            }));
            return 'modern';
        }
    } catch (e) {}
    try {
        if (typeof c?.registerSlashCommand === 'function') {
            c.registerSlashCommand('cyoa', () => { toggleShell(); }, [], 'Toggle the CYOA shell', true, true);
            return 'legacy';
        }
    } catch (e) {}
    return 'none';
}

/* INIT — each step isolated so one failure can't kill the entry points. */
jQuery(async () => {
    try { buildFAB(); } catch (e) { err('FAB build failed: ' + (e?.message || e)); }
    try { buildWand(); } catch (e) {}
    const c = getCtx();
    try {
        if (c?.eventSource?.on && c?.event_types?.CHAT_CHANGED) {
            c.eventSource.on(c.event_types.CHAT_CHANGED, () => {
                loadState();
                if (document.getElementById('cyoa-overlay')?.style.display === 'flex') render();
            });
        }
    } catch (e) {}
    const slash = registerSlash(c);
    if (DEBUG) dbg(`loaded (slash: ${slash})`);
    console.log('[cyoa-shell] ✅ loaded; slash=' + slash);
});
