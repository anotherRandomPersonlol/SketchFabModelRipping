// Read-only-ish console probe (v2): for the first meshes' texture attributes print the texture size, the
// GPU texture object layout, and try to read the pixels back from the GPU via a temporary framebuffer.
// Paste into the viewer iframe console. Then run: window.__gpuProbe.join("\n")
(function () {
    var out = [];
    function P(s) { out.push(s); console.log(s); }
    function ctor(o) { return o && o.constructor && o.constructor.name; }
    function keys(o, max) { var k = [], n = 0, x; for (x in o) { if (!o.hasOwnProperty(x)) continue; if (n++ < (max || 40)) k.push(x); } return k.join(',') + (n > (max || 40) ? ',...(' + n + ')' : ''); }
    var seenTex = [];
    (window.allmodel || []).slice(0, 3).forEach(function (mesh, mi) {
        var cur = mesh, d = 0;
        while (cur && d < 8) {
            var ss = cur.stateset || cur._stateSet, ta = ss && ss._textureAttributeArrayList;
            if (ta && ta.length) {
                for (var s = 0; s < ta.length; s++) {
                    var w = ta[s] && ta[s][0], tex = w && (w._object || w.attribute || w._attribute);
                    if (!tex || seenTex.indexOf(tex) >= 0) continue;
                    seenTex.push(tex);
                    P('mesh[' + mi + '] slot ' + s + ' texture channels=' + JSON.stringify(tex._channels) + ' size=' + tex._textureWidth + 'x' + tex._textureHeight +
                      ' image=' + (tex._image ? ctor(tex._image) : 'null') + ' name=' + tex._name + ' internalFormat=' + tex._internalFormat + ' target=' + tex._textureTarget + ' type=' + tex._type);
                    P('  userdata keys=' + (tex._userdata ? keys(tex._userdata) : 'none'));
                    var to = tex._textureObject;
                    P('  _textureObject ' + (to ? ctor(to) + ' keys=' + keys(to) : 'none'));
                    var handle = to && (to._texture || to._id || (typeof to.id === 'function' ? to.id() : null));
                    var gl = tex._gl;
                    P('  gl=' + (gl ? ctor(gl) : 'none') + ' handle=' + (handle ? ctor(handle) : 'none'));
                    var pk = tex._packedTextures;
                    if (pk) for (var c in pk) if (pk.hasOwnProperty(c) && pk[c] && pk[c].texture) {
                        var pt = pk[c].texture;
                        P('  packed[' + c + '] keys=' + keys(pt, 30) + ' size=' + pt._textureWidth + 'x' + pt._textureHeight);
                    }
                    try {
                        if (gl && handle && typeof WebGLTexture !== 'undefined' && handle instanceof WebGLTexture && tex._textureWidth) {
                            var w0 = tex._textureWidth, h0 = tex._textureHeight, fb = gl.createFramebuffer();
                            var prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
                            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
                            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, handle, 0);
                            var st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
                            if (st === gl.FRAMEBUFFER_COMPLETE) {
                                var px = new Uint8Array(w0 * h0 * 4);
                                gl.readPixels(0, 0, w0, h0, gl.RGBA, gl.UNSIGNED_BYTE, px);
                                var nz = 0, i;
                                for (i = 0; i < px.length; i++) if (px[i]) nz++;
                                P('  GPU readback OK: first pixels ' + Array.prototype.slice.call(px, 0, 8).join(',') + ' nonzero bytes ' + nz + '/' + px.length);
                            } else { P('  GPU readback: framebuffer incomplete status ' + st); }
                            gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
                            gl.deleteFramebuffer(fb);
                        } else { P('  GPU readback skipped (no WebGLTexture handle found)'); }
                    } catch (e) { P('  GPU readback error: ' + e.message); }
                }
            }
            cur = cur._parents && cur._parents[0];
            d++;
        }
    });
    window.__gpuProbe = out;
    P('read all: window.__gpuProbe.join("\\n")');
})();
