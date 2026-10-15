// Read-only console probe: finds the stateset attribute that holds cull-face / double-sided info.
// Paste into the viewer iframe console. Run it on a model whose discs need double sided
// (VertexColor - Light Ball) and on a normal single-sided model (Patriot), then compare.
(function () {
    var out = [];
    function P(s) { out.push(s); console.log(s); }
    function describe(a) {
        var o = [], k, v;
        for (k in a) {
            if (!a.hasOwnProperty(k)) continue;
            v = a[k];
            if (v === null || v === undefined) continue;
            if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') o.push(k + '=' + v);
        }
        return o.join(' ');
    }
    function dumpSS(ss, label) {
        if (!ss) return;
        var arr = ss._attributeArray || [], i;
        P(label + ' stateset: ' + arr.length + ' slots');
        for (i = 0; i < arr.length; i++) {
            var a = arr[i];
            if (!a) continue;
            var ctor = a.constructor && a.constructor.name;
            var tn = (typeof a.getType === 'function') ? a.getType() : '';
            P('  [' + i + '] ctor=' + ctor + ' type=' + tn + ' ' + describe(a));
        }
        // also modes set on the stateset (GL_CULL_FACE etc.)
        var m = ss._modeArray || ss._modes;
        if (m) { try { P('  modes: ' + JSON.stringify(m)); } catch (e) {} }
    }
    (window.allmodel || []).forEach(function (mesh, mi) {
        var cur = mesh, depth = 0;
        while (cur && depth < 8) {
            var ss = (typeof cur.getStateSet === 'function') ? cur.getStateSet() : cur.stateset;
            if (ss) dumpSS(ss, 'mesh[' + mi + '] depth' + depth + ' "' + (cur._name || '') + '"');
            cur = cur._parents && cur._parents[0];
            depth++;
        }
    });
    window.__cullProbe = out;
    P('read all: window.__cullProbe.join("\\n")');
})();
