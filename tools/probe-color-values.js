// Read-only console probe: lists the most common vertex Color values per mesh.
// Use it to decide whether the bytes are sRGB or linear (see docs/NOTES.md).
(function () {
    var out = [];
    function P(s) { out.push(s); console.log(s); }
    (window.allmodel || []).forEach(function (m, mi) {
        var a = m._attributes && m._attributes.Color;
        var arr = a && a._elements;
        if (!arr) return;
        var items = a._itemSize || 4, counts = {}, i, key;
        for (i = 0; i + items <= arr.length; i += items) {
            key = Array.prototype.slice.call(arr, i, i + items).join(',');
            counts[key] = (counts[key] || 0) + 1;
        }
        var keys = Object.keys(counts).sort(function (x, y) { return counts[y] - counts[x]; });
        P('mesh[' + mi + '] ' + (m._name || '') + ' type=' + a._type + ' normalize=' + a._normalize + ' distinct=' + keys.length);
        keys.slice(0, 6).forEach(function (k) { P('   ' + k + '  x' + counts[k]); });
    });
    window.__colProbe = out;
    P('read all: window.__colProbe.join("\\n")');
})();
