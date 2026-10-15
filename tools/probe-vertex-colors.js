// ====================================================================
// probe: vertex colors. READ-ONLY. Paste into the viewer iframe console
// (the same context the userscript runs in) after the model has loaded.
// Result lines are also kept in window.__vcProbe (join with "\n") in case
// the console filters them out.
// ====================================================================
(function () {
    var TAG = '[VCProbe]';
    var lines = window.__vcProbe = [];
    function L(s) { lines.push(s); console.log(TAG, s); }

    var am = window.allmodel || [];
    L('allmodel length = ' + am.length);
    if (!am.length) { L('empty: wrong frame or model not loaded'); return; }

    function stats(el, itemSize) {
        var n = el.length, mn = Infinity, mx = -Infinity, allSame = true, i;
        for (i = 0; i < n; i++) {
            var v = el[i];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        for (i = itemSize; i < n; i++) {
            if (el[i] !== el[i % itemSize]) { allSame = false; break; }
        }
        var first = [];
        for (i = 0; i < Math.min(itemSize, n); i++) first.push(Math.round(el[i] * 1000) / 1000);
        return 'min=' + mn.toFixed(3) + ' max=' + mx.toFixed(3) + ' constant=' + allSame + ' first=[' + first.join(',') + ']';
    }

    var COLOR_RE = /colou?r|^col\d*$|^rgb|vcol/i;
    var withColor = 0;
    am.forEach(function (o, i) {
        var name = (o.stateset && o.stateset._name) || o._name || ('mesh_' + i);
        var attr = o._attributes || {};
        var keys = Object.keys(attr);
        var vcount = attr.Vertex && attr.Vertex._elements ? attr.Vertex._elements.length / 3 : 0;
        L('--- mesh[' + i + '] ' + name + ' | vertices=' + vcount + ' ---');
        keys.forEach(function (k) {
            var a = attr[k], el = a && a._elements, size = a && (a._itemSize || a.itemSize);
            var desc = el ? ('len=' + el.length + ' itemSize=' + size + ' type=' + (el.constructor && el.constructor.name)) : typeof a;
            var flag = COLOR_RE.test(k) ? '  <== color-like name' : '';
            L('  attr ' + k + ': ' + desc + flag);
            if (flag && el && el.length && size) {
                L('    ' + stats(el, size));
                withColor++;
            }
        });

        // texture channels, to tell "vertex colors only" from "colors + textures"
        var chans = [];
        try {
            var ta = o.stateset && o.stateset._textureAttributeArrayList;
            (ta || []).forEach(function (slot) {
                var tex = slot && slot[0] && slot[0]._object;
                if (tex && tex._channels) chans = chans.concat(tex._channels);
            });
        } catch (e) {}
        L('  texture channels: ' + (chans.length ? chans.join(',') : '(none)'));

        // stateset hints that the shader multiplies by vertex color
        var ss = o.stateset || {};
        var hint = Object.keys(ss).filter(function (k) { return /vert|colou?r/i.test(k); });
        L('  stateset color-ish keys: ' + (hint.join(',') || '(none)'));
    });
    L('=== meshes with a color-like attribute: ' + withColor + ' ===');
    L('read all: window.__vcProbe.join("\\n")');
})();
