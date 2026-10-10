// ====================================================================
// probe: how does an UNSKINNED model animate? READ-ONLY (it only watches).
// Paste into the viewer iframe console (same context as the userscript)
// while the animation is playing. Output also in window.__animProbe
// (join with "\n"). Takes about 2.5 s.
// Questions it answers:
//  1. what do the clip channels drive (node matrices, morph weights, ...)?
//  2. which ancestor matrices of each mesh actually change over time?
//  3. do the meshes carry morph-target data (Vertex_0 / Normal_0)?
// ====================================================================
(function () {
    var TAG = '[AnimProbe]';
    var lines = window.__animProbe = [];
    function L(s) { lines.push(s); console.log(TAG, s); }
    function ctor(o) { try { return (o && o.constructor && o.constructor.name) || typeof o; } catch (e) { return '?'; } }

    var am = window.allmodel || [];
    L('allmodel length = ' + am.length);
    if (!am.length) { L('empty: wrong frame or model not loaded'); return; }

    function short(v, d) {
        if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (typeof v === 'string') return JSON.stringify(v.slice(0, 40));
        if (typeof v === 'function') return 'fn';
        if (ArrayBuffer.isView(v)) return ctor(v) + '[' + Array.prototype.slice.call(v, 0, 6).map(function (n) { return Math.round(n * 1000) / 1000; }).join(',') + (v.length > 6 ? ',...' : '') + ']';
        if (Array.isArray(v)) return 'Array(' + v.length + ')';
        if (typeof v === 'object') {
            if (d <= 0) return ctor(v) + '{...}';
            var parts = [];
            Object.keys(v).slice(0, 14).forEach(function (k) {
                if (/^(_parents|_events|_graphicContext|_stateSet|_userdata)$/.test(k)) return;
                var x; try { x = v[k]; } catch (e) { return; }
                if (typeof x !== 'function') parts.push(k + '=' + short(x, d - 1));
            });
            return ctor(v) + '{' + parts.join(' ') + '}';
        }
        return typeof v;
    }

    // ---- 1. manager + clip channels ----
    var mgr = null, cur = am[0], guard = 0;
    while (cur && guard++ < 64 && !mgr) {
        var cbs = cur._updateCallbacks || [];
        for (var i = 0; i < cbs.length; i++) if (cbs[i] && cbs[i]._instanceAnimations) { mgr = cbs[i]; break; }
        cur = cur._parents && cur._parents[0];
    }
    if (!mgr) {
        L('no animation manager found among ancestors');
    } else {
        var ids = Object.keys(mgr._instanceAnimations);
        L('manager: clips=' + ids.length + ' pause=' + mgr._pause + ' active=' + (mgr._activeAnimationList || []).length);
        ids.slice(0, 3).forEach(function (id) {
            var inst = mgr._instanceAnimations[id];
            var ch = (inst && inst.channels) || [];
            L('clip ' + id.slice(0, 8) + ' name=' + JSON.stringify(inst && inst.name) + ' duration=' + (inst && inst.duration) + ' channels=' + ch.length);
            for (var c = 0; c < Math.min(ch.length, 6); c++) {
                var chn = ch[c];
                L('  channel[' + c + '] ' + ctor(chn) + ' ' + short(chn, 2));
                var tgt = chn && (chn.target || chn._target || (chn.channel && (chn.channel._target || chn.channel.target)));
                if (tgt) L('    target ' + ctor(tgt) + ' ' + short(tgt, 2));
            }
        });
    }

    // ---- 3. morph data / callbacks on meshes ----
    am.forEach(function (o, i) {
        var attr = o._attributes || {};
        var morph = Object.keys(attr).filter(function (k) { return /_\d+$/.test(k); });
        var ucb = (o._updateCallbacks || []).map(ctor).join(',');
        L('mesh[' + i + '] ' + (o._name || ('mesh_' + i)) + ' | ctor=' + ctor(o) + ' updateCallbacks=[' + ucb + '] morph-like attrs=[' + morph.join(',') + ']');
        morph.slice(0, 2).forEach(function (k) { L('    ' + k + ': ' + short(attr[k], 2)); });
    });

    // ---- 2. which ancestor matrices change over time? ----
    function localMat(n) {
        var m = null;
        try { if (typeof n.getMatrix === 'function') m = n.getMatrix(); } catch (e) {}
        if (!m) m = n.matrix || n._matrix;
        return m ? Array.prototype.slice.call(m) : null;
    }
    function snap() {
        return am.map(function (o) {
            var chain = [], n = o, g = 0;
            while (n && g++ < 32) {
                chain.push({ name: n._name || ctor(n), m: localMat(n) });
                n = n._parents && n._parents[0];
            }
            return chain;
        });
    }
    var base = snap(), steps = [600, 1300, 2400], k = 0;
    L('sampling matrices at +0.6s, +1.3s, +2.4s ...');
    (function next() {
        if (k >= steps.length) { done(); return; }
        setTimeout(function () {
            var now = snap(), t = steps[k++];
            now.forEach(function (chain, mi) {
                var changed = [];
                chain.forEach(function (node, d) {
                    var b = base[mi][d];
                    if (!node.m || !b || !b.m) return;
                    var mx = 0;
                    for (var x = 0; x < node.m.length; x++) mx = Math.max(mx, Math.abs(node.m[x] - b.m[x]));
                    if (mx > 1e-5) changed.push('depth' + d + ' "' + node.name + '" Δ' + mx.toFixed(4));
                });
                if (changed.length) L('  +' + t + 'ms mesh[' + mi + '] changed ancestors: ' + changed.join(' | '));
            });
            next();
        }, k === 0 ? steps[0] : steps[k] - steps[k - 1]);
    })();
    function done() {
        L('(lines without "changed ancestors" mean that mesh chain did not move in that interval)');
        L('read all: window.__animProbe.join("\\n")');
    }
})();
