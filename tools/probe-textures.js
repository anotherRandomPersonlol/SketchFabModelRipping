// Read-only console probe: dumps how a mesh's texture attributes are structured.
// Paste into the viewer iframe console on a model whose textures are missing from the export
// (e.g. "Small neon sign"). Then run: window.__texProbe.join("\n")
(function () {
    var out = [];
    function P(s) { out.push(s); console.log(s); }
    function keys(o, max) {
        var k = [], n = 0, x;
        for (x in o) { if (!o.hasOwnProperty(x)) continue; if (n++ < (max || 25)) k.push(x); }
        return k.join(',') + (n > (max || 25) ? ',...(' + n + ')' : '');
    }
    function ctor(o) { return o && o.constructor && o.constructor.name; }
    function dumpTex(tex, pad) {
        if (!tex) { P(pad + '(no texture)'); return; }
        P(pad + 'texture ctor=' + ctor(tex) + ' keys=' + keys(tex));
        P(pad + '  _channels=' + JSON.stringify(tex._channels));
        var pk = tex._packedTextures;
        if (pk) {
            for (var c in pk) {
                if (!pk.hasOwnProperty(c)) continue;
                var pt = pk[c] && pk[c].texture;
                var img = pt && pt._image, im = pt && pt._imageModel;
                P(pad + '  packed[' + c + '] tex=' + !!pt + ' image=' + (img ? (img._url || img.url || ctor(img)) : 'none') +
                  ' size=' + (img ? (img.width + 'x' + img.height) : '?') +
                  ' model=' + (im && im.attributes ? im.attributes.name : 'none'));
                if (im && im.attributes && im.attributes.images) {
                    im.attributes.images.forEach(function (i2) {
                        P(pad + '    variant ' + i2.width + 'x' + i2.height + ' size=' + i2.size + ' ' + String(i2.url).slice(-40));
                    });
                }
            }
        } else {
            var img2 = tex._image, im2 = tex._imageModel;
            P(pad + '  (no _packedTextures) _image=' + (img2 ? (img2._url || img2.url || ctor(img2)) : 'none') +
              ' size=' + (img2 ? (img2.width + 'x' + img2.height) : '?') + ' model=' + (im2 && im2.attributes ? im2.attributes.name : 'none'));
        }
    }
    (window.allmodel || []).slice(0, 3).forEach(function (mesh, mi) {
        var cur = mesh, d = 0;
        while (cur && d < 8) {
            var ss = cur.stateset || cur._stateSet;
            var ta = ss && ss._textureAttributeArrayList;
            if (ta && ta.length) {
                P('mesh[' + mi + '] depth' + d + ' "' + (cur._name || '') + '" texture slots=' + ta.length);
                for (var s = 0; s < ta.length; s++) {
                    if (!ta[s]) continue;
                    for (var a = 0; a < ta[s].length; a++) {
                        var w = ta[s][a];
                        if (!w) continue;
                        P('  slot ' + s + '[' + a + '] wrapper ctor=' + ctor(w) + ' keys=' + keys(w, 12));
                        dumpTex(w._object || w.attribute || w._attribute, '    ');
                    }
                }
            }
            cur = cur._parents && cur._parents[0];
            d++;
        }
    });
    window.__texProbe = out;
    P('read all: window.__texProbe.join("\\n")');
})();
