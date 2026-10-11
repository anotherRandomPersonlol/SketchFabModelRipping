// Read-only console probe: dumps the numeric/colour parts of each material model
// (channel factors such as AlbedoPBR.color, RoughnessPBR.factor, MetalnessPBR.factor).
// Paste into the viewer iframe console. Output also in window.__facProbe.
(function () {
    var out = [], seen = [];
    function P(s) { out.push(s); console.log(s); }
    function dump(o, depth, path) {
        if (o === null || o === undefined) return;
        if (depth > 4) return;
        var t = typeof o;
        if (t === 'number' || t === 'boolean') { P('    ' + path + ' = ' + o); return; }
        if (t === 'string') { if (o.length < 80) P('    ' + path + ' = "' + o + '"'); return; }
        if (t !== 'object') return;
        if (o instanceof Float32Array || o instanceof Float64Array || Array.isArray(o)) {
            if (o.length <= 8) P('    ' + path + ' = [' + Array.prototype.join.call(o, ',') + ']');
            return;
        }
        if (seen.indexOf(o) >= 0) return;
        seen.push(o);
        for (var k in o) {
            if (!o.hasOwnProperty(k)) continue;
            if (k.charAt(0) === '_' && k !== '_materialModel') continue;
            if (/texture|image|blob|gl|context|events|listener/i.test(k)) continue;
            try { dump(o[k], depth + 1, path + '.' + k); } catch (e) {}
        }
    }
    P('allmodel length = ' + (window.allmodel ? window.allmodel.length : 'undefined (run this in the viewer iframe console)'));
    (window.allmodel || []).forEach(function (mesh, mi) {
        var cur = mesh, d = 0, found = false;
        while (cur && d < 8 && !found) {
            var ss = cur.stateset || cur._stateSet || null;
            if (!ss && typeof cur.getStateSet === 'function') { try { ss = cur.getStateSet(); } catch (e) {} }
            var arr = ss && ss._attributeArray;
            var a0 = arr && arr[0];
            if (a0 && a0._materialModel) {
                found = true;
                P('mesh[' + mi + '] ' + (mesh._name || '') + ' material "' + (a0._name || '') + '" (depth ' + d + ')');
                seen = [];
                dump(a0._materialModel.attributes, 0, 'attributes');
                var m17 = arr[17];
                if (m17 && m17._diffuse) P('    osg diffuse = [' + Array.prototype.join.call(m17._diffuse, ',') + ']');
            }
            cur = cur._parents && cur._parents[0];
            d++;
        }
        if (!found) P('mesh[' + mi + '] ' + (mesh._name || '') + ': no material model found in ' + d + ' levels');
    });
    window.__facProbe = out;
    P('read all: window.__facProbe.join("\\n")');
})();
