// PhET coverage auditor — runs each local sim build headlessly (system Edge via
// puppeteer-core) and diffs what the sim actually contains against the qizhi
// curated lists:
//   - interactive scene-graph nodes  vs  element cards (qizhi-phet-elements.js)
//   - model Properties               vs  watchlists (qizhi-phet-watchlists.js)
//   - click operations               vs  live nodes (stale-entry check)
// Matching mirrors qizhi-phet-inspect.js matchElement() exactly (type-chain /
// accessibleName substring / tandem substring; screen → sim "*" → global "*").
//
// All sims are now standalone HTML files in phet-sims/ named with the
// Chinese-grade convention: {grade}{semester}-{n}{ChineseName}{slug}.html
// Usage:  node audit.js [sim-slug ...]     (default: all sims)
// Output: out/<slug>.json + a console summary. Lives OUTSIDE the qizhi repo on
// purpose — audit output is never committed.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

// phet-audit/ now lives inside the qizhi working dir (gitignored, output
// never committed), so resolve the repo relative to this script.
const QIZHI = path.resolve(__dirname, '..').replace(/\\/g, '/');
const SIMS_DIR = QIZHI + '/django_site/static/phet-sims';
const JS_DIR = QIZHI + '/django_site/static/js';
const OUT_DIR = path.join(__dirname, 'out');

global.window = {};
require(JS_DIR + '/qizhi-phet-elements.js');
require(JS_DIR + '/qizhi-phet-watchlists.js');
const ELEMENTS = global.window.QIZHI_PHET_ELEMENTS;
const WATCHLISTS = global.window.QIZHI_PHET_WATCHLISTS;

// All .html files in phet-sims/ that contain an ASCII slug are sims.
// The English slug (ELEMENTS/WATCHLISTS key) starts at the first lowercase letter.
function fileToSlug(filename) {
  // Strip .html suffix, then take everything from the first lowercase letter.
  const base = filename.replace(/\.html$/i, '');
  const i = base.search(/[a-z]/);
  return i >= 0 ? base.slice(i) : base;
}

// Skip the *_zh_CN / *_zh_HK standalone downloads — those carry a language
// suffix that breaks fileToSlug (concentration_zh_CN ≠ ELEMENTS key
// "concentration") and are covered by audit-flat.js's explicit table, which
// also disambiguates color-vision-5 vs color-vision-6.
const allSims = fs.readdirSync(SIMS_DIR)
  .filter(f => f.endsWith('.html') && /[a-z]/.test(f) && !/_zh_[A-Z]{2}\.html$/.test(f));

// Hand-written qizhi sims (not PhET builds): no phet.joist, no scene graph or
// model Properties to diff, so the PhET audit does not apply. Instead verify
// the platform contract: the window.qizhiCustomSim marker appears (page JS ran
// without errors) and its snapshot() returns non-empty "label=value" lines.
// Keep custom-sim coverage from both branches when merging experiment batches.
const CUSTOM_SIMS = new Set(['handheld-microscope', 'food-preservation', 'milky-way-model', 'sun-shadow-direction',
                             'eight-planets', 'rust-phenomena',
                             'worm-selection', 'seed-germination', 'volcanic-eruption', 'crater-maker', 'respiratory-organs',
                             'ecosystem-bottle', 'earthquake-surface', 'wind-surface-erosion',
                             'water-surface-erosion',
                             'food-chain-and-food-web', 'light-transmission', 'thermal-insulation', 'thermal-contact',
                             'car-model', 'microscopic-organisms', 'food-microbes',
                             'heat-transfer-metal', 'heat-transfer-water','waste-solutions', 'magnifying-lenses']);

// CLI args may be the full filename (with or without .html) or just the English
// slug — both resolve to the matching entry in allSims.
const sims = process.argv.length > 2
  ? process.argv.slice(2).map(a => {
      const withExt = a.endsWith('.html') ? a : a + '.html';
      return allSims.find(f => f === withExt || fileToSlug(f) === a) || withExt;
    })
  : allSims;

// Runs inside the sim page after full construction.
function auditPage(cfg) {
  const sim = phet.joist.sim;
  const simElements = cfg.elements[cfg.slug] || {};
  const globalStar = ((cfg.elements['*'] || {})['*'] || {}).elements || [];
  const watchlist = cfg.watchlist || [];

  const ctorMap = new Map();
  Object.keys(phet).forEach(nsKey => {
    const ns = phet[nsKey];
    if (!ns || typeof ns !== 'object') return;
    Object.keys(ns).forEach(k => {
      try { if (typeof ns[k] === 'function' && !ctorMap.has(ns[k])) ctorMap.set(ns[k], k); } catch (e) {}
    });
  });

  const typeNamesOf = node => {
    const out = [];
    let c = node && node.constructor;
    while (typeof c === 'function' && out.length < 4) {
      const name = ctorMap.get(c);
      if (name && out.indexOf(name) < 0) out.push(name);
      c = Object.getPrototypeOf(c);
    }
    return out;
  };
  const accOf = node => {
    try { return String(node.accessibleName || node.innerContent || node.labelContent || '').trim(); } catch (e) { return ''; }
  };
  const tidOf = node => {
    // Sim+screen prefix stripped, mirroring the 20260807b matchers: on the ESP
    // 摩擦力 screen every full ID contains "frictionScreen", which used to
    // substring-match the friction card's tandem "friction".
    try {
      let tid = (node.tandem && node.tandem.phetioID) ? String(node.tandem.phetioID) : '';
      const i = tid.indexOf('.view.');
      return i >= 0 ? tid.slice(i + 6) : tid;
    } catch (e) { return ''; }
  };

  // A single node satisfies an entry's matcher? (same shapes as inspect.js)
  const nodeMatches = (m, types, acc, tid) =>
    (m.types && m.types.some(t => types.indexOf(t) >= 0)) ||
    (acc && m.names && m.names.some(s => acc.indexOf(s) >= 0)) ||
    (tid && m.tandems && m.tandems.some(s => tid.indexOf(s) >= 0));

  // Trail (leaf→root) against the dictionary, inspect.js lookup order:
  // TIER 1 sim entries (screen-specific + sim "*"), TIER 2 global "*" —
  // a sim card matching an ancestor beats a global card matching the leaf.
  const matchElement = (trailNodes, screenIdx) => {
    let simTier = [];
    const specific = simElements[String(screenIdx)];
    if (specific && specific.elements) simTier = simTier.concat(specific.elements);
    if (simElements['*'] && simElements['*'].elements) simTier = simTier.concat(simElements['*'].elements);
    for (const entries of [simTier, globalStar]) {
      for (const node of trailNodes) {
        const types = typeNamesOf(node), acc = accOf(node), tid = tidOf(node);
        for (const e of entries) {
          if (nodeMatches(e.match || {}, types, acc, tid)) return e.key || e.label || '?';
        }
      }
    }
    return null;
  };

  const screens = sim.homeScreen ? sim.screens.filter(s => s !== sim.homeScreen) : sim.screens.slice();
  const result = { slug: cfg.slug, screens: [], watchlist: [], staleElements: [], staleOps: [] };
  const matchedEntryKeys = new Set();
  const opLiveMatch = {}; // "screenKey|label" -> true

  const auditTree = (root, screenIdx, screenLabel) => {
    const groups = new Map();
    const seen = new Set();
    const visit = (node, ancestors, depth) => {
      if (!node || depth > 60 || seen.has(node)) return;
      seen.add(node);
      let interactive = false;
      try { interactive = (node.inputListeners && node.inputListeners.length > 0) || node.cursor === 'pointer'; } catch (e) {}
      if (interactive) {
        const types = typeNamesOf(node);
        const tid = tidOf(node), acc = accOf(node);
        const key = types[0] || (tid ? tid.split('.').pop() : 'unnamed');
        const trail = [node].concat(ancestors); // leaf→root
        const matched = matchElement(trail, screenIdx);
        if (matched) matchedEntryKeys.add(matched);
        let g = groups.get(key);
        if (!g) groups.set(key, g = { type: key, chain: types.slice(1, 3), count: 0, tandems: [], names: [], matched: matched, visible: 0 });
        g.count++;
        try { if (node.visible) g.visible++; } catch (e) {}
        if (matched && !g.matched) g.matched = matched;
        if (tid && g.tandems.length < 6) { const t = tid.split('.').slice(-2).join('.'); if (g.tandems.indexOf(t) < 0) g.tandems.push(t); }
        if (acc && g.names.length < 3 && g.names.indexOf(acc) < 0) g.names.push(acc);
        // stale-op check: the bridge matches ops leaf→root against the hit
        // TRAIL, so test the whole ancestor chain, not just the leaf
        [String(screenIdx), '*'].forEach(sk => {
          const ops = ((simElements[sk] || {}).operations) || [];
          ops.forEach(op => {
            if (opLiveMatch[sk + '|' + op.label]) return;
            const hit = trail.some(tn => nodeMatches(op.match || {}, typeNamesOf(tn), accOf(tn), tidOf(tn)));
            if (hit) opLiveMatch[sk + '|' + op.label] = true;
          });
        });
      }
      let kids = [];
      try { kids = node.children || []; } catch (e) {}
      const nextAnc = [node].concat(ancestors);
      kids.forEach(c => visit(c, nextAnc, depth + 1));
    };
    visit(root, [], 0);
    return Array.from(groups.values()).sort((a, b) => (a.matched ? 1 : 0) - (b.matched ? 1 : 0) || b.count - a.count);
  };

  // model Property walk, depth-limited, leaves framework junk for the reader
  const auditModel = model => {
    const props = [];
    const seen = new Set();
    const fmt = v => {
      try {
        if (v == null) return String(v);
        if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
        if (typeof v === 'boolean' || typeof v === 'string') return String(v).slice(0, 30);
        if (v.nameProperty && v.nameProperty.value != null) return String(v.nameProperty.value).slice(0, 30);
        if (v.name) return String(v.name).slice(0, 30);
        return (ctorMap.get(v.constructor) || 'obj');
      } catch (e) { return '?'; }
    };
    const walk = (obj, prefix, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 3 || seen.has(obj)) return;
      seen.add(obj);
      for (const k of Object.keys(obj)) {
        if (k.startsWith('_') || k === 'tandem') continue;
        let v; try { v = obj[k]; } catch (e) { continue; }
        if (!v || typeof v !== 'object') continue;
        const p = prefix ? prefix + '.' + k : k;
        if (typeof v.link === 'function' && 'value' in v) {
          const ctor = ctorMap.get(v.constructor) || (v.constructor && v.constructor.name) || '';
          const derived = /Derived|Mapped/.test(ctor) || (typeof v.isSettable === 'function' && !v.isSettable());
          props.push({ path: p, ctor: ctor, derived: derived, value: fmt(v.value) });
          if (props.length > 400) return;
        } else if (!(v instanceof Node) && !v.nodeType) {
          walk(v, p, depth + 1);
        }
      }
    };
    walk(model, '', 0);
    return props;
  };

  screens.forEach((screen, i) => {
    const idx = i + 1;
    let name = '';
    try { name = String(screen.nameProperty.value); } catch (e) {}
    result.screens.push({
      index: idx, name: name,
      interactive: auditTree(screen.view, idx, name),
      modelProps: auditModel(screen.model),
    });
  });

  // chrome pass: everything under the display root that is NOT a screen view
  // (navbar, menus) — matched with screen-1 context (only "*" sections apply
  // in practice)
  const viewSet = new Set(screens.map(s => s.view));
  const chromeGroups = [];
  try {
    const root = sim.display.rootNode;
    const visit = (node, ancestors, depth, out) => {
      if (!node || depth > 60 || viewSet.has(node)) return;
      let interactive = false;
      try { interactive = (node.inputListeners && node.inputListeners.length > 0) || node.cursor === 'pointer'; } catch (e) {}
      if (interactive) {
        const types = typeNamesOf(node);
        const matched = matchElement([node].concat(ancestors), 1);
        if (matched) matchedEntryKeys.add(matched);
        const key = types[0] || 'unnamed';
        const g = out.find(x => x.type === key);
        if (g) g.count++; else out.push({ type: key, count: 1, matched: matched, tandems: [tidOf(node).split('.').slice(-2).join('.')] });
      }
      let kids = []; try { kids = node.children || []; } catch (e) {}
      kids.forEach(c => visit(c, [node].concat(ancestors), depth + 1, out));
    };
    visit(root, [], 0, chromeGroups);
  } catch (e) {}
  result.chrome = chromeGroups.sort((a, b) => (a.matched ? 1 : 0) - (b.matched ? 1 : 0));

  // watchlist resolution per screen (same reduce the bridge does, honouring
  // the 20260807b `screens` scoping field; 20260807c `collection` entries
  // resolve when the ObservableArray itself does — members are student-created)
  watchlist.forEach(entry => {
    const paths = Array.isArray(entry.paths) ? entry.paths : [entry.paths];
    const resolvedOn = [];
    screens.forEach((screen, i) => {
      if (entry.screens && entry.screens.map(String).indexOf(String(i + 1)) < 0) return;
      let hit;
      if (entry.collection) {
        try {
          const arr = entry.collection.split('.').reduce((o, k) => (o == null ? o : o[k]), screen.model);
          hit = !!(arr && typeof arr.addItemAddedListener === 'function' && typeof arr.forEach === 'function');
        } catch (e) { hit = false; }
      } else {
        hit = paths.some(pth => {
          try {
            const root = pth.indexOf('view.') === 0 ? screen.view : screen.model;
            const rel = pth.indexOf('view.') === 0 ? pth.slice(5) : pth;
            const v = rel.split('.').reduce((o, k) => (o == null ? o : o[k]), root);
            return v && typeof v.link === 'function';
          } catch (e) { return false; }
        });
      }
      if (hit) resolvedOn.push(i + 1);
    });
    result.watchlist.push({ label: entry.label, paths: entry.collection ? [entry.collection + ' (collection)'] : paths, resolvedOn: resolvedOn });
  });

  // stale element entries: never matched by any interactive node anywhere
  Object.keys(simElements).forEach(sk => {
    ((simElements[sk] || {}).elements || []).forEach(e => {
      const key = e.key || e.label || '?';
      if (!matchedEntryKeys.has(key)) result.staleElements.push({ screenKey: sk, key: key });
    });
    ((simElements[sk] || {}).operations || []).forEach(op => {
      if (!opLiveMatch[sk + '|' + op.label]) result.staleOps.push({ screenKey: sk, label: op.label, event: op.event });
    });
  });

  return result;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let hadContractFailure = false;
  const browser = await puppeteer.launch({
    executablePath: require('./browser').executablePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  for (const file of sims) {
    const slug = fileToSlug(file);
    const page = await browser.newPage();
    try {
      await page.goto('file:///' + SIMS_DIR + '/' + file, { waitUntil: 'load', timeout: 60000 });
      if (CUSTOM_SIMS.has(slug)) {
        const booted = await page.waitForFunction(() => !!window.qizhiCustomSim, { timeout: 30000, polling: 250 })
          .then(() => true).catch(() => false);
        if (!booted) {
          console.log(slug + ' (' + file + '): BOOT FAILED (qizhiCustomSim marker not found)');
          hadContractFailure = true;
        } else {
          const snap = await page.evaluate(() => {
            try { return String(window.qizhiCustomSim.snapshot ? window.qizhiCustomSim.snapshot() : ''); } catch (e) { return ''; }
          });
          console.log(slug + ': custom qizhi sim — boots OK, snapshot ' +
            (snap ? snap.split('\n').length + ' lines' : 'EMPTY (check window.qizhiCustomSim.snapshot)'));
          if (!snap) hadContractFailure = true;
          // Author-editor labels: custom sims declare match-less `operations`
          // in elements.js (screen "1"); each label should appear in the sim
          // source as a quoted string. Labels assembled at runtime (food:
          // btn.dataset.group+'组'+META[key].label → 'A组温度') can't be found
          // literally, so they are only reported as "assembled?" for a manual
          // check — a rule keyed on a label the sim never emits can never fire.
          const src = fs.readFileSync(path.join(SIMS_DIR, file), 'utf8');
          const ops = (((ELEMENTS[slug] || {})['1'] || {}).operations) || [];
          const literal = (label) => src.indexOf("'" + label + "'") >= 0 || src.indexOf('"' + label + '"') >= 0;
          const missing = ops.filter(op => !literal(op.label));
          console.log('  declared operations: ' + ops.length + (missing.length
            ? ', not a literal string in sim source (assembled at runtime? verify by hand): ' + missing.map(op => op.label).join(', ')
            : ', all labels found in sim source'));
          if (!ops.length) console.log('  (no operations declared — author editor will offer no 操作对象 for this sim)');
        }
        await page.close();
        continue;
      }
      const ok = await page.waitForFunction(() => {
        const sim = window.phet && phet.joist && phet.joist.sim;
        if (!sim) return false;
        if (sim.isConstructionCompleteProperty) return sim.isConstructionCompleteProperty.value;
        return sim.screens && sim.screens.every(s => s.model && s.view);
      }, { timeout: 90000, polling: 500 }).then(() => true).catch(() => false);
      if (!ok) {
        console.log(slug + ' (' + file + '): BOOT FAILED');
        hadContractFailure = true;
        await page.close();
        continue;
      }
      const result = await page.evaluate(auditPage, { slug, elements: ELEMENTS, watchlist: WATCHLISTS[slug] || [] });
      fs.writeFileSync(path.join(OUT_DIR, slug + '.json'), JSON.stringify(result, null, 1));
      const nGroups = result.screens.reduce((a, s) => a + s.interactive.length, 0);
      const nUnmatched = result.screens.reduce((a, s) => a + s.interactive.filter(g => !g.matched).length, 0);
      const unresolved = result.watchlist.filter(w => !w.resolvedOn.length).length;
      console.log(slug + ': ' + result.screens.length + ' screens, ' + nGroups + ' interactive groups (' +
        nUnmatched + ' unmatched), watchlist unresolved: ' + unresolved +
        ', stale cards: ' + result.staleElements.length + ', stale ops: ' + result.staleOps.length);
    } catch (e) {
      console.log(slug + ': ERROR ' + String(e).slice(0, 150));
      hadContractFailure = true;
    }
    await page.close();
  }
  await browser.close();
  if (hadContractFailure) process.exitCode = 1;
})();