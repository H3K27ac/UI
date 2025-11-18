

const container = document.querySelector(".container");
const windows     = [...document.querySelectorAll(".dockable-window")];
const dockAreas   = [...document.querySelectorAll(".dock-area")];
const overlayAreas= [...document.querySelectorAll(".display-dock-area")];

const areaByType = Object.fromEntries(
    ["left","right","top","bottom","center"]
        .map(t => [t, dockAreas.find(a => a.classList.contains(t))])
);

let dragged = null;
let dragOffsetX = 0, dragOffsetY = 0;
let snapTarget = null;
let zIndexCounter = 1000;

const savedSizes = { left:null, right:null, top:null, bottom:null };

// Maps
const dockMap        = new Map();     // window -> dock-area
const originalSize   = new WeakMap(); // window -> initial dimensions
const tabsCache      = new WeakMap(); // dock-area -> DockTabs instance

/***********************************************************************
 * DockTabs - manages tab bar and content panels inside a dock area
 ***********************************************************************/
class DockTabs {
    constructor(area) {
        this.area = area;
        this.tabBar = area.querySelector(".dock-tabs") || this._make("dock-tabs", true);
        this.contentBox = area.querySelector(".dock-content") || this._make("dock-content");
        this.area.classList.add("has-tabs");
    }

    _make(cls, prepend=false) {
        const el = document.createElement("div");
        el.className = cls;
        prepend ? this.area.prepend(el) : this.area.appendChild(el);
        return el;
    }

    _tabExists(id) {
        return !!this.tabBar.querySelector(`[data-win="${id}"]`);
    }

    add(win) {
        const id = win.dataset.id;
        if (this._tabExists(id)) {
            return this.activate(id);
        }

        // Tab
        const tab = document.createElement("button");
        tab.className = "dock-tab";
        tab.dataset.win = id;
        tab.type = "button";
        tab.textContent = win.querySelector("header")?.innerText || `Window ${id}`;
        this.tabBar.appendChild(tab);

        // Panel
        const panel = document.createElement("div");
        panel.className = "dock-panel";
        panel.dataset.win = id;

        const content = win.querySelector(".window-content");
        panel.appendChild(content);
        this.contentBox.appendChild(panel);

        // events
        tab.addEventListener("click", () => this.activate(id));
        tab.addEventListener("pointerdown", e => {
            if (!tab.classList.contains("active")) return;
            undock(win, { revealOnly: true });
            beginDrag(win, e);
        });

        this.activate(id);
    }

    remove(win) {
        const id = win.dataset.id;
        this.tabBar.querySelector(`[data-win="${id}"]`)?.remove();
        this.contentBox.querySelector(`[data-win="${id}"]`)?.remove();

        const first = this.tabBar.querySelector(".dock-tab");
        first ? this.activate(first.dataset.win) : this.clear();
    }

    activate(id) {
        [...this.tabBar.children].forEach(t => t.classList.toggle("active", t.dataset.win === id));
        [...this.contentBox.children].forEach(p => p.classList.toggle("active", p.dataset.win === id));
    }

    clear() {
        [...this.tabBar.children].forEach(t => t.classList.remove("active"));
        [...this.contentBox.children].forEach(p => p.classList.remove("active"));
    }

    count() {
        return this.tabBar.children.length;
    }
}

function tabs(area) {
    return tabsCache.get(area) || tabsCache.set(area, new DockTabs(area)).get(area);
}

/***********************************************************************
 * Overlay highlight logic
 ***********************************************************************/
const showOverlays = (yes=true) =>
    overlayAreas.forEach(a => a.style.display = yes ? "block":"none");

function nearestOverlay(win) {
    const rect = win.getBoundingClientRect();
    const cx = rect.left + rect.width/2;
    const cy = rect.top  + rect.height/2;

    let best = null, bestDist = 99999;
    for (const area of overlayAreas) {
        const r = area.getBoundingClientRect();
        const dx = cx - (r.left + r.width/2);
        const dy = cy - (r.top  + r.height/2);
        const dist = Math.hypot(dx,dy);

        if (dist < bestDist && dist < 180) {
            bestDist = dist;
            best = area;
        }
    }
    return best;
}

/***********************************************************************
 * Dock / Undock
 ***********************************************************************/
function undock(win, {revealOnly=false}={}) {
    const area = dockMap.get(win);
    if (!area) return;

    const t = tabs(area);
    const panel = t.contentBox.querySelector(`[data-win="${win.dataset.id}"]`);

    const content = panel.querySelector(".window-content");
    if (content) win.appendChild(content);

    t.remove(win);
    dockMap.delete(win);

    if (t.count() === 0) area.style.display = "none";

    if (!revealOnly) {
        const s = originalSize.get(win);
        win.style.width  = s.w + "px";
        win.style.height = s.h + "px";
    }

    win.style.display = "block";
    win.style.zIndex = ++zIndexCounter;
}

function dock(win, overlay) {
    const type = Object.keys(areaByType).find(t => overlay.classList.contains(t));
    if (!type) return;

    const area = areaByType[type];
    undock(win, {revealOnly:true});

    win.style.display = "none";
    dockMap.set(win, area);
    tabs(area).add(win);
    area.style.display = "block";

    updateLayout();
}

/***********************************************************************
 * Layout
 ***********************************************************************/
function updateLayout() {
    const counts = {};
    for (const type in areaByType) {
        const area = areaByType[type];
        const count = tabs(area).count();
        counts[type] = count;
        area.style.display = (count || type==="center") ? "block" : "none";
    }

    const W = container.clientWidth;
    const H = container.clientHeight;

    const baseW=220, growW=40, baseH=140, growH=30;

    const left   = counts.left   ? savedSizes.left   ?? Math.min(W*0.4, baseW+(counts.left-1)*growW) : 0;
    const right  = counts.right  ? savedSizes.right  ?? Math.min(W*0.4, baseW+(counts.right-1)*growW) : 0;
    const top    = counts.top    ? savedSizes.top    ?? Math.min(H*0.35,baseH+(counts.top -1)*growH) : 0;
    const bottom = counts.bottom ? savedSizes.bottom ?? Math.min(H*0.35,baseH+(counts.bottom-1)*growH) : 0;

    container.style.setProperty("--dock-left-width",   left+"px");
    container.style.setProperty("--dock-right-width",  right+"px");
    container.style.setProperty("--dock-top-height",   top+"px");
    container.style.setProperty("--dock-bottom-height",bottom+"px");

    updateSplitters();
}

/***********************************************************************
 * Splitters (generalized)
 ***********************************************************************/
const splitterConfigs = [
    {dir:"left",   css:"--dock-left-width",   axis:"x", min:80, sign:+1},
    {dir:"right",  css:"--dock-right-width",  axis:"x", min:80, sign:-1},
    {dir:"top",    css:"--dock-top-height",   axis:"y", min:60, sign:+1},
    {dir:"bottom", css:"--dock-bottom-height",axis:"y", min:60, sign:-1}
];

let activeSplit = null;
let startPos = 0;
let startSize = 0;

splitterConfigs.forEach(cfg => {
    cfg.el = document.querySelector(`.splitter.${cfg.dir}`);
    cfg.el.addEventListener("pointerdown", e => {
        e.preventDefault();
        beginResize(cfg, e);
    });
});

function updateSplitters() {
    for (const cfg of splitterConfigs) {
        const area = areaByType[cfg.dir];
        cfg.el.style.display = tabs(area).count() ? "block" : "none";
    }
}

function beginResize(cfg, e) {
    activeSplit = cfg;
    startPos = (cfg.axis==="x"? e.clientX : e.clientY);
    startSize = parseFloat(getComputedStyle(container).getPropertyValue(cfg.css));

    document.addEventListener("pointermove", doResize);
    document.addEventListener("pointerup", endResize);
}

function doResize(e) {
    if (!activeSplit) return;

    const pos = activeSplit.axis==="x" ? e.clientX : e.clientY;
    const delta = (pos - startPos) * activeSplit.sign;
    const newSize = Math.max(activeSplit.min, startSize + delta);

    container.style.setProperty(activeSplit.css, newSize+"px");
}

function endResize() {
    const cfg = activeSplit;
    if (cfg) {
        const v = parseFloat(getComputedStyle(container).getPropertyValue(cfg.css));
        savedSizes[cfg.dir] = v;
    }
    activeSplit = null;

    document.removeEventListener("pointermove", doResize);
    document.removeEventListener("pointerup", endResize);
}

/***********************************************************************
 * Dragging
 ***********************************************************************/
windows.forEach((win,i) => {
    win.dataset.id ||= String(i);

    const r = win.getBoundingClientRect();
    originalSize.set(win,{w:r.width,h:r.height});

    const header = win.querySelector("header");
    header.style.touchAction = "none";
    header.addEventListener("pointerdown", e => beginDrag(win,e));

    win.style.position ||= "absolute";
});

function beginDrag(win,e) {
    e.preventDefault();
    dragged = win;

    if (dockMap.has(win)) undock(win,{revealOnly:true});

    const r = win.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    dragOffsetX = e.clientX - r.left;
    dragOffsetY = e.clientY - r.top;

    win.style.zIndex = ++zIndexCounter;
    win.style.display = "block";
    win.style.left = (r.left - c.left) + "px";
    win.style.top  = (r.top  - c.top ) + "px";

    showOverlays(true);

    document.addEventListener("pointermove", onDrag);
    document.addEventListener("pointerup", endDrag);

    e.target.setPointerCapture?.(e.pointerId);
}

function onDrag(e) {
    if (!dragged) return;
    const c = container.getBoundingClientRect();

    dragged.style.left = Math.max(0, e.clientX - c.left - dragOffsetX) + "px";
    dragged.style.top  = Math.max(0, e.clientY - c.top  - dragOffsetY) + "px";

    overlayAreas.forEach(a => a.classList.remove("hovered"));
    snapTarget = nearestOverlay(dragged);
    snapTarget?.classList.add("hovered");
}

function endDrag() {
    if (!dragged) return;

    if (snapTarget) dock(dragged, snapTarget);
    else {
        dockMap.delete(dragged);
        updateLayout();
    }

    showOverlays(false);
    dragged = null;
    snapTarget = null;

    document.removeEventListener("pointermove", onDrag);
    document.removeEventListener("pointerup", endDrag);
}

/***********************************************************************
 * Initialize
 ***********************************************************************/
updateLayout();
