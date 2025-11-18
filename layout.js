//  .container                 - the main container
//  .dockable-window           - each floating window; must contain a <header> and .window-content
//  .display-dock-area         - overlay drop targets shown while dragging (have classes top/left/right/bottom/center)
//  .dock-area                 - actual persistent areas in the layout (have classes top/left/right/bottom/center)
// Note: center is treated as the primary pane (keeps full center space).

const container = document.querySelector('.container');
const windows = Array.from(document.querySelectorAll('.dockable-window'));
const displayDockAreas = Array.from(document.querySelectorAll('.display-dock-area'));
const dockAreas = Array.from(document.querySelectorAll('.dock-area'));

let draggedWindow = null;
let dragOffsetX = 0, dragOffsetY = 0;
let snapTarget = null;
let zIndexCounter = 1000;

// Maps and caches
const dockMap = new Map();          // floating window element -> dock-area element where it's docked
const originalSize = new Map();     // floating window -> {w,h}
const dockTabsCache = new WeakMap(); // dock-area element -> DockTabs instance

// --- DockTabs: manages tab bar + panels inside a dock area ---
class DockTabs {
    constructor(areaEl) {
        this.area = areaEl;
        this.tabBar = areaEl.querySelector('.dock-tabs') || this._createTabBar();
        this.contentBox = areaEl.querySelector('.dock-content') || this._createContentBox();
        // ensure content box fills area
        this.area.classList.add('has-tabs');
    }

    _createTabBar() {
        const bar = document.createElement('div');
        bar.className = 'dock-tabs';
        this.area.prepend(bar); // tabs at top of area
        return bar;
    }

    _createContentBox() {
        const content = document.createElement('div');
        content.className = 'dock-content';
        this.area.appendChild(content);
        return content;
    }

    // Add a window into tabs (the actual window's content is moved)
    addTab(win) {
        const id = win.dataset.id;
        if (!id) throw new Error('window must have dataset.id');

        // If a tab exists already (re-docking), don't duplicate
        if (this.tabBar.querySelector(`[data-win="${id}"]`)) {
            this.activate(id);
            return;
        }

        // Create tab button
        const tab = document.createElement('button');
        tab.className = 'dock-tab';
        tab.dataset.win = id;
        tab.type = 'button';
        tab.textContent = (win.querySelector('header')?.innerText || `Win ${id}`);
        this.tabBar.appendChild(tab);

        // Move the content into a panel element (not the entire window DOM - keep the floating window DOM but transfer its content)
        const panel = document.createElement('div');
        panel.className = 'dock-panel';
        panel.dataset.win = id;

        const contentNode = win.querySelector('.window-content');
        if (contentNode) {
            panel.appendChild(contentNode);
        } else {
            // fallback: clone content
            panel.appendChild(win.cloneNode(true));
        }
        this.contentBox.appendChild(panel);

        // Tab click selects
        tab.addEventListener('click', () => this.activate(id));

        // Allow dragging the active tab to undock (start dragging the original window)
        tab.addEventListener('pointerdown', e => {
            // Only start undock if it's currently active (so user drags the active tab)
            if (!tab.classList.contains('active')) return;
            // Create a short delay so pointer event flows to global drag logic
            // We'll synthesize pointerdown on the original floating window to reuse undock logic
            // If the original floating DOM element is hidden, undock() will reveal it back.
            const originalWin = document.querySelector(`.dockable-window[data-id="${id}"], .dockable-window[data-id='${id}']`) || windows.find(w => w.dataset.id === id);
            if (!originalWin) return;
            // Undock and initiate drag from current pointer event
            // We call undockImmediate so undock won't run layout adjustments twice.
            undock(originalWin, {revealOnly: true});
            onDown(originalWin, e);
        });

        // Activate the new tab
        this.activate(id);
    }

    removeTab(win) {
        const id = win.dataset.id;
        const tab = this.tabBar.querySelector(`[data-win="${id}"]`);
        const panel = this.contentBox.querySelector(`[data-win="${id}"]`);
        if (tab) tab.remove();
        if (panel) panel.remove();
        // activate first remaining tab if any
        const first = this.tabBar.querySelector('.dock-tab');
        if (first) this.activate(first.dataset.win);
        else this.clearActive();
    }

    activate(winId) {
        this.tabBar.querySelectorAll('.dock-tab').forEach(t => t.classList.toggle('active', t.dataset.win === winId));
        this.contentBox.querySelectorAll('.dock-panel').forEach(p => p.classList.toggle('active', p.dataset.win === winId));
    }

    clearActive() {
        this.tabBar.querySelectorAll('.dock-tab').forEach(t => t.classList.remove('active'));
        this.contentBox.querySelectorAll('.dock-panel').forEach(p => p.classList.remove('active'));
    }

    countTabs() {
        return this.tabBar.querySelectorAll('.dock-tab').length;
    }
}

// Get or create DockTabs for area
function getTabs(area) {
    if (!dockTabsCache.has(area)) {
        dockTabsCache.set(area, new DockTabs(area));
    }
    return dockTabsCache.get(area);
}

// Show/hide overlay drop targets while dragging
function showDockAreas() {
    displayDockAreas.forEach(a => {
        a.style.display = 'block';
        a.classList.remove('hovered');
    });
}
function hideDockAreas() {
    displayDockAreas.forEach(a => {
        a.style.display = 'none';
        a.classList.remove('hovered');
    });
}

// nearest overlay by center-distance
function getNearestDockArea() {
    if (!draggedWindow) return null;
    const winRect = draggedWindow.getBoundingClientRect();
    let nearest = null;
    let best = Infinity;

    displayDockAreas.forEach(area => {
        const r = area.getBoundingClientRect();
        const dx = (winRect.left + winRect.width / 2) - (r.left + r.width / 2);
        const dy = (winRect.top + winRect.height / 2) - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy);
        if (d < best && d < 180) {
            best = d;
            nearest = area;
        }
    });
    return nearest;
}

// Undock: remove from dock area and restore floating window display
// options: { revealOnly: boolean } - reveal the original window but don't remove .window-content from area
function undock(win, options = {}) {
    const area = dockMap.get(win);
    if (!area) {
        // already floating
        return;
    }
    const tabs = dockTabsCache.get(area);
    if (tabs) {
        // Move the content panel back into the floating window
        const panel = tabs.contentBox.querySelector(`[data-win="${win.dataset.id}"]`);
        if (panel) {
            const contentNode = panel.querySelector('.window-content');
            if (contentNode) {
                // move contentNode back into window (prepend so header stays at top)
                win.appendChild(contentNode);
            } else {
                // if no .window-content in panel (shouldn't happen), do nothing
            }
            // remove panel and tab
            tabs.removeTab(win);
        }
    }

    // hide dock area if empty
    if (tabs && tabs.countTabs() === 0) {
        area.style.display = 'none';
    }

    dockMap.delete(win);

    // Restore floating window appearance
    const size = originalSize.get(win);
    if (size) {
        win.style.width = size.w + 'px';
        win.style.height = size.h + 'px';
    }
    win.style.display = 'block';
    // Ensure it's above others
    win.style.zIndex = ++zIndexCounter;

    // If we used revealOnly flag, caller intends to then start dragging
    if (options.revealOnly) {
        // leave content already moved back
        return;
    }
}

// Dock a window into a display overlay area -> maps to the real dock-area
function dockToArea(win, displayArea) {
    // If window is already docked to the exact area, do nothing
    const areaType = ['top','bottom','left','right','center'].find(c => displayArea.classList.contains(c));
    if (!areaType) return;

    // Actually target the persistent dock-area element
    const area = dockAreas.find(a => a.classList.contains(areaType));
    if (!area) {
        console.warn('No persistent dock-area for', areaType);
        return;
    }

    // Normal docking:
    // 1) If currently docked elsewhere, undock (we handle moving content inside undock())
    undock(win, { revealOnly: true });

    // 2) Hide floating window DOM (we keep the DOM element, but it's hidden while its content lives in the area)
    win.style.display = 'none';

    // 3) Add to dockMap and move window content into the area's tabs (DockTabs handles moving .window-content)
    dockMap.set(win, area);
    const tabs = getTabs(area);
    tabs.addTab(win);

    // show the area if it was hidden
    area.style.display = 'block';

    // update layout so splits/shares reflect the change
    updateLayout();
}

// Layout: adjust sizes of edge areas based on how many tabs they contain.
// Center fills remainder.
function updateLayout() {
    const containerRect = container.getBoundingClientRect();
    const W = Math.max(200, containerRect.width);
    const H = Math.max(200, containerRect.height);

    const counts = {};
    ['left','right','top','bottom','center'].forEach(k => {
        const area = dockAreas.find(a => a.classList.contains(k));
        if (!area) { counts[k] = 0; return; }
        const tabs = getTabs(area);
        counts[k] = tabs.countTabs();
        area.style.display = counts[k] > 0 ? 'block' : (k === 'center' ? 'block' : 'none');
    });

    // Base sizes
    const baseW = 220;
    const baseH = 140;
    const growW = 40;
    const growH = 30;

    const leftW   = counts.left   ? Math.min(W * 0.4, baseW + (counts.left   - 1) * growW) : 0;
    const rightW  = counts.right  ? Math.min(W * 0.4, baseW + (counts.right  - 1) * growW) : 0;
    const topH    = counts.top    ? Math.min(H * 0.35, baseH + (counts.top   - 1) * growH) : 0;
    const bottomH = counts.bottom ? Math.min(H * 0.35, baseH + (counts.bottom- 1) * growH) : 0;

    // Set CSS variables used by the grid layout
    container.style.setProperty('--dock-left-width',   leftW   + 'px');
    container.style.setProperty('--dock-right-width',  rightW  + 'px');
    container.style.setProperty('--dock-top-height',   topH    + 'px');
    container.style.setProperty('--dock-bottom-height',bottomH + 'px');

    showSplitters();
}

// --- Resizing Logic ---

// Splitter directions configuration
const splitters = [
    {
        dir: "left",
        cssVar: "--dock-left-width",
        min: 80,
        axis: "x",
        sign: +1,
    },
    {
        dir: "right",
        cssVar: "--dock-right-width",
        min: 80,
        axis: "x",
        sign: -1,
    },
    {
        dir: "top",
        cssVar: "--dock-top-height",
        min: 60,
        axis: "y",
        sign: +1,
    },
    {
        dir: "bottom",
        cssVar: "--dock-bottom-height",
        min: 60,
        axis: "y",
        sign: -1,
    }
];

let activeSplitter = null;
let splitterStartPos = 0;
let splitterStartSize = 0;

// Get splitters from DOM
splitters.forEach(s => {
    s.el = document.querySelector(`.splitter.${s.dir}`);
});

function showSplitters() {
    splitters.forEach(s => {
        const area = document.querySelector(`.dock-area.${s.dir}`);
        const tabs = dockTabsCache.get(area);

        const visible = tabs && tabs.countTabs() > 0;
        s.el.style.display = visible ? "block" : "none";
    });
}


function beginResize(s, e) {
    activeSplitter = s;

    splitterStartPos = s.axis === "x" ? e.clientX : e.clientY;

    const cs = getComputedStyle(container);
    splitterStartSize = parseFloat(cs.getPropertyValue(s.cssVar));

    document.addEventListener("pointermove", doResize);
    document.addEventListener("pointerup", endResize);
}


function doResize(e) {
    if (!activeSplitter) return;

    const curr = activeSplitter.axis === "x" ? e.clientX : e.clientY;
    const delta = (curr - splitterStartPos) * activeSplitter.sign;

    const newSize = Math.max(activeSplitter.min, splitterStartSize + delta);

    container.style.setProperty(activeSplitter.cssVar, newSize + "px");
}


function endResize() {
    activeSplitter = null;
    document.removeEventListener("pointermove", doResize);
    document.removeEventListener("pointerup", endResize);
}

splitters.forEach(s => {
    s.el.addEventListener("pointerdown", e => beginResize(s, e));
});






// Dragging logic

// initialize windows
windows.forEach((win, idx) => {
    // ensure each window has an ID
    if (!win.dataset.id) win.dataset.id = String(idx);
    // store its original size
    const r = win.getBoundingClientRect();
    originalSize.set(win, { w: r.width, h: r.height });
    // header pointerdown
    const header = win.querySelector('header');
    if (header) {
        header.style.touchAction = 'none';
        header.addEventListener('pointerdown', e => onDown(win, e));
    }
    // ensure floating windows are positioned absolute
    win.style.position = win.style.position || 'absolute';
});

// pointerdown to start dragging floating window
function onDown(win, e) {
    e.preventDefault();
    draggedWindow = win;

    // If the window is docked, undock it and restore floating window (but we want to start dragging it)
    if (dockMap.has(win)) {
        undock(win, { revealOnly: true });
    }

    const r = win.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    // capture offsets relative to container
    dragOffsetX = e.clientX - r.left;
    dragOffsetY = e.clientY - r.top;

    // place window above others
    win.style.zIndex = ++zIndexCounter;

    // Make sure it's visible (it might have been hidden after undock reveal)
    win.style.display = 'block';
    // Make position absolute relative to container: compute left/top relative to container
    win.style.left = (r.left - containerRect.left) + 'px';
    win.style.top = (r.top - containerRect.top) + 'px';

    showDockAreas();

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);

    // set pointer capture on the target so we receive pointer events even if leaving the element
    if (e.target.setPointerCapture) {
        try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    }
}

function onMove(e) {
    if (!draggedWindow) return;
    const containerRect = container.getBoundingClientRect();
    const x = e.clientX - containerRect.left - dragOffsetX;
    const y = e.clientY - containerRect.top - dragOffsetY;
    draggedWindow.style.left = Math.max(0, x) + 'px';
    draggedWindow.style.top = Math.max(0, y) + 'px';

    // find nearest display area and highlight
    displayDockAreas.forEach(a => a.classList.remove('hovered'));
    const near = getNearestDockArea();
    if (near) {
        snapTarget = near;
        near.classList.add('hovered');
    } else {
        snapTarget = null;
    }
}

function onUp(e) {
    if (!draggedWindow) return;

    if (snapTarget) {
        dockToArea(draggedWindow, snapTarget);
    } else {
        // dropped outside - keep floating where released
        // ensure it's not considered docked
        dockMap.delete(draggedWindow);
        updateLayout();
    }

    hideDockAreas();
    draggedWindow = null;
    snapTarget = null;

    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
}

// On page load ensure layout reflects any existing docked windows
updateLayout();
