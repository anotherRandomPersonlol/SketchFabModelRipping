// ====================================================================
// probe: where does a texture-less model keep its colors? READ-ONLY.
// Paste into the viewer iframe console (same context as the userscript)
// after the model has loaded. Output lines are also kept in
// window.__matProbe (join with "\n").
// v2: the Kalibr meshes have no stateset of their own ("no stateset"),
// so this walks UP the parent chain and dumps every stateset it finds
// (uniforms + attributes), shared ones only once.
// ====================================================================
(function () {
    var TAG = '[MatProbe]';
    var lines = window.__matProbe = [];
    function L(s) { lines.push(s); console.log(TAG, s); }

    var am = window.allmodel || [];
    L('allmodel length = ' + am.length);
    if (!am.length) { L('empty: wrong frame or model not loaded'); return; }

    function ctor(o) { try { return (o && o.constructor && o.constructor.name) || typeof o; } catch (e) { return '?'; } }
    function nums(a, n) {
        var out = [];
        for (var i = 0; i < Math.min(n, a.length); i++) out.push(Math.round(a[i] * 1000) / 1000);
        return '[' + out.join(',') + (a.length > n ? ',...' : '') + ']';
    }
    function desc(v, depth) {
        if (v === null || v === undefined) return String(v);
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (typeof v === 'string') return JSON.stringify(v.slice(0, 40));
        if (typeof v === 'function') return 'fn';
        if (ArrayBuffer.isView(v) || (Array.isArray(v) && v.length && typeof v[0] === 'number')) return ctor(v) + nums(v, 6);
        if (Array.isArray(v)) return 'Array(' + v.length + ')';
        if (typeof v === 'object') {
            if (depth <= 0) return ctor(v) + '{...}';
            var parts = [];
            Object.keys(v).slice(0, 16).forEach(function (k) {
                if (/^(_parents|_graphicContext|_stateSet|_userdata)$/.test(k)) return;
                var x;
                try { x = v[k]; } catch (e) { return; }
                if (typeof x === 'function') return;
                parts.push(k + '=' + desc(x, depth - 1));
            });
            return ctor(v) + '{' + parts.join(' ') + '}';
        }
        return typeof v;
    }

    var seenSS = [];
    function dumpStateSet(ss, label) {
        if (!ss || seenSS.indexOf(ss) !== -1) { L('  ' + label + ': (already shown or none)'); return; }
        seenSS.push(ss);
        L('  ' + label + ': stateset name=' + JSON.stringify(ss._name) + ' ctor=' + ctor(ss));
        var un = ss.uniforms || {};
        Object.keys(un).forEach(function (k) {
            var u = un[k], data = null;
            try {
                data = (u && typeof u.getInternalArray === 'function') ? u.getInternalArray()
                     : (u && (u._data || u._value));
            } catch (e) {}
            L('    uniform ' + k + ': ' + (data ? desc(data, 1) : desc(u, 1)));
        });
        var aa = ss._attributeArray || [];
        for (var a = 0; a < aa.length; a++) {
            if (!aa[a]) continue;
            var at = aa[a]._object || aa[a].attribute || aa[a]._attribute || aa[a];
            L('    attribute[' + a + ']: ' + ctor(at) + ' ' + desc(at, 2));
        }
        L('    texture slots: ' + ((ss._textureAttributeArrayList || []).length));
    }

    var seenNames = {}, shown = 0;
    am.forEach(function (o, i) {
        var name = o._name || ('mesh_' + i);
        if (seenNames[name] || shown >= 4) return;   // 4 meshes with different names is enough
        seenNames[name] = true;
        shown++;
        L('--- mesh[' + i + '] ' + name + ' | ctor=' + ctor(o) + ' ---');
        var own = Object.keys(o).filter(function (k) { return !/^(_parents|_attributes|_primitives)$/.test(k); });
        L('  own keys: ' + own.join(','));
        var viaGetter = null;
        try { viaGetter = typeof o.getStateSet === 'function' ? o.getStateSet() : null; } catch (e) {}
        dumpStateSet(o.stateset || o._stateSet || viaGetter, 'mesh stateset');

        var cur = o._parents && o._parents[0], depth = 1;
        while (cur && depth <= 12) {
            var ss2 = cur.stateset || cur._stateSet;
            if (ss2) dumpStateSet(ss2, 'ancestor ' + depth + ' (' + ctor(cur) + ' ' + JSON.stringify(cur._name) + ')');
            cur = cur._parents && cur._parents[0];
            depth++;
        }
    });
    L('read all: window.__matProbe.join("\\n")');
})();
