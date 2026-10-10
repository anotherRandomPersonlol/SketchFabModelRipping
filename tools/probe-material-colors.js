// ====================================================================
// probe: where does a texture-less model keep its colors? READ-ONLY.
// Paste into the viewer iframe console (same context as the userscript)
// after the model has loaded. Output lines are also kept in
// window.__matProbe (join with "\n").
// Vertex-color probe found no color attribute on the Kalibr model, so
// the colors are probably material constants: stateset uniforms or an
// osg.Material in stateset._attributeArray.
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
    // short description of any value; objects get their numeric/array fields listed
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

    var seen = {}, shown = 0;
    am.forEach(function (o, i) {
        var ss = o.stateset;
        var name = (ss && ss._name) || o._name || ('mesh_' + i);
        if (seen[name]) return;       // one dump per material name keeps this short
        seen[name] = true;
        if (++shown > 12) return;     // 12 distinct materials are plenty
        L('--- mesh[' + i + '] ' + name + ' ---');
        if (!ss) { L('  no stateset'); return; }

        var un = ss.uniforms || {};
        Object.keys(un).forEach(function (k) {
            var u = un[k], data = null;
            try {
                data = (u && typeof u.getInternalArray === 'function') ? u.getInternalArray()
                     : (u && (u._data || u._value));
            } catch (e) {}
            L('  uniform ' + k + ': ' + (data ? desc(data, 1) : desc(u, 1)));
        });

        var aa = ss._attributeArray || [];
        for (var a = 0; a < aa.length; a++) {
            if (!aa[a]) continue;
            var at = aa[a]._object || aa[a].attribute || aa[a]._attribute || aa[a];
            L('  attribute[' + a + ']: ' + ctor(at) + ' ' + desc(at, 2));
        }
        L('  active attribute: ' + desc(ss._activeAttribute, 1));
    });
    L('(' + Object.keys(seen).length + ' distinct materials, ' + shown + ' shown)');
    L('read all: window.__matProbe.join("\\n")');
})();
