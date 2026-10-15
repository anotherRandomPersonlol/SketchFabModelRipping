// ====================================================================
// probe 3: the material model behind a texture-less material. READ-ONLY.
// Probe 2 showed the Kalibr colors sit on an ANCESTOR node (named like
// "Material #92") whose stateset holds a Sketchfab material attribute
// (_attributeArray[0], with _materialModel and _channelMapping) plus a
// plain osg.Material at [17]. This prints the channel data itself
// (colors, factors, enable flags). Paste into the viewer iframe console.
// Output also kept in window.__matModelProbe (join with "\n").
// ====================================================================
(function () {
    var TAG = '[MatModelProbe]';
    var lines = window.__matModelProbe = [];
    function L(s) { lines.push(s); console.log(TAG, s); }

    var am = window.allmodel || [];
    L('allmodel length = ' + am.length);
    if (!am.length) { L('empty: wrong frame or model not loaded'); return; }

    // JSON that survives cycles, long strings and typed arrays, depth limited
    function safe(v, depth) {
        if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
        if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '...' : v;
        if (typeof v === 'function') return undefined;
        if (ArrayBuffer.isView(v)) return Array.prototype.slice.call(v, 0, 8).map(function (n) { return Math.round(n * 10000) / 10000; });
        if (depth <= 0) return Array.isArray(v) ? 'Array(' + v.length + ')' : '{...}';
        if (Array.isArray(v)) return v.slice(0, 8).map(function (x) { return safe(x, depth - 1); });
        var out = {};
        Object.keys(v).slice(0, 30).forEach(function (k) {
            if (/^(_parents|_events|_graphicContext)$/.test(k)) return;
            try { var s = safe(v[k], depth - 1); if (s !== undefined) out[k] = s; } catch (e) {}
        });
        return out;
    }
    function J(v, depth, max) {
        var s;
        try { s = JSON.stringify(safe(v, depth)); } catch (e) { s = '(unprintable ' + e.message + ')'; }
        return s && s.length > max ? s.slice(0, max) + '...' : s;
    }

    // first mesh of each of the first 4 distinct material ancestors
    var seen = [], shown = 0;
    am.forEach(function (o, i) {
        if (shown >= 4) return;
        var cur = o._parents && o._parents[0], depth = 1, ss = null, holder = null;
        while (cur && depth <= 12) {
            var s2 = cur.stateset || cur._stateSet;
            var a0 = s2 && s2._attributeArray && s2._attributeArray[0];
            if (a0 && a0._materialModel) { ss = s2; holder = cur; break; }
            cur = cur._parents && cur._parents[0];
            depth++;
        }
        if (!ss || seen.indexOf(ss) !== -1) return;
        seen.push(ss);
        shown++;
        var mat = ss._attributeArray[0], mm = mat._materialModel, at = mm.attributes || {};
        L('--- ' + (holder._name || 'material') + ' (first mesh ' + i + ' ' + (o._name || '') + ') ---');
        L('  channelMapping: ' + J(mat._channelMapping, 1, 500));
        L('  activeChannels: ' + J(mat._activeChannels, 1, 200));
        L('  model attribute keys: ' + Object.keys(at).join(','));
        var ch = at.channels || {};
        Object.keys(ch).forEach(function (k) {
            L('  channel ' + k + ': ' + J(ch[k], 3, 400));
        });
        ['name', 'blendType', 'alphaMode', 'doubleSided', 'cullFace', 'useLight', 'flipTangent'].forEach(function (k) {
            if (at[k] !== undefined) L('  ' + k + ' = ' + J(at[k], 1, 100));
        });
        var osgMat = ss._attributeArray[17];
        if (osgMat) L('  osg.Material diffuse=' + J(osgMat._diffuse, 1, 80) + ' ambient=' + J(osgMat._ambient, 1, 80) +
                      ' specular=' + J(osgMat._specular, 1, 80) + ' shininess=' + osgMat._shininess);
        var atlas = mat._stateSetContext && mat._stateSetContext._colorAtlas;
        if (atlas) L('  colorAtlas keys: ' + Object.keys(atlas).slice(0, 25).join(','));
    });
    L('read all: window.__matModelProbe.join("\\n")');
})();
