/* =========================================================================
 * Web Dashers — Level Editor
 * Standalone Phaser scene for building levels. Reuses the play engine's
 * object database (allobjects), sprite atlases and the GD level-string
 * format, so anything built here round-trips through parseLevel() and plays
 * in the existing GameScene unchanged.
 *
 * Coordinate system (matches the play engine):
 *   worldX = gdX * 2        (2 px per GD unit; one 30-unit cell = 60 px)
 *   worldY = -gdY * 2       (GD +y is up; screen +y is down)
 *   ground line sits at worldY = 0
 * ========================================================================= */

const ED_PX = 2;
const ED_CELL_UNITS = 30;
const ED_CELL_PX = ED_CELL_UNITS * ED_PX; // 60 px / cell @ zoom 1

const ED_PANEL_H = 118;
const ED_TOPBAR_H = 52;

// 2.2 animation triggers exposed in the editor. Defaults target group 1, so the
// flow is: select object(s) -> G (set group 1) -> drop a trigger -> Playtest.
// (T re-configures a selected trigger.) The play engine applies these by group.
const ED_TRIGGERS = {
  899:  { name: "Color",  color: 0x4cd07a, defs: { 23: 1, 7: 255, 8: 90, 9: 60, 10: 0.5 } },
  901:  { name: "Move",   color: 0x8e5bff, defs: { 51: 1, 28: 90, 29: 0, 10: 0.5, 30: 0, 85: 2 } },
  1006: { name: "Pulse",  color: 0xff5bd0, defs: { 51: 1, 52: 1, 7: 120, 8: 255, 9: 255, 45: 0.2, 46: 0.4, 47: 0.4 } },
  1007: { name: "Alpha",  color: 0x2bd6c6, defs: { 51: 1, 10: 0.5, 35: 0 } },
  1346: { name: "Rotate", color: 0xff9b3d, defs: { 51: 1, 68: 180, 10: 0.6, 30: 0, 85: 2 } },
  1049: { name: "Toggle", color: 0xe8c33a, defs: { 51: 1, 56: 0 } },
  1520: { name: "Shake",  color: 0xff6b4a, defs: { 75: 15, 10: 0.5 } },
  1268: { name: "Spawn",  color: 0x5ad1ff, defs: { 51: 1, 63: 0.5 } },
  2067: { name: "Scale",  color: 0xb084ff, defs: { 51: 1, 150: 1.5, 10: 0.5 } },
  1913: { name: "Zoom",   color: 0x84ffd1, defs: { 150: 1.4, 10: 0.6 } },
};

class EditorScene extends Phaser.Scene {
  constructor() { super({ key: "EditorScene" }); }

  init(data) {
    this.level = (data && data.level) || { levelName: "Unnamed", levelString: "", createdId: "local_tmp", songId: -1 };
    this.objects = [];
    this.settingsStr = "";
    this.colors = {};                 // channel id -> {r,g,b}
    this.selection = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.currentPlaceId = 1;
    this.mode = "build";              // build | edit | delete
    this._panning = false;
    this._spaceDown = false;
    this._paintCells = null;          // dedupe set during a paint stroke
    this._strokeAdds = null;          // objects added during current stroke
    this._dragMove = null;            // active edit-mode drag
  }

  /* ----------------------------------------------------------------------- */
  create() {
    window.isEditor = true;
    this._ao = window.allobjects ? window.allobjects() : {};

    this.worldLayer = this.add.container(0, 0);
    this.objectLayer = this.add.container(0, 0);
    this.selGfx = this.add.graphics();
    this._gridGfx = this.add.graphics();
    this.worldLayer.add([this._gridGfx, this.objectLayer, this.selGfx]);
    this.uiLayer = this.add.container(0, 0).setScrollFactor(0).setDepth(1000);

    this._setupCameras();
    this._parseColors(null); // defaults until level loads
    this._loadLevelString(this.level.levelString || "");
    this._buildPaletteData();
    this._buildToolbar();
    this._buildPalette();
    this._setupInput();

    const firstX = this.objects.length
      ? this.objects.reduce((m, o) => Math.min(m, o.x), Infinity) * ED_PX
      : 0;
    this.cameras.main.setScroll((isFinite(firstX) ? firstX : 0) - 200, -(screenHeight - 240));
  }

  _setupCameras() {
    const cam = this.cameras.main;
    cam.setBackgroundColor("#287dff");
    this.uiCam = this.cameras.add(0, 0, screenWidth, screenHeight);
    this.uiCam.setName("ui");
    cam.ignore(this.uiLayer);
    this.uiCam.ignore(this.worldLayer);
  }

  /* --- coordinate helpers ------------------------------------------------ */
  unitsToWorldX(ux) { return ux * ED_PX; }
  unitsToWorldY(uy) { return -uy * ED_PX; }
  worldToUnitsX(wx) { return wx / ED_PX; }
  worldToUnitsY(wy) { return -wy / ED_PX; }
  snapUnits(u) { return Math.round((u - 15) / ED_CELL_UNITS) * ED_CELL_UNITS + 15; }

  /* --- colors (so objects look like the real game) ----------------------- */
  _parseColors(settingsStr) {
    const colors = {
      1000: { r: 40, g: 125, b: 255 }, 1001: { r: 0, g: 102, b: 255 },
      1004: { r: 255, g: 255, b: 255 }, 1: { r: 255, g: 255, b: 255 },
      2: { r: 255, g: 255, b: 255 }, 1006: { r: 255, g: 255, b: 255 },
    };
    if (settingsStr) {
      const map = {};
      const pairs = settingsStr.split(",");
      for (let i = 0; i + 1 < pairs.length; i += 2) map[pairs[i]] = pairs[i + 1];
      const colStr = map["kS38"];
      if (colStr) {
        for (const ch of colStr.split("|")) {
          if (!ch) continue;
          const props = ch.split("_");
          const cp = {};
          for (let j = 0; j + 1 < props.length; j += 2) cp[parseInt(props[j], 10)] = props[j + 1];
          const id = parseInt(cp[6], 10);
          if (!isNaN(id)) colors[id] = { r: +cp[1] || 0, g: +cp[2] || 0, b: +cp[3] || 0 };
        }
      }
    }
    this.colors = colors;
  }

  _channelTint(ch) {
    const c = this.colors[ch];
    if (!c) return null;
    return (c.r << 16) | (c.g << 8) | c.b;
  }

  /* --- load / render ----------------------------------------------------- */
  _loadLevelString(levelString) {
    this.objects.forEach((o) => (o._sprites || []).forEach((s) => s.destroy()));
    this.objects = [];
    this.objectLayer.removeAll(true);
    this.settingsStr = EditorScene.DEFAULT_SETTINGS;
    if (!levelString) { this._parseColors(this.settingsStr); return; }
    let parsed;
    try { parsed = parseLevel(levelString); }
    catch (e) { console.warn("[editor] parse failed:", e); this._parseColors(this.settingsStr); return; }
    this.settingsStr = parsed.settings || EditorScene.DEFAULT_SETTINGS;
    this._parseColors(this.settingsStr);
    for (const o of parsed.objects) { this.objects.push(o); this._renderObject(o); }
  }

  _renderObject(obj) {
    (obj._sprites || []).forEach((s) => s.destroy());
    obj._sprites = [];
    const def = this._ao[obj.id];
    const frame = def && def.frame;
    const wx = this.unitsToWorldX(obj.x), wy = this.unitsToWorldY(obj.y);
    let spr = frame ? addImageToScene(this, wx, wy, frame) : null;
    if (!spr && (ED_TRIGGERS[obj.id] || (def && def.type === "trigger"))) {
      const m = this._makeTriggerMarker(wx, wy, obj);
      this.objectLayer.add(m); obj._sprites.push(m); m._edObj = obj;
      return;
    }
    if (!spr) spr = this._makeFallback(wx, wy, def);
    if (!spr) { obj._noVisual = true; return; }
    this._applyObjVisual(spr, frame, obj, def);

    // Tint by colour channel so the canvas reads like the real game.
    if (!spr._wdFallback && def && def.can_color !== false) {
      let ch = obj.color1 || def.default_base_color_channel || 0;
      if (ch === 0 && (def.type === "solid" || def.type === "hazard")) ch = 1004;
      const tint = this._channelTint(ch);
      if (tint !== null && ch !== 1004) spr.setTint(tint);
    }
    this.objectLayer.add(spr);
    obj._sprites.push(spr);
    spr._edObj = obj;
  }

  _applyObjVisual(spr, frame, obj, def) {
    let dx = 0, dy = 0;
    if (frame) {
      const info = getAtlasFrame(this, frame);
      if (info) {
        const f = this.textures.get(info.atlas).get(info.frame);
        const cd = (f && f.customData) || {};
        if (cd.gjSpriteOffset) { dx = cd.gjSpriteOffset.x || 0; dy = -(cd.gjSpriteOffset.y || 0); }
        else if (f) {
          const sx = cd.spriteSourceSize ? cd.spriteSourceSize.x || 0 : 0;
          const sy = cd.spriteSourceSize ? cd.spriteSourceSize.y || 0 : 0;
          dx = f.realWidth / 2 - (sx + f.width / 2);
          dy = f.realHeight / 2 - (sy + f.height / 2);
        }
      }
    }
    if (obj.flipX) { spr.setFlipX(true); dx = -dx; }
    if (obj.flipY) { spr.setFlipY(true); dy = -dy; }
    const rot = obj.rot || 0;
    if (rot) {
      spr.setAngle(rot);
      const rad = (rot * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
      const rx = dx * c - dy * s, ry = dx * s + dy * c; dx = rx; dy = ry;
    }
    spr.x += dx; spr.y += dy;
    if (obj.scale && obj.scale !== 1) spr.setScale(obj.scale);
    const zL = obj.zLayer || (def && def.default_z_layer) || 0;
    const zO = obj.zOrder || (def && def.default_z_order) || 0;
    const dB = { "-3": -6, "-1": -3, 0: 0, 1: 3, 3: 6, 5: 9 };
    spr.setDepth((dB[zL] !== undefined ? dB[zL] : 0) + zO * 0.01);
  }

  _makeFallback(wx, wy, def) {
    if (!this.textures.exists("__wd_fallback")) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0xffffff, 1); g.fillRect(0, 0, 30, 30);
      g.generateTexture("__wd_fallback", 30, 30); g.destroy();
    }
    const type = def && def.type;
    if (type === "trigger") return null;
    const spr = this.add.image(wx, wy, "__wd_fallback");
    const gw = (def && def.gridW) || 1, gh = (def && def.gridH) || 1;
    spr.setDisplaySize(Math.max(8, gw * ED_CELL_PX), Math.max(8, gh * ED_CELL_PX));
    let tint = 0xffffff, alpha = 0.5;
    if (type === "hazard") { tint = 0xff3b3b; alpha = 0.85; }
    else if (type === "solid") { tint = 0x9aa0a6; alpha = 0.9; }
    spr.setTint(tint); spr.setAlpha(alpha); spr._wdFallback = true;
    return spr;
  }

  // Triggers have no sprite frame, so show them as a labelled marker you can
  // select/move/configure like any object.
  _makeTriggerMarker(wx, wy, obj) {
    const t = ED_TRIGGERS[obj.id] || { name: "T", color: 0x999999 };
    const c = this.add.container(wx, wy);
    const g = this.add.graphics();
    g.fillStyle(t.color, 0.92).fillRoundedRect(-15, -15, 30, 30, 5);
    g.lineStyle(2, 0xffffff, 0.75).strokeRoundedRect(-15, -15, 30, 30, 5);
    const lbl = this.add.bitmapText(0, 1, "bigFont", t.name[0] + (obj._raw && obj._raw[51] ? obj._raw[51] : (obj._raw && obj._raw[23] ? obj._raw[23] : "")), 16).setOrigin(0.5);
    c.add([g, lbl]);
    c.setDepth(60);
    c._wdTrigger = true;
    return c;
  }

  /* --- grid -------------------------------------------------------------- */
  _drawGrid() {
    const g = this._gridGfx, cam = this.cameras.main, z = cam.zoom;
    g.clear();
    const left = cam.scrollX, top = cam.scrollY;
    const right = left + screenWidth / z, bottom = top + screenHeight / z;
    const step = ED_CELL_PX;
    g.lineStyle(1, 0xffffff, 0.10);
    for (let x = Math.floor(left / step) * step; x <= right; x += step) g.lineBetween(x, top, x, bottom);
    for (let y = Math.floor(top / step) * step; y <= bottom; y += step) g.lineBetween(left, y, right, y);
    g.lineStyle(3, 0xffffff, 0.55); g.lineBetween(left, 0, right, 0);
    g.lineStyle(2, 0x00ff88, 0.5); g.lineBetween(0, top, 0, bottom);
  }

  _drawSelection() {
    const g = this.selGfx; g.clear();
    if (!this.selection.size) return;
    g.lineStyle(2, 0x00e1ff, 1);
    for (const obj of this.selection) {
      const s = (obj._sprites || [])[0];
      if (!s) continue;
      const b = s.getBounds();
      g.strokeRect(b.x, b.y, b.width, b.height);
    }
  }

  /* --- toolbar / UI ------------------------------------------------------ */
  _uiButton(x, y, w, label, cb, opts = {}) {
    const h = opts.h || 40;
    const color = opts.color !== undefined ? opts.color : 0x2c3e50;
    const g = this.add.graphics();
    const paint = (on) => { g.clear(); g.fillStyle(on ? 0x27ae60 : color, 0.92).fillRoundedRect(x, y, w, h, 8); g.lineStyle(2, 0xffffff, on ? 0.6 : 0.25).strokeRoundedRect(x, y, w, h, 8); };
    paint(false);
    const t = this.add.bitmapText(x + w / 2, y + h / 2 + 1, "bigFont", label, opts.size || 20).setOrigin(0.5);
    const zone = this.add.zone(x, y, w, h).setOrigin(0).setInteractive({ useHandCursor: true });
    zone.on("pointerdown", (p, lx, ly, ev) => { if (ev) ev.stopPropagation(); cb(); });
    this.uiLayer.add([g, t, zone]);
    return { g, t, zone, setActive: paint, setLabel: (s) => t.setText(s) };
  }

  _buildToolbar() {
    const top = this.add.graphics(); top.fillStyle(0x10161f, 0.9).fillRect(0, 0, screenWidth, ED_TOPBAR_H); this.uiLayer.add(top);
    const bot = this.add.graphics(); bot.fillStyle(0x10161f, 0.9).fillRect(0, screenHeight - 52, screenWidth, 52); this.uiLayer.add(bot);

    this._uiButton(10, 6, 86, "Menu", () => this._exitToMenu(), { color: 0x7f3b3b });
    this._title = this.add.bitmapText(108, 26, "bigFont", this.level.levelName || "Unnamed", 22).setOrigin(0, 0.5);
    this._countTxt = this.add.bitmapText(screenWidth / 2, 16, "bigFont", "", 16).setOrigin(0.5);
    this.uiLayer.add([this._title, this._countTxt]);

    let rx = screenWidth - 10;
    const add = (label, cb, opts) => { const w = (opts && opts.w) || 96; rx -= w; const b = this._uiButton(rx, 6, w, label, cb, opts); rx -= 8; return b; };
    add("Playtest", () => this._playtest(), { color: 0x27ae60, w: 112 });
    add("Save", () => this._save(true), { color: 0x2c7be5 });

    const by = screenHeight - 46;
    this._modeBtns = {
      build: this._uiButton(10, by, 84, "Build", () => this._setMode("build")),
      edit: this._uiButton(98, by, 84, "Edit", () => this._setMode("edit")),
      delete: this._uiButton(186, by, 84, "Delete", () => this._setMode("delete"), { color: 0x7f3b3b }),
    };
    this._undoBtn = this._uiButton(screenWidth - 286, by, 84, "Undo", () => this._undo());
    this._redoBtn = this._uiButton(screenWidth - 196, by, 84, "Redo", () => this._redo());
    this._delSelBtn = this._uiButton(screenWidth - 102, by, 92, "Del Sel", () => this._deleteSelection());
    this._uiButton(296, by, 84, "Anim", () => {
      const k = window.prompt("Add an animated gadget:\n  1 = Spinner   2 = Slider   3 = Riser   4 = Pulser   5 = Fader\n  6 = Oscillator   7 = Vanisher   8 = Burst (spawn)   9 = Pump (scale)", "1");
      if (k === null) return;
      this._addPreset(({ 1: "spinner", 2: "slider", 3: "riser", 4: "pulser", 5: "fader", 6: "oscillator", 7: "vanisher", 8: "burst", 9: "pump" })[parseInt(k, 10)] || "spinner");
    }, { color: 0x6f42c1 });
    this._uiButton(388, by, 84, "Group", () => this._setGroupOnSelection(), { color: 0x2c7be5 });
    this._uiButton(480, by, 84, "Cfg FX", () => this._configSelectedTrigger(), { color: 0x2c7be5 });
    this._refreshCounter();
  }

  _refreshCounter() {
    if (this._countTxt) this._countTxt.setText(this.objects.length + " objects   |   sel: " + this.selection.size);
  }
  _setMode(mode) {
    this.mode = mode;
    if (this._modeBtns) for (const k of Object.keys(this._modeBtns)) this._modeBtns[k].setActive(k === mode);
    if (mode !== "edit") this._clearSelection();
  }
  _toast(msg) {
    const t = this.add.bitmapText(screenWidth / 2, 74, "bigFont", msg, 26).setOrigin(0.5).setDepth(2000);
    this.uiLayer.add(t);
    this.tweens.add({ targets: t, alpha: 0, y: 56, duration: 900, delay: 400, onComplete: () => t.destroy() });
  }

  /* --- palette ----------------------------------------------------------- */
  _buildPaletteData() {
    const ao = this._ao;
    const cats = { Block: [], Spike: [], Slope: [], Portal: [], Orbs: [], Deco: [], "2.2": [], FX: [] };
    for (const idStr of Object.keys(ao)) {
      const id = +idStr, d = ao[idStr];
      if (!d || !d.frame) continue;
      const t = d.type;
      if (t === "solid") cats.Block.push(id);
      else if (t === "hazard") cats.Spike.push(id);
      else if (t === "slope") cats.Slope.push(id);
      else if (t === "portal" || t === "speed") cats.Portal.push(id);
      else if (t === "pad" || t === "ring") cats.Orbs.push(id);
      else if (t === "deco") cats.Deco.push(id);
      if (id >= 1000) cats["2.2"].push(id); // 2.2-era art (any type)
    }
    for (const k of Object.keys(cats)) cats[k].sort((a, b) => a - b);
    // Common, hand-picked first entries so the palette opens on useful objects.
    const favs = { Block: [1, 2, 3, 4, 5, 6, 7], Spike: [8, 39, 103, 392], Portal: [12, 13, 47, 111, 660, 745, 10, 11, 45, 99, 101], Orbs: [36, 141, 84, 1022, 35, 67] };
    for (const k of Object.keys(favs)) { const set = new Set(cats[k]); cats[k] = [...favs[k].filter((i) => set.has(i)), ...cats[k].filter((i) => !favs[k].includes(i))]; }
    cats.FX = Object.keys(ED_TRIGGERS).map(Number).filter((id) => this._ao[id]); // animation triggers
    this.paletteCats = cats;
    this.paletteCategory = "Block";
  }

  _buildPalette() {
    const panelTop = screenHeight - 52 - ED_PANEL_H;
    const bg = this.add.graphics();
    bg.fillStyle(0x0c1118, 0.94).fillRect(0, panelTop, screenWidth, ED_PANEL_H);
    bg.lineStyle(2, 0xffffff, 0.12).lineBetween(0, panelTop, screenWidth, panelTop);
    this.uiLayer.add(bg);
    this._palettePanelTop = panelTop;

    // Category tabs.
    this._tabBtns = {};
    let tx = 10;
    for (const cat of Object.keys(this.paletteCats)) {
      const w = 78;
      const b = this._uiButton(tx, panelTop + 6, w, cat, () => this._selectCategory(cat), { h: 26, size: 15 });
      this._tabBtns[cat] = b; tx += w + 6;
    }

    // Pagination + find-by-id controls (right side of the tab row).
    this._palettePage = 0;
    this._prevPageBtn = this._uiButton(screenWidth - 272, panelTop + 6, 46, "Prev", () => this._changePage(-1), { h: 26, size: 13 });
    this._pageLbl = this.add.bitmapText(screenWidth - 220, panelTop + 19, "goldFont", "1/1", 14).setOrigin(0.5);
    this.uiLayer.add(this._pageLbl);
    this._nextPageBtn = this._uiButton(screenWidth - 200, panelTop + 6, 46, "Next", () => this._changePage(1), { h: 26, size: 13 });
    this._uiButton(screenWidth - 146, panelTop + 6, 66, "Find ID", () => this._promptFindId(), { h: 26, size: 13, color: 0x2c7be5 });

    // Scrollable thumbnail strip.
    this._stripTop = panelTop + 40;
    this._stripH = 70;
    this._stripContainer = this.add.container(0, 0);
    this.uiLayer.add(this._stripContainer);
    const maskG = this.make.graphics({ add: false });
    maskG.fillRect(0, this._stripTop, screenWidth, this._stripH);
    this._stripContainer.setMask(maskG.createGeometryMask());
    // The mask geometry is in screen space; keep a ref so uiCam shows it.
    this._stripScroll = 0;
    this._selectCategory(this.paletteCategory);
  }

  _selectCategory(cat) {
    if (cat !== this.paletteCategory) this._palettePage = 0;
    this.paletteCategory = cat;
    for (const k of Object.keys(this._tabBtns)) this._tabBtns[k].setActive(k === cat);
    this._stripContainer.removeAll(true);
    this._stripContainer.x = 0;
    this._stripScroll = 0;
    const allIds = this.paletteCats[cat] || [];
    const PAGE = 80;
    this._paletteTotalPages = Math.max(1, Math.ceil(allIds.length / PAGE));
    this._palettePage = Phaser.Math.Clamp(this._palettePage || 0, 0, this._paletteTotalPages - 1);
    const ids = allIds.slice(this._palettePage * PAGE, (this._palettePage + 1) * PAGE);
    this._updatePageLabel();
    const cell = 60, pad = 8;
    let x = pad;
    this._thumbCells = [];
    const maxItems = ids.length;
    for (let i = 0; i < maxItems; i++) {
      const id = ids[i];
      const def = this._ao[id];
      const cx = x + cell / 2, cy = this._stripTop + this._stripH / 2;
      const back = this.add.graphics();
      back.fillStyle(0x1b2430, 1).fillRoundedRect(x, this._stripTop + 3, cell, this._stripH - 6, 6);
      back.lineStyle(2, 0xffffff, 0.12).strokeRoundedRect(x, this._stripTop + 3, cell, this._stripH - 6, 6);
      const thumb = def.frame ? addImageToScene(this, cx, cy, def.frame) : null;
      if (thumb) {
        const maxDim = Math.max(thumb.width, thumb.height) || 60;
        const sc = Math.min(1, (cell - 16) / maxDim);
        thumb.setScale(sc);
        if (def.type === "solid") thumb.setTint(0xdddddd);
      } else if (ED_TRIGGERS[id]) {
        const nm = this.add.bitmapText(cx, cy - 2, "bigFont", ED_TRIGGERS[id].name, 13).setOrigin(0.5).setTint(ED_TRIGGERS[id].color);
        this._stripContainer.add(nm);
      }
      const label = this.add.bitmapText(cx, this._stripTop + this._stripH - 8, "goldFont", String(id), 12).setOrigin(0.5);
      const zone = this.add.zone(x, this._stripTop + 3, cell, this._stripH - 6).setOrigin(0).setInteractive({ useHandCursor: true });
      zone.on("pointerup", (p, lx, ly, ev) => { if (!this._stripDidScroll) this._selectPaletteItem(id); });
      const items = [back]; if (thumb) items.push(thumb); items.push(label, zone);
      this._stripContainer.add(items);
      this._thumbCells.push({ id, back, x });
      x += cell + pad;
    }
    this._stripContentW = x;
    this._highlightSelectedThumb();
  }

  _highlightSelectedThumb() {
    if (!this._thumbCells) return;
    for (const c of this._thumbCells) {
      c.back.clear();
      const on = c.id === this.currentPlaceId;
      c.back.fillStyle(on ? 0x27506e : 0x1b2430, 1).fillRoundedRect(c.x, this._stripTop + 3, 60, this._stripH - 6, 6);
      c.back.lineStyle(2, on ? 0x00e1ff : 0xffffff, on ? 1 : 0.12).strokeRoundedRect(c.x, this._stripTop + 3, 60, this._stripH - 6, 6);
    }
  }

  _selectPaletteItem(id) {
    this.currentPlaceId = id;
    this._setMode("build");
    this._highlightSelectedThumb();
    this._toast("Selected #" + id);
  }

  _scrollStrip(dx) {
    const maxScroll = Math.max(0, this._stripContentW - screenWidth + 10);
    this._stripScroll = Phaser.Math.Clamp(this._stripScroll - dx, -maxScroll, 0);
    this._stripContainer.x = this._stripScroll;
  }
  _changePage(d) {
    this._palettePage = Phaser.Math.Clamp((this._palettePage || 0) + d, 0, (this._paletteTotalPages || 1) - 1);
    this._selectCategory(this.paletteCategory);
  }
  _updatePageLabel() {
    if (this._pageLbl) this._pageLbl.setText(((this._palettePage || 0) + 1) + "/" + (this._paletteTotalPages || 1));
  }
  _promptFindId() {
    const v = window.prompt("Place object by ID (1-4539):", String(this.currentPlaceId || 1));
    if (v == null) return;
    const id = parseInt(v, 10);
    if (!isNaN(id) && this._ao[id]) this._selectPaletteItem(id);
    else this._toast("No object #" + v);
  }

  /* --- input ------------------------------------------------------------- */
  _overUI(p) { return p.y < ED_TOPBAR_H + 2 || p.y > this._palettePanelTop - 2; }

  _setupInput() {
    const cam = this.cameras.main;

    this.input.on("pointerdown", (p) => {
      if (this._overUI(p)) {
        // Inside the palette strip: begin potential horizontal scroll-drag.
        if (p.y >= this._stripTop && p.y <= this._stripTop + this._stripH) { this._stripDrag = { x: p.x, scroll: this._stripScroll }; this._stripDidScroll = false; }
        return;
      }
      const usePan = this._spaceDown || p.rightButtonDown();
      if (usePan) { this._panning = true; this._panStart = { x: p.x, y: p.y, sx: cam.scrollX, sy: cam.scrollY }; return; }
      if (this.mode === "build") this._beginStroke(p);
      else if (this.mode === "delete") { this._erasing = true; this._eraseAtPointer(p); }
      else if (this.mode === "edit") this._beginEdit(p);
    });

    this.input.on("pointermove", (p) => {
      if (this._stripDrag) { const dx = p.x - this._stripDrag.x; if (Math.abs(dx) > 4) this._stripDidScroll = true; this._stripScroll = this._stripDrag.scroll + dx; this._scrollStrip(0); this._stripContainer.x = Phaser.Math.Clamp(this._stripScroll, -(Math.max(0, this._stripContentW - screenWidth + 10)), 0); return; }
      if (this._panning && this._panStart) {
        cam.scrollX = this._panStart.sx - (p.x - this._panStart.x) / cam.zoom;
        cam.scrollY = this._panStart.sy - (p.y - this._panStart.y) / cam.zoom; return;
      }
      if (this._strokeAdds && p.isDown) this._paintAt(p);
      else if (this._erasing && p.isDown) this._eraseAtPointer(p);
      else if (this._dragMove && p.isDown) this._updateDragMove(p);
    });

    const end = (p) => {
      this._stripDrag = null;
      this._panning = false; this._panStart = null;
      if (this._strokeAdds) this._endStroke();
      this._erasing = false;
      if (this._dragMove) this._endDragMove();
    };
    this.input.on("pointerup", end);
    this.input.on("pointerupoutside", end);

    this.input.on("wheel", (p, over, dx, dy) => {
      if (p.y >= this._stripTop && p.y <= this._stripTop + this._stripH) { this._scrollStrip(-dy); return; }
      const before = cam.getWorldPoint(p.x, p.y);
      cam.zoom = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.15, 3);
      const after = cam.getWorldPoint(p.x, p.y);
      cam.scrollX += before.x - after.x; cam.scrollY += before.y - after.y;
    });

    const kb = this.input.keyboard;
    kb.on("keydown-SPACE", () => { this._spaceDown = true; });
    kb.on("keyup-SPACE", () => { this._spaceDown = false; });
    kb.on("keydown-ESC", () => this._exitToMenu());
    kb.on("keydown-DELETE", () => this._deleteSelection());
    kb.on("keydown-BACKSPACE", () => this._deleteSelection());
    kb.on("keydown-R", () => this._rotateSelection(90));
    kb.on("keydown-F", () => this._flipSelection("x"));
    kb.on("keydown-V", (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this._paste(); } else this._flipSelection("y"); });
    kb.on("keydown-C", (e) => { if (e.ctrlKey || e.metaKey) this._copySelection(); });
    kb.on("keydown-B", () => this._setMode("build"));
    kb.on("keydown-E", () => this._setMode("edit"));
    kb.on("keydown-D", (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this._duplicate(); } else this._setMode("delete"); });
    kb.on("keydown-Z", (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.shiftKey ? this._redo() : this._undo(); } });
    kb.on("keydown-Y", (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this._redo(); } });
    kb.on("keydown-S", (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this._save(true); } });
    kb.on("keydown-G", () => this._setGroupOnSelection());
    kb.on("keydown-T", () => this._configSelectedTrigger());
    this._cursors = kb.createCursorKeys();
  }

  update() {
    this._drawGrid();
    this._drawSelection();
    const cam = this.cameras.main, sp = 12 / cam.zoom;
    if (this._cursors && !this._activeTextInput) {
      if (this._cursors.left.isDown) cam.scrollX -= sp;
      if (this._cursors.right.isDown) cam.scrollX += sp;
      if (this._cursors.up.isDown) cam.scrollY -= sp;
      if (this._cursors.down.isDown) cam.scrollY += sp;
    }
  }

  /* --- placement (build) ------------------------------------------------- */
  _pointerUnits(p) {
    const w = this.cameras.main.getWorldPoint(p.x, p.y);
    return { ux: this.snapUnits(this.worldToUnitsX(w.x)), uy: this.snapUnits(this.worldToUnitsY(w.y)) };
  }
  _beginStroke(p) { this._paintCells = new Set(); this._strokeAdds = []; this._paintAt(p); }
  _paintAt(p) {
    const { ux, uy } = this._pointerUnits(p);
    const key = this.currentPlaceId + ":" + ux + ":" + uy;
    if (this._paintCells.has(key)) return;
    // Skip if an identical object already exists in this cell.
    if (this.objects.some((o) => o.id === this.currentPlaceId && o.x === ux && o.y === uy)) { this._paintCells.add(key); return; }
    this._paintCells.add(key);
    const obj = { id: this.currentPlaceId, x: ux, y: uy, flipX: false, flipY: false, rot: 0, scale: 1, zLayer: 0, zOrder: 0, color1: 0, color2: 0, groups: "", _raw: { 1: this.currentPlaceId, 2: ux, 3: uy } };
    if (ED_TRIGGERS[this.currentPlaceId]) Object.assign(obj._raw, ED_TRIGGERS[this.currentPlaceId].defs);
    this.objects.push(obj); this._renderObject(obj); this._strokeAdds.push(obj);
    this._refreshCounter();
  }
  _endStroke() {
    if (this._strokeAdds && this._strokeAdds.length) this._commit({ type: "add", objs: this._strokeAdds.slice() });
    this._strokeAdds = null; this._paintCells = null;
  }

  /* --- delete ------------------------------------------------------------ */
  _objectsAtPointer(p) {
    const w = this.cameras.main.getWorldPoint(p.x, p.y);
    const hits = [];
    for (const o of this.objects) { const s = (o._sprites || [])[0]; if (s && s.getBounds().contains(w.x, w.y)) hits.push(o); }
    return hits;
  }
  _eraseAtPointer(p) {
    const hits = this._objectsAtPointer(p);
    if (!hits.length) return;
    const top = hits[hits.length - 1];
    this._removeObject(top);
    this._commit({ type: "remove", objs: [top] }, true);
    this._refreshCounter();
  }
  _removeObject(obj) {
    (obj._sprites || []).forEach((s) => s.destroy());
    const i = this.objects.indexOf(obj); if (i !== -1) this.objects.splice(i, 1);
    this.selection.delete(obj);
  }

  /* --- edit: select & move ----------------------------------------------- */
  _beginEdit(p) {
    const hits = this._objectsAtPointer(p);
    if (hits.length) {
      const obj = hits[hits.length - 1];
      if (!(p.event && p.event.shiftKey)) { if (!this.selection.has(obj)) this._clearSelection(); }
      this.selection.add(obj);
      this._refreshCounter();
      const { ux, uy } = this._pointerUnits(p);
      this._dragMove = { startUx: ux, startUy: uy, moved: false, before: [...this.selection].map((o) => ({ o, x: o.x, y: o.y })) };
    } else {
      this._clearSelection();
      // drag empty space = pan
      this._panning = true; this._panStart = { x: p.x, y: p.y, sx: this.cameras.main.scrollX, sy: this.cameras.main.scrollY };
    }
  }
  _updateDragMove(p) {
    const { ux, uy } = this._pointerUnits(p);
    const ddx = ux - this._dragMove.startUx, ddy = uy - this._dragMove.startUy;
    if (ddx === 0 && ddy === 0) return;
    this._dragMove.moved = true;
    for (const rec of this._dragMove.before) {
      rec.o.x = rec.x + ddx; rec.o.y = rec.y + ddy;
      const s = (rec.o._sprites || [])[0];
      if (s) { s.x = this.unitsToWorldX(rec.o.x); s.y = this.unitsToWorldY(rec.o.y); this._reapplyOffset(rec.o); }
    }
  }
  _reapplyOffset(obj) { this._renderObject(obj); } // simplest: re-render to reposition with offsets
  _endDragMove() {
    const dm = this._dragMove; this._dragMove = null;
    if (dm && dm.moved) {
      const ddx = dm.before.length ? dm.before[0].o.x - dm.before[0].x : 0;
      const ddy = dm.before.length ? dm.before[0].o.y - dm.before[0].y : 0;
      this._commit({ type: "move", objs: dm.before.map((r) => r.o), dx: ddx, dy: ddy }, true);
    }
  }
  _clearSelection() { this.selection.clear(); this._refreshCounter(); }
  _deleteSelection() {
    if (!this.selection.size) return;
    const objs = [...this.selection];
    objs.forEach((o) => this._removeObject(o));
    this._clearSelection();
    this._commit({ type: "remove", objs }, true);
    this._refreshCounter();
  }
  _rotateSelection(deg) { if (!this.selection.size) return; for (const o of this.selection) { o.rot = ((o.rot || 0) + deg) % 360; this._renderObject(o); } this._commit({ type: "transform" }, true); }
  _setGroupOnSelection() {
    if (!this.selection.size) { this._toast("Edit mode: select objects, then Group"); return; }
    const v = window.prompt("Group ID for " + this.selection.size + " selected object(s)  (blank = clear):", "1");
    if (v === null) return;
    const gid = parseInt(v, 10);
    for (const o of this.selection) {
      if (!isNaN(gid) && gid > 0) { o.groups = String(gid); o._raw[57] = String(gid); }
      else { o.groups = ""; delete o._raw[57]; }
    }
    this._toast((isNaN(gid) || gid <= 0) ? "Cleared groups" : "Group " + gid + " set on " + this.selection.size);
  }
  _configSelectedTrigger() {
    const trigs = [...this.selection].filter((o) => ED_TRIGGERS[o.id]);
    if (trigs.length !== 1) { this._toast("Edit mode: select one trigger to configure"); return; }
    const o = trigs[0], t = ED_TRIGGERS[o.id], r = o._raw;
    let s, p;
    if (o.id === 901) { s = window.prompt("Move - group, X (30=1 block), Y, seconds, loop 0/1:", [r[51] || 1, r[28] || 90, r[29] || 0, r[10] || 0.5, r[97] === "1" ? 1 : 0].join(",")); if (s === null) return; p = s.split(",").map((x) => x.trim()); r[51] = parseInt(p[0]) || 1; r[28] = parseFloat(p[1]) || 0; r[29] = parseFloat(p[2]) || 0; r[10] = parseFloat(p[3]) || 0.5; if (parseInt(p[4])) r[97] = "1"; else delete r[97]; }
    else if (o.id === 1346) { s = window.prompt("Rotate - group, degrees, seconds, loop 0/1:", [r[51] || 1, r[68] || 180, r[10] || 0.6, r[97] === "1" ? 1 : 0].join(",")); if (s === null) return; p = s.split(",").map((x) => x.trim()); r[51] = parseInt(p[0]) || 1; r[68] = parseFloat(p[1]) || 0; r[10] = parseFloat(p[2]) || 0.6; if (parseInt(p[3])) r[97] = "1"; else delete r[97]; }
    else if (o.id === 1007) { s = window.prompt("Alpha - group, opacity 0-1, seconds:", [r[51] || 1, r[35] != null ? r[35] : 0, r[10] || 0.5].join(",")); if (s === null) return; p = s.split(",").map((x) => x.trim()); r[51] = parseInt(p[0]) || 1; r[35] = parseFloat(p[1]) || 0; r[10] = parseFloat(p[2]) || 0.5; }
    else if (o.id === 1006) { s = window.prompt("Pulse - group, R, G, B:", [r[51] || 1, r[7] || 120, r[8] || 255, r[9] || 255].join(",")); if (s === null) return; p = s.split(",").map((x) => x.trim()); r[51] = parseInt(p[0]) || 1; r[7] = parseInt(p[1]) || 0; r[8] = parseInt(p[2]) || 0; r[9] = parseInt(p[3]) || 0; }
    else if (o.id === 899) { s = window.prompt("Color - channel, R, G, B:", [r[23] || 1, r[7] || 255, r[8] || 90, r[9] || 60].join(",")); if (s === null) return; p = s.split(",").map((x) => x.trim()); r[23] = parseInt(p[0]) || 1; r[7] = parseInt(p[1]) || 0; r[8] = parseInt(p[2]) || 0; r[9] = parseInt(p[3]) || 0; }
    else if (o.id === 1049) { s = window.prompt("Toggle - group, show 1 / hide 0:", [r[51] || 1, (r[56] === "1" || r[56] === 1) ? 1 : 0].join(",")); if (s === null) return; p = s.split(",").map((x) => x.trim()); r[51] = parseInt(p[0]) || 1; r[56] = parseInt(p[1]) ? "1" : "0"; }
    else if (o.id === 1520) { s = window.prompt("Shake - strength, seconds:", [r[75] || 15, r[10] || 0.5].join(",")); if (s === null) return; p = s.split(",").map((x) => x.trim()); r[75] = parseFloat(p[0]) || 10; r[10] = parseFloat(p[1]) || 0.5; }
    else if (o.id === 1268) { s = window.prompt("Spawn - target group, delay seconds:", [r[51] || 1, r[63] || 0.5].join(",")); if (s === null) return; p = s.split(",").map((x) => x.trim()); r[51] = parseInt(p[0]) || 1; r[63] = parseFloat(p[1]) || 0; }
    else if (o.id === 2067) { s = window.prompt("Scale - group, scale (1 = normal), seconds:", [r[51] || 1, r[150] || 1.5, r[10] || 0.5].join(",")); if (s === null) return; p = s.split(",").map((x) => x.trim()); r[51] = parseInt(p[0]) || 1; r[150] = parseFloat(p[1]) || 1; r[10] = parseFloat(p[2]) || 0.5; }
    else if (o.id === 1913) { s = window.prompt("Zoom - factor (1 = normal), seconds:", [r[150] || 1.4, r[10] || 0.6].join(",")); if (s === null) return; p = s.split(",").map((x) => x.trim()); r[150] = parseFloat(p[0]) || 1; r[10] = parseFloat(p[1]) || 0.6; }
    this._renderObject(o);
    this._toast(t.name + " trigger updated");
  }
  // Lowest unused group id (>=2) so each preset animates its own objects.
  _nextAnimGroup() {
    let max = 0;
    for (const o of this.objects) {
      const gs = String((o._raw && o._raw[57]) || o.groups || "").split(".").map(Number);
      for (const gg of gs) if (gg > max) max = gg;
    }
    return Math.max(2, max + 1);
  }
  // Drop a ready-made animated gadget at the view centre: a grouped object (or
  // row) plus a trigger already wired to it. Playtest and it animates.
  _addPreset(kind) {
    const cam = this.cameras.main;
    const bx = this.snapUnits(this.worldToUnitsX(cam.scrollX + screenWidth / (2 * cam.zoom)));
    const by = this.snapUnits(this.worldToUnitsY(cam.scrollY + screenHeight / (2 * cam.zoom)));
    const G = this._nextAnimGroup();
    const made = [];
    const add = (id, dx, dy, raw) => {
      const o = { id, x: bx + dx, y: by + dy, flipX: false, flipY: false, rot: 0, scale: 1, zLayer: 0, zOrder: 0, color1: 0, color2: 0, groups: raw && raw[57] != null ? String(raw[57]) : "", _raw: Object.assign({ 1: id, 2: bx + dx, 3: by + dy }, raw || {}) };
      this.objects.push(o); this._renderObject(o); made.push(o); return o;
    };
    if (kind === "slider") { for (let i = 0; i < 3; i++) add(1, i * 30, 0, { 57: G }); add(901, -90, 0, { 51: G, 28: 180, 29: 0, 10: 1, 30: 0, 85: 2 }); }
    else if (kind === "riser") { for (let i = 0; i < 3; i++) add(1, i * 30, 0, { 57: G }); add(901, -90, 0, { 51: G, 28: 0, 29: 150, 10: 1, 30: 0, 85: 2 }); }
    else if (kind === "spinner") { add(1, 0, 0, { 57: G }); add(1346, -90, 0, { 51: G, 68: 360, 69: 0, 10: 2, 30: 0, 85: 2, 71: G, 97: 1 }); }
    else if (kind === "pulser") { add(1, 0, 0, { 57: G }); add(1006, -90, 0, { 51: G, 52: 1, 7: 255, 8: 90, 9: 220, 45: 0.3, 46: 0.5, 47: 0.5 }); }
    else if (kind === "fader") { add(1, 0, 0, { 57: G }); add(1007, -90, 0, { 51: G, 10: 1, 35: 0.15 }); }
    else if (kind === "oscillator") { for (let i = 0; i < 3; i++) add(1, i * 30, 0, { 57: G }); add(901, -90, 0, { 51: G, 28: 120, 29: 0, 10: 1.2, 30: 0, 85: 2, 97: 1 }); }
    else if (kind === "vanisher") { for (let i = 0; i < 3; i++) add(1, i * 30, 0, { 57: G }); add(1049, -90, 0, { 51: G, 56: 0 }); }
    else if (kind === "burst") { const S = G + 4; const dirs = [[120, 0], [-120, 0], [0, 120], [0, -120]]; for (let i = 0; i < 4; i++) { const gg = G + i; add(1, 0, 0, { 57: gg }); add(901, -90, 0, { 51: gg, 28: dirs[i][0], 29: dirs[i][1], 10: 0.6, 30: 0, 85: 2, 57: S, 62: 1 }); } add(1268, -120, 0, { 51: S, 63: 0.3 }); }
    else if (kind === "pump") { add(1, 0, 0, { 57: G }); add(2067, -90, 0, { 51: G, 150: 1.8, 10: 0.5 }); }
    if (!made.length) return;
    this._commit({ type: "add", objs: made });
    this._refreshCounter();
    this._toast(kind + " added (group " + G + ") - Playtest to see it animate");
  }
  _flipSelection(axis) { if (!this.selection.size) return; for (const o of this.selection) { if (axis === "x") o.flipX = !o.flipX; else o.flipY = !o.flipY; this._renderObject(o); } this._commit({ type: "transform" }, true); }
  _copySelection() {
    if (!this.selection.size) return;
    this._clipboard = [...this.selection].map((o) => ({ id: o.id, x: o.x, y: o.y, flipX: o.flipX, flipY: o.flipY, rot: o.rot, scale: o.scale, zLayer: o.zLayer, zOrder: o.zOrder, color1: o.color1, color2: o.color2, groups: o.groups, _raw: Object.assign({}, o._raw) }));
    this._toast(this._clipboard.length + " copied");
  }
  _paste() {
    if (!this._clipboard || !this._clipboard.length) return;
    const made = [];
    this._clearSelection();
    for (const c of this._clipboard) {
      const o = Object.assign({}, c, { x: c.x + ED_CELL_UNITS, y: c.y, _raw: Object.assign({}, c._raw), _sprites: [] });
      this.objects.push(o); this._renderObject(o); made.push(o); this.selection.add(o);
    }
    this._setMode("edit");
    this._commit({ type: "add", objs: made });
    this._refreshCounter();
    this._toast(made.length + " pasted");
  }
  _duplicate() { this._copySelection(); this._paste(); }

  /* --- command history --------------------------------------------------- */
  _commit(cmd, alreadyApplied) { this.undoStack.push(cmd); if (this.undoStack.length > 200) this.undoStack.shift(); this.redoStack.length = 0; }
  _undo() {
    const cmd = this.undoStack.pop(); if (!cmd) return;
    if (cmd.type === "add") cmd.objs.forEach((o) => this._removeObject(o));
    else if (cmd.type === "remove") cmd.objs.forEach((o) => { this.objects.push(o); this._renderObject(o); });
    else if (cmd.type === "move") cmd.objs.forEach((o) => { o.x -= cmd.dx; o.y -= cmd.dy; this._renderObject(o); });
    else if (cmd.type === "transform") { /* coarse: transforms aren't finely reversible yet */ }
    this.redoStack.push(cmd); this._refreshCounter();
  }
  _redo() {
    const cmd = this.redoStack.pop(); if (!cmd) return;
    if (cmd.type === "add") cmd.objs.forEach((o) => { this.objects.push(o); this._renderObject(o); });
    else if (cmd.type === "remove") cmd.objs.forEach((o) => this._removeObject(o));
    else if (cmd.type === "move") cmd.objs.forEach((o) => { o.x += cmd.dx; o.y += cmd.dy; this._renderObject(o); });
    this.undoStack.push(cmd); this._refreshCounter();
  }

  /* --- serialize / save / playtest / exit -------------------------------- */
  _serialize() {
    const objStrings = this.objects.map((o) => this._serializeObject(o));
    return EditorScene.encodeLevelString([this.settingsStr, ...objStrings].join(";"));
  }
  _serializeObject(o) {
    const raw = Object.assign({}, o._raw || {});
    raw[1] = o.id; raw[2] = o.x; raw[3] = o.y;
    if (o.rot) raw[6] = o.rot; else delete raw[6];
    if (o.flipX) raw[4] = 1; else delete raw[4];
    if (o.flipY) raw[5] = 1; else delete raw[5];
    if (o.scale && o.scale !== 1) raw[32] = o.scale; else delete raw[32];
    const parts = []; for (const k of Object.keys(raw)) parts.push(k, raw[k]);
    return parts.join(",");
  }
  static encodeLevelString(plain) {
    const bytes = pako.deflate(plain);
    let bin = ""; const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  _save(showToast) {
    const levelString = this._serialize();
    this.level.levelString = levelString;
    try {
      const raw = localStorage.getItem("created_levels");
      const levels = raw ? JSON.parse(raw) : [];
      const idx = levels.findIndex((l) => l.createdId === this.level.createdId);
      if (idx !== -1) { levels[idx].levelString = levelString; localStorage.setItem("created_levels", JSON.stringify(levels)); }
    } catch (e) { console.warn("[editor] save failed", e); }
    if (showToast) this._toast("Saved ✓");
    return levelString;
  }
  _playtest() {
    const levelString = this._save(false);
    this.registry.set("editorReturnId", this.level.createdId);
    window.isEditor = false;
    window._onlineLevelString = levelString;
    window._onlineLevelName = this.level.levelName;
    window._onlineLevelId = this.level.createdId;
    window.currentlevel = ["editor", this.level.levelName, this.level.createdId, ["You", this.level.song || "Stereo Madness"]];
    window.settingsMap = null;
    this.registry.set("autoStartGame", true);
    this.scene.start("GameScene");
  }
  _exitToMenu() { this._save(false); window.isEditor = false; this.scene.start("GameScene"); }
}

// Default level header so new/empty levels have valid settings (colours, bg,
// ground, gamemode, speed). Without this the play engine never sets
// window.settingsMap and refuses to start.
EditorScene.DEFAULT_SETTINGS =
  "kS38,1_255_2_255_3_255_6_1|1_0_2_102_3_255_6_1000|1_0_2_68_3_170_6_1001|1_255_2_255_3_255_6_1004|," +
  "kA6,1,kA7,1,kA17,0,kA18,0,kS39,0,kA2,0,kA3,0,kA8,0,kA4,0,kA9,0,kA10,0,kA11,0,kA13,0,kA15,0,kA16,0";

window.EditorScene = EditorScene;
