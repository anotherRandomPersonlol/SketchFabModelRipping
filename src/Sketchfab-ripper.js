// ==UserScript==
// @name         Sketchfab Ripper V17
// @version      17.1.0
// @description  download Sketchfab models as GLB with skeleton, recorded animation, and PBR textures
// @author       anotherRandomPersonlol
// @include      /^https?://(www\.)?sketchfab\.com/.*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/1.3.8/FileSaver.js
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==
// Based off Risk's extraction
(function () {
    'use strict';
    var window = unsafeWindow;

    window.allmodel            = window.allmodel            || [];
    window.animationRecording  = false;
    window.recordedFrames      = [];
    window.recordingStartTime  = 0;
    window.recordingRafId      = null;
    window.clips               = [];     // [{ name, uid, frames }]
    window.clipDefs            = [];     // [{ index, uid, name, duration }]
    window.clipRecording       = false;
    window.clipCancel          = false;  // set by the CANCEL button during RECORD ALL CLIPS
    window.autoRecordActive    = false;  // single-clip RECORD is running in auto (one full loop) mode
    window.staticPoseSnapshot  = null;   // snapshotFrame() taken with the viewer's "Static Pose" item selected
    window.clipStaticIdx       = -1;     // list item index of "Static Pose" (the item that activates no clip)
    window.clipProgress        = '';
    window._anyAnchorsMatched  = false;

    var saveimagecache2 = {};
    var objects         = {};
    var button_dw       = false;

    var CONFIG = {
        MAX_RECORD_SECONDS: 12,
        AUTO_RELOAD_ON_FAILURE: true,
        MR_TEXTURE_FORMAT: 'jpeg',  // 'jpeg' (small) or 'png' (lossless)
        CLIP_FPS: 30,               // sample rate for multi-clip recording
        CLIP_SETTLE_FRAMES: 2,      // rAF ticks to wait after seeking to a clip's start
        DEDUPE_STRICT_WORLD: false, // true: keep same-name meshes at different positions
        REST_POSE_SOURCE: 'clip0',  // joint rest pose: 'clip0' (first frame of first clip) or 'static' (viewer's Static Pose)
        TEXTURE_WAIT_SECONDS: 12,   // max wait at export for textures the viewer is still loading (0 = never wait)
        VERTEX_COLOR_SRGB: true,    // true: treat Sketchfab Color bytes as sRGB and write linear COLOR_0 (matches the viewer's look)
        DOUBLE_SIDED: true          // true: mark every material doubleSided (matches Sketchfab's default, Single Sided OFF); untick for single-sided export
    };
    var CONFIG_KEY = 'ripper_config_v1';

    function loadConfig() {
        try {
            var saved = localStorage.getItem(CONFIG_KEY);
            if (!saved) return;
            var parsed = JSON.parse(saved);
            for (var k in parsed) {
                if (parsed.hasOwnProperty(k) && CONFIG.hasOwnProperty(k)) {
                    CONFIG[k] = parsed[k];
                }
            }
        } catch (e) { /* ignore */ }
    }

    function saveConfig() {
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(CONFIG)); }
        catch (e) { /* ignore */ }
    }

    loadConfig();

    // Z-up -> Y-up. Maps (x, y, z) -> (x, z, -y).
    var YUP = [
        1, 0, 0, 0,
        0, 0, -1, 0,
        0, 1, 0, 0,
        0, 0, 0, 1
    ];

    var TAG = '[Ripper]';
    function log()  { console.log.apply(console, [TAG].concat([].slice.call(arguments))); }
    function warn() { console.warn.apply(console, [TAG].concat([].slice.call(arguments))); }
    function err()  { console.error.apply(console, [TAG].concat([].slice.call(arguments))); }

    log('init');

    // ====================================================================
    // Math
    // ====================================================================
    function identityMat4() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }

    function matToArr(m) {
        if (!m || m.length !== 16) return null;
        var o = new Array(16);
        for (var i = 0; i < 16; i++) o[i] = m[i];
        return o;
    }

    function mat4Mul(a, b) {
        var o = new Array(16);
        for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
            o[c*4+r] = a[0*4+r]*b[c*4+0] + a[1*4+r]*b[c*4+1]
                     + a[2*4+r]*b[c*4+2] + a[3*4+r]*b[c*4+3];
        }
        return o;
    }

    // Confirmed from OSG source: MatrixTransform stores local transform
    // in `.matrix` and exposes it via `getMatrix()`.
    function getLocalNodeMatrix(node) {
        if (!node) return identityMat4();
        if (typeof node.getMatrix === 'function') {
            try {
                var m1 = matToArr(node.getMatrix());
                if (m1) return m1;
            } catch (e) {}
        }
        if (node.matrix) {
            var m2 = matToArr(node.matrix);
            if (m2) return m2;
        }
        if (node._matrix) {
            var m3 = matToArr(node._matrix);
            if (m3) return m3;
        }
        return identityMat4();
    }

    function computeWorldMatrix(obj) {
        var chain = [];
        var curr = obj;
        var guard = 0;
        while (curr && guard++ < 64) {
            chain.unshift(getLocalNodeMatrix(curr));
            curr = curr._parents && curr._parents[0];
        }
        var world = identityMat4();
        for (var i = 0; i < chain.length; i++) world = mat4Mul(world, chain[i]);
        return world;
    }

    function decomposeMat4(m) {
        var tx = m[12], ty = m[13], tz = m[14];
        var sx = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
        var sy = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
        var sz = Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);
        var iX = sx ? 1/sx : 0, iY = sy ? 1/sy : 0, iZ = sz ? 1/sz : 0;

        var m00 = m[0]*iX, m01 = m[4]*iY, m02 = m[8]*iZ;
        var m10 = m[1]*iX, m11 = m[5]*iY, m12 = m[9]*iZ;
        var m20 = m[2]*iX, m21 = m[6]*iY, m22 = m[10]*iZ;

        var trace = m00 + m11 + m22;
        var qw, qx, qy, qz;

        if (trace > 0) {
            var S = Math.sqrt(trace + 1) * 2;
            qw = 0.25 * S;
            qx = (m21 - m12) / S;
            qy = (m02 - m20) / S;
            qz = (m10 - m01) / S;
        } else if (m00 > m11 && m00 > m22) {
            var S1 = Math.sqrt(1 + m00 - m11 - m22) * 2;
            qw = (m21 - m12) / S1;
            qx = 0.25 * S1;
            qy = (m01 + m10) / S1;
            qz = (m02 + m20) / S1;
        } else if (m11 > m22) {
            var S2 = Math.sqrt(1 + m11 - m00 - m22) * 2;
            qw = (m02 - m20) / S2;
            qx = (m01 + m10) / S2;
            qy = 0.25 * S2;
            qz = (m12 + m21) / S2;
        } else {
            var S3 = Math.sqrt(1 + m22 - m00 - m11) * 2;
            qw = (m10 - m01) / S3;
            qx = (m02 + m20) / S3;
            qy = (m12 + m21) / S3;
            qz = 0.25 * S3;
        }
        var ql = Math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw);
        if (ql) { qx /= ql; qy /= ql; qz /= ql; qw /= ql; }
        return {
            translation: [tx, ty, tz],
            rotation: [qx, qy, qz, qw],
            scale: [sx || 1, sy || 1, sz || 1]
        };
    }

    // ====================================================================
    // Texture capture
    // ====================================================================
    var _usedTextureNames = {};

    function sanitizeTextureName(raw) {
        if (!raw) return '';
        var s = String(raw);
        try { s = decodeURIComponent(s); } catch (e) {}
        s = s.replace(/\.(jpe?g|png|webp|gif|ktx2?|basis|tga|bmp)$/i, '');
        s = s.replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').trim();
        return s;
    }

    function deriveTextureName(url) {
        if (!url) return 'texture';
        var clean = String(url).split('?')[0].split('#')[0];
        var base = clean.substring(clean.lastIndexOf('/') + 1);
        var s = sanitizeTextureName(base);
        return s || 'texture';
    }

    function pickTextureName(imagemodel, url) {
        // Prefer Sketchfab's metadata name (semantic, e.g.
        // "Patriot_Radar_Body_D_Desert"). Fall back to URL base if
        // metadata is missing or empty.
        var metaName = imagemodel && imagemodel.attributes && imagemodel.attributes.name;
        var s = sanitizeTextureName(metaName);
        if (s) return s;
        return deriveTextureName(url);
    }

    function normalizeUrl(u) {
        if (!u) return '';
        return String(u).split('?')[0].split('#')[0].replace(/\/+$/, '');
    }

    // Read Sketchfab's per-mesh channel -> source-texture mapping.
    // Structure: obj.stateset._textureAttributeArrayList = [
    //   [ AttributePair{_object: Texture} ],   // slot 0
    //   [ AttributePair{_object: Texture} ],   // slot 1
    //   ...
    // ]
    // Each Texture has:
    //   _channels      = ['AlbedoPBR','GlossinessPBR'] etc.
    //   _packedTextures = { AlbedoPBR: {texture: {_image, _imageModel}}, ... }
    // The mesh's own stateset normally carries the textures (Patriot). On some
    // models (the Kalibr) the mesh has no stateset and its material sits on the
    // parent node named after the material, so walk up to the first stateset
    // that has texture slots. The mesh's own stateset always wins when it has them.
    function textureStateSet(obj) {
        function hasTex(ss) {
            var ta = ss && ss._textureAttributeArrayList;
            if (!ta || !ta.length) return false;
            for (var i = 0; i < ta.length; i++) if (ta[i] && ta[i][0]) return true;
            return false;
        }
        if (!obj) return null;
        if (hasTex(obj.stateset)) return obj.stateset;
        var cur = obj._parents && obj._parents[0], guard = 0;
        while (cur && guard++ < 8) {
            if (hasTex(cur.stateset)) return cur.stateset;
            cur = cur._parents && cur._parents[0];
        }
        return obj.stateset || null;
    }

    // Sketchfab keeps each material's flat channel values in a material model:
    // stateset._attributeArray[0]._materialModel.attributes.channels.<Name>.attributes
    // ({ enable, factor, color }). The stateset can sit on an ancestor of the mesh.
    function getMaterialChannels(obj) {
        function unwrap(w) { return w && (w._object || w.attribute || w._attribute || w); }
        var cur = obj, guard = 0;
        while (cur && guard++ < 8) {
            var ss = cur.stateset || cur._stateSet || null;
            var a0 = unwrap(ss && ss._attributeArray && ss._attributeArray[0]);
            var mm = a0 && a0._materialModel;
            var ch = mm && mm.attributes && mm.attributes.channels;
            if (ch) {
                var out = {};
                for (var k in ch) {
                    if (!ch.hasOwnProperty(k)) continue;
                    var at = ch[k] && ch[k].attributes;
                    if (at) out[k] = at;
                }
                return out;
            }
            cur = cur._parents && cur._parents[0];
        }
        return null;
    }

    function getChannelTextureMap(obj) {
        var map = {};
        try {
            var ss = textureStateSet(obj);
            if (!ss) return map;
            var ta = ss._textureAttributeArrayList;
            if (!ta || !ta.length) return map;
            for (var s = 0; s < ta.length; s++) {
                var slot = ta[s];
                if (!slot || !slot[0]) continue;
                var tex = slot[0]._object;
                if (!tex) continue;
                var channels = tex._channels || [];
                var packedAll = tex._packedTextures || {};
                for (var c = 0; c < channels.length; c++) {
                    var chName = channels[c];
                    if (!chName) continue;
                    var packed = packedAll[chName];
                    if (!packed || !packed.texture) continue;
                    var img = packed.texture._image;
                    var imM = packed.texture._imageModel;
                    map[chName] = {
                        url : img && (img._url || img.url),
                        name: imM && imM.attributes && imM.attributes.name
                    };
                }
            }
        } catch (e) { warn('getChannelTextureMap', e.message); }
        return map;
    }

    window.drawhookcanvas = function (e, imagemodel) {
        try {
            if (!e) return e;
            if ((e.width === 128 && e.height === 128) ||
                (e.width === 32  && e.height === 32)  ||
                (e.width === 64  && e.height === 64)) return e;
            if (imagemodel && e.options && imagemodel.attributes && imagemodel.attributes.images) {
                var alpha = e.options.format;
                var url_image = e.url, max_size = 0, obr = e;
                imagemodel.attributes.images.forEach(function (img) {
                    var ok = alpha === 'A' ? img.options.format === alpha : true;
                    var d = img.width; while (d % 2 === 0) d = d / 2;
                    if (img.size > max_size && ok && d === 1) {
                        max_size = img.size; url_image = img.url; obr = img;
                    }
                });
                if (!saveimagecache2[url_image]) {
                    var base = pickTextureName(imagemodel, url_image);
                    var texName = base, n = 1;
                    while (_usedTextureNames[texName]) texName = base + '_' + (n++);
                    _usedTextureNames[texName] = true;
                    saveimagecache2[url_image] = { name: texName };
                }
                return obr;
            }
        } catch (e2) { warn('drawhookcanvas', e2.message); }
        return e;
    };

    window.drawhookimg = function (gl, t) {
        try {
            var url = t[5].currentSrc, width = t[5].width, height = t[5].height;
            if (!saveimagecache2[url]) return;
            if (saveimagecache2[url].dataURL) return;
            var data = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
            var hh = height / 2 | 0, bpr = width * 4, temp = new Uint8Array(width * 4);
            for (var y = 0; y < hh; ++y) {
                var t0 = y * bpr, b0 = (height - y - 1) * bpr;
                temp.set(data.subarray(t0, t0 + bpr));
                data.copyWithin(t0, b0, b0 + bpr);
                data.set(temp, b0);
            }
            var canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            var ctx = canvas.getContext('2d');
            var id = ctx.createImageData(width, height);
            id.data.set(data);
            ctx.putImageData(id, 0, 0);
            var isJpeg = /\.(jpe?g)(?:\?|$)/i.test(url);
            var mime   = isJpeg ? 'image/jpeg' : 'image/png';
            var ext    = isJpeg ? '.jpg' : '.png';
            var q      = isJpeg ? 0.92 : undefined;
            var name   = saveimagecache2[url].name + ext;
            saveimagecache2[url].fileExt = ext;
            saveimagecache2[url].dataURL = canvas.toDataURL(mime, q);
            canvas.toBlob(function (b) { objects[name] = b; }, mime, q);
        } catch (e) { warn('drawhookimg', e.message); }
    };

    // ====================================================================
    // attachbody
    // ====================================================================
    window.attachbody = function (obj) {
        try {
            if (!obj || obj._faked === true) return;
            var name = obj._name;
            var ssName = obj.stateset && obj.stateset._name;
            var pName = (obj._parents && obj._parents.length > 0 && obj._parents[0] && obj._parents[0]._name) || null;
            if (!name && !ssName && !pName) return;
            obj._faked = true;
            if (name === 'composer layer' || name === 'Ground - Geometry') return;
            
            // Dedupe: viewer re-instantiates meshes when WebGL contexts
            // get recycled. A new obj has _faked = false again, so the
            // basic guard doesn't catch it. Merge by name + vertex count.
            // M_Patriot_Radar_Tires legitimately appears twice with
            // DIFFERENT vertex counts, so this won't merge them.
            var displayName = ssName || name || '';
            var vcount = (obj._attributes && obj._attributes.Vertex &&
                        obj._attributes.Vertex._elements)
                        ? obj._attributes.Vertex._elements.length : 0;
            for (var i = 0; i < window.allmodel.length; i++) {
                var ex = window.allmodel[i];
                if (!ex) continue;
                var exName = (ex.stateset && ex.stateset._name) || ex._name || '';
                if (exName !== displayName) continue;
                var exVcount = (ex._attributes && ex._attributes.Vertex &&
                                ex._attributes.Vertex._elements)
                            ? ex._attributes.Vertex._elements.length : 0;
                if (exVcount === vcount) {
                    // Same name + vertex count but a different world position may be a
                    // genuine second instance (e.g. repeated parts), not a re-instantiation.
                    // Animated parents also move a mesh, so by default this only warns and
                    // still merges (unchanged behaviour). Set DEDUPE_STRICT_WORLD to keep both.
                    var wNew = computeWorldMatrix(obj), wEx = computeWorldMatrix(ex), wd = 0;
                    for (var wi = 12; wi < 15; wi++) wd = Math.max(wd, Math.abs(wNew[wi] - wEx[wi]));
                    if (wd > 1e-3) {
                        warn('attachbody: "' + displayName + '" matches an existing mesh but sits ' +
                             wd.toFixed(4) + ' away; ' +
                             (CONFIG.DEDUPE_STRICT_WORLD ? 'keeping both' : 'merging (DEDUPE_STRICT_WORLD off)'));
                        if (CONFIG.DEDUPE_STRICT_WORLD) continue;
                    }
                    // Replace so the latest instance (with live palette)
                    // is what we read from during recording.
                    window.allmodel[i] = obj;
                    return;
                }
            }
            window.allmodel.push(obj);
        } catch (e) { err('attachbody', e.message); }
    };

    // ====================================================================
    // Recorder
    // ====================================================================
    // Morph targets: the viewer keeps target k's absolute vertex data in attribute
    // Vertex_k (Normal_k) and the live blend weights in obj._targetWeights.
    function morphTargetCount(obj) {
        var attr = obj && obj._attributes, n = 0;
        if (!attr) return 0;
        for (var k in attr) {
            if (!attr.hasOwnProperty(k)) continue;
            var m = /^Vertex_(\d+)$/.exec(k);
            if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
        }
        return n;
    }

    function snapshotFrame() {
        var meshesOut = [];
        window.allmodel.forEach(function (obj) {
            var world = computeWorldMatrix(obj);
            var wts = null;
            try {
                var nT = morphTargetCount(obj);
                if (nT && obj._targetWeights) {
                    wts = new Float32Array(nT);
                    for (var wi = 0; wi < nT; wi++) wts[wi] = obj._targetWeights[wi] || 0;
                }
            } catch (e) {}
            var pal = null;
            try {
                var impl = obj._rigTransformImplementation;
                if (impl && impl._skinningAttribute && impl._skinningAttribute._matrixPalette) {
                    var src = impl._skinningAttribute._matrixPalette;
                    pal = new Float32Array(src.length);
                    for (var i = 0; i < src.length; i++) pal[i] = src[i];
                }
            } catch (e) {}
            meshesOut.push({ world: world, palette: pal, weights: wts });
        });
        return { meshes: meshesOut };
    }

    // Single-clip RECORD with exactly one active clip: restart that clip and record
    // exactly one loop (0..duration) automatically. Returns false when that is not
    // possible, so the caller falls back to the manual timed recording.
    function startAutoSingleRecording() {
        var mgr = findAnimationManager();
        if (!mgr) return false;
        var act = activeClipUids(mgr);
        if (act.length !== 1) return false;
        var inst = mgr._instanceAnimations[act[0]];
        if (!inst || !(inst.duration > 0)) return false;
        var def = { uid: act[0], name: inst.name || act[0], duration: inst.duration };
        window.animationRecording = true;
        window.autoRecordActive = true;
        window.clipCancel = false;
        window.recordedFrames = [];
        if (window.clips && window.clips.length) {
            log('single-clip record: discarded ' + window.clips.length + ' stored multi-clip recording(s)');
        }
        window.clips = [];
        setRecLabel('STOP');
        var base = inst.start || 0;
        log('auto record: one full loop of the active clip (' + def.duration.toFixed(2) + 's)');
        mgr.setSeekTime(base);
        waitFrames(CONFIG.CLIP_SETTLE_FRAMES, function () {
            recordClipRealtime(mgr, def, base, function (frames) {
                window.animationRecording = false;
                window.autoRecordActive = false;
                window.clipCancel = false;
                setRecLabel('RECORD');
                if (frames && frames.length > 1) {
                    window.recordedFrames = frames;
                    log('recording stopped, frames:', frames.length);
                } else {
                    warn('auto record produced no frames');
                }
            });
        });
        return true;
    }

    function startRecording() {
        if (window.animationRecording || window.clipRecording) return;
        if (startAutoSingleRecording()) return;
        window.animationRecording = true;
        window.recordedFrames = [];
        // A fresh single-clip recording must win at export time. Stale multi-clip
        // data from an earlier RECORD ALL CLIPS run would otherwise override it.
        if (window.clips && window.clips.length) {
            log('single-clip record: discarded ' + window.clips.length + ' stored multi-clip recording(s)');
        }
        window.clips = [];
        window.recordingStartTime = performance.now() / 1000;
        setRecLabel('STOP');
        log('recording started (max ' + CONFIG.MAX_RECORD_SECONDS + 's)');
        function tick() {
            if (!window.animationRecording) return;
            var t = performance.now() / 1000 - window.recordingStartTime;
            var snap = snapshotFrame();
            window.recordedFrames.push({ time: t, meshes: snap.meshes });
            if (t >= CONFIG.MAX_RECORD_SECONDS) { stopRecording(); return; }
            window.recordingRafId = requestAnimationFrame(tick);
        }
        window.recordingRafId = requestAnimationFrame(tick);
    }

    function stopRecording() {
        if (!window.animationRecording) return;
        if (window.autoRecordActive) { window.clipCancel = true; return; }
        window.animationRecording = false;
        cancelAnimationFrame(window.recordingRafId);
        setRecLabel('RECORD');
        log('recording stopped, frames:', window.recordedFrames.length);
    }

    function setRecLabel(text) {
        var el = document.getElementById('recBtnLabel');
        if (el) el.textContent = text;
    }

    // ====================================================================
    // Animation clips
    // ====================================================================
    var _clipMgrCache = null;

    function findAnimationManager() {
        if (_clipMgrCache && _clipMgrCache._instanceAnimations) return _clipMgrCache;
        var cur = window.allmodel[0], guard = 0;
        while (cur && guard++ < 64) {
            var cbs = cur._updateCallbacks || [];
            for (var i = 0; i < cbs.length; i++) {
                var c = cbs[i];
                if (c && c._instanceAnimations && typeof c.stopAllAnimation === 'function') {
                    _clipMgrCache = c;
                    return c;
                }
            }
            cur = cur._parents && cur._parents[0];
        }
        return null;
    }

    function getClipCount() {
        var mgr = findAnimationManager();
        return mgr ? Object.keys(mgr._instanceAnimations).length : 0;
    }

    function waitFrames(n, cb) {
        if (n <= 0) { cb(); return; }
        requestAnimationFrame(function () { waitFrames(n - 1, cb); });
    }

    function activeClipUids(mgr) {
        var out = [];
        var list = mgr._activeAnimationList || [];
        for (var i = 0; i < list.length; i++) out.push(list[i].name);
        return out;
    }

    // UI class names can change; try the known selector first, then looser ones.
    // Non-clip items are harmless: discovery skips any item that activates no clip.
    var CLIP_ITEM_SELECTORS = [
        '.animation-list .animation-item',
        '[class*="animation"][class*="list"] li',
        'li[class*="animation-item"]'
    ];

    function getClipItems() {
        for (var s = 0; s < CLIP_ITEM_SELECTORS.length; s++) {
            var found = document.querySelectorAll(CLIP_ITEM_SELECTORS[s]);
            if (found.length) return found;
        }
        return [];
    }

    // Click list item k (the viewer does its own stop/start) and wait.
    function selectClipItem(k, cb) {
        var items = getClipItems();
        if (!items[k]) { cb(false); return; }
        // Drain any start queued earlier (e.g. by a stray playAnimation call). The
        // manager flushes _startAnimations on its next update, and a leftover shows up
        // as an extra active clip. stopAllAnimation() does NOT clear this queue.
        var mgr = findAnimationManager();
        if (mgr && mgr._startAnimations) mgr._startAnimations = {};
        items[k].click();
        waitFrames(6, function () { cb(true); });
    }

    // Clicks every list item and reads which clip UID became active.
    // cb(defs, origIdx): defs = [{ index, uid, name, duration }];
    // origIdx = list item that was selected before discovery (restored at the end).
    function discoverAnimationClips(cb) {
        var mgr = findAnimationManager();
        var count = getClipItems().length;
        if (!mgr || !count) {
            warn('clip discovery: manager=' + !!mgr + ' listItems=' + count);
            cb([], 0);
            return;
        }
        var origUid = activeClipUids(mgr)[0] || null;
        var defs = [], noClipIdx = -1, i = 0;

        function next() {
            if (i >= count) { finish(); return; }
            var k = i++;
            selectClipItem(k, function (ok) {
                if (!ok) { next(); return; }
                var li = getClipItems()[k];
                var name = (li.textContent || '').trim().replace(/\s+/g, ' ');
                var act = activeClipUids(mgr);
                if (act.length === 1) {
                    var inst = mgr._instanceAnimations[act[0]];
                    defs.push({ index: k, uid: act[0], name: name,
                                duration: inst ? inst.duration : 0 });
                } else if (act.length === 0) {
                    noClipIdx = k;
                    log('list item ' + k + ' "' + name + '" has no clip (treated as the Static Pose item)');
                } else {
                    warn('list item ' + k + ' "' + name + '" activated ' + act.length + ' clips, skipped');
                }
                next();
            });
        }

        function finish() {
            window.clipStaticIdx = noClipIdx;
            var origIdx = (noClipIdx >= 0) ? noClipIdx : 0;
            for (var d = 0; d < defs.length; d++) {
                if (defs[d].uid === origUid) { origIdx = defs[d].index; break; }
            }
            selectClipItem(origIdx, function () {
                window.clipDefs = defs;
                log('discovered ' + defs.length + ' clips');
                for (var q = 0; q < defs.length; q++) {
                    log('clip ' + defs[q].index + ': ' + defs[q].name +
                        ' (' + defs[q].duration.toFixed(2) + 's)');
                }
                cb(defs, origIdx);
            });
        }
        next();
    }

    function recordClipRealtime(mgr, def, base, cb) {
        mgr.setSeekTime(base);
        if (mgr._pause) mgr.togglePause();
        // Frame times come from the manager's own clock (getSimulationTime) so they
        // match what the viewer is showing even if rAF drops frames or _timeFactor
        // is not 1. Falls back to wall-clock time if that clock is unavailable.
        var hasSimClock = typeof mgr.getSimulationTime === 'function';
        var wall0 = performance.now() / 1000, sim0 = null, lastT = -1, frames = [];
        var useSim = hasSimClock;
        function clockNow() {
            if (useSim) {
                var s = mgr.getSimulationTime();
                if (typeof s === 'number' && isFinite(s)) {
                    if (sim0 === null) sim0 = s;
                    return s - sim0;
                }
                warn('sim clock returned ' + s + ', falling back to wall clock');
                useSim = false;
                wall0 = performance.now() / 1000 - (lastT > 0 ? lastT : 0);
            }
            return performance.now() / 1000 - wall0;
        }
        // Samples cover [0, duration). The closing frame at t = duration is a copy
        // of frame 0 (the clip loops). We never keep a sample taken at or past the
        // end: in "Play all" mode the viewer may already have switched clips there.
        var finished = false;
        function finish(why) {
            if (finished) return;
            finished = true;
            if (frames.length && frames[frames.length - 1].time < def.duration - 1e-4) {
                frames.push({ time: def.duration, meshes: frames[0].meshes });
            }
            if (why) warn('clip ' + def.name + ': ' + why + ', frames=' + frames.length);
            cb(frames);
        }
        function tick() {
            try { tickBody(); } catch (e) {
                err('clip ' + def.name + ' tick', e.message);
                finish('error, truncated');
            }
        }
        function tickBody() {
            if (window.clipCancel) { finish('cancelled'); return; }
            var t = clockNow();
            if (t >= def.duration) { finish(null); return; }
            var act = activeClipUids(mgr);
            if (act.length !== 1 || act[0] !== def.uid) {
                // "Play all" advances to the next clip as this one ends, and the sim
                // clock restarts. If we already have (almost) the whole clip, that is
                // the normal end, not a problem.
                if (lastT >= def.duration - 0.1) {
                    log('clip ' + def.name + ': viewer moved to the next clip at the end, frames=' + frames.length);
                    finish(null);
                    return;
                }
                finish('active clip changed mid-recording at t=' + t.toFixed(3) +
                       ' (active=' + act.join(',') + '), truncated');
                return;
            }
            // Keep times strictly increasing (a paused/stuck clock repeats values).
            if (t > lastT) {
                frames.push({ time: t, meshes: snapshotFrame().meshes });
                lastT = t;
            }
            // Safety net: sim clock stuck, so end by wall time instead of looping forever.
            if (performance.now() / 1000 - wall0 > def.duration + 3) {
                finish('clock stalled at t=' + t.toFixed(3));
                return;
            }
            requestAnimationFrame(tick);
        }
        log('clip clock: ' + (useSim ? 'manager simulation time' : 'wall clock') + ' (' + def.name + ')');
        requestAnimationFrame(tick);
    }

    function recordClip(mgr, def, cb) {
        selectClipItem(def.index, function (ok) {
            var act = activeClipUids(mgr);
            if (!ok || act.length !== 1 || act[0] !== def.uid) {
                warn('clip switch failed: ' + def.name + ' active=' + act.join(','));
                cb(null);
                return;
            }
            var inst = mgr._instanceAnimations[def.uid];
            var base = (inst && inst.start) || 0;
            if (!mgr._pause) mgr.togglePause();
            // Real-time capture only: seek-based sampling while paused updates the
            // palette too sparsely on this viewer. Seek to the clip start, let it
            // settle, then record while the clip plays.
            mgr.setSeekTime(base);
            waitFrames(CONFIG.CLIP_SETTLE_FRAMES, function () {
                recordClipRealtime(mgr, def, base, cb);
            });
        });
    }

    // Selects the viewer's "Static Pose" item and stores a palette snapshot. Used as
    // the joint rest pose when CONFIG.REST_POSE_SOURCE === 'static'. cb() is always
    // called; on any problem the snapshot stays null and export falls back to clip 0.
    function captureStaticPose(mgr, cb) {
        window.staticPoseSnapshot = null;
        if (window.clipStaticIdx < 0) {
            warn('static pose: no clip-less list item found, snapshot skipped');
            cb();
            return;
        }
        selectClipItem(window.clipStaticIdx, function (ok) {
            var act = activeClipUids(mgr);
            if (!ok || act.length) {
                warn('static pose: selecting the item failed or left clips active (' + act.length + ')');
                cb();
                return;
            }
            // The viewer may skip updates while paused with no clip; let it run briefly.
            if (mgr._pause) mgr.togglePause();
            waitFrames(6, function () {
                var snapA = snapshotFrame();
                waitFrames(3, function () {
                    var snapB = snapshotFrame(), moved = 0;
                    for (var m = 0; m < snapA.meshes.length; m++) {
                        var pa = snapA.meshes[m].palette, pb = snapB.meshes[m] && snapB.meshes[m].palette;
                        if (!pa || !pb) continue;
                        for (var i = 0; i < pa.length; i++) {
                            if (Math.abs(pa[i] - pb[i]) > 1e-5) { moved++; break; }
                        }
                    }
                    if (moved) warn('static pose: ' + moved + ' mesh palette(s) still changing; using the later snapshot');
                    window.staticPoseSnapshot = snapB;
                    log('static pose captured, meshes=' + snapB.meshes.length);
                    cb();
                });
            });
        });
    }

    function setRecAllLabel(text) {
        var el = document.getElementById('recAllBtn');
        if (el) el.textContent = text;
    }

    function endRecordAll(mgr, wasPaused, origIdx) {
        function reset() {
            window.clipRecording = false;
            window.clipCancel = false;
            window.clipProgress = '';
            setRecAllLabel('RECORD ALL CLIPS');
            log('record-all finished, clips recorded: ' + window.clips.length);
        }
        try {
            selectClipItem(origIdx, function () {
                try { if (mgr._pause !== wasPaused) mgr.togglePause(); }
                catch (e) { err('endRecordAll restore pause', e.message); }
                reset();
            });
        } catch (e) {
            err('endRecordAll', e.message);
            reset();   // never leave clipRecording stuck on true
        }
    }

    function recordAllClips() {
        if (window.animationRecording || window.clipRecording) {
            warn('already recording');
            return;
        }
        var mgr = findAnimationManager();
        if (!mgr) { warn('no animation manager found; use RECORD (single clip)'); return; }
        window.clipRecording = true;
        window.clips = [];
        window.clipCancel = false;
        setRecAllLabel('CANCEL');
        var wasPaused = mgr._pause;
        log('record-all started, clips in manager: ' + getClipCount() +
            ', fps ' + CONFIG.CLIP_FPS + ' (keep this tab visible)');
        var safeOrigIdx = 0;
        try {
        discoverAnimationClips(function (defs, origIdx) {
            safeOrigIdx = origIdx;
            if (defs.length < 2) {
                warn('only ' + defs.length + ' usable clip(s); single-clip path stays in use');
                endRecordAll(mgr, wasPaused, origIdx);
                return;
            }
            var i = 0;
            function nextClip() {
                if (i >= defs.length || window.clipCancel) {
                    if (window.clipCancel) warn('record-all cancelled, keeping ' + window.clips.length + ' recorded clip(s)');
                    endRecordAll(mgr, wasPaused, origIdx);
                    return;
                }
                var d = defs[i++];
                window.clipProgress = i + '/' + defs.length;
                try {
                recordClip(mgr, d, function (frames) {
                    if (window.clipCancel) {
                        warn('clip discarded (cancelled): ' + d.name);
                    } else if (frames && frames.length > 1) {
                        window.clips.push({ name: d.name, uid: d.uid, frames: frames });
                        log('clip recorded: ' + d.name + ' frames=' + frames.length);
                    } else {
                        warn('clip skipped: ' + d.name);
                    }
                    nextClip();
                });
                } catch (e) {
                    err('record-all clip ' + d.name, e.message);
                    endRecordAll(mgr, wasPaused, origIdx);
                }
            }
            captureStaticPose(mgr, function () { nextClip(); });
        });
        } catch (e) {
            err('record-all', e.message);
            endRecordAll(mgr, wasPaused, safeOrigIdx);
        }
    }

    // ====================================================================
    // UI panel
    // ====================================================================
    function addbtnfunc() {
        if (button_dw) return;
        if (!document.body) { setTimeout(addbtnfunc, 500); return; }
        if (document.getElementById('ripper-panel')) { button_dw = true; return; }

        var panel = document.createElement('div');
        panel.id = 'ripper-panel';
        panel.style.cssText = [
            'position:fixed', 'top:70px', 'right:16px', 'z-index:2147483647',
            'background:rgba(20,20,20,0.9)', 'border:1px solid #444', 'border-radius:8px',
            'padding:8px', 'font-family:monospace', 'font-size:12px', 'color:#eee',
            'display:flex', 'flex-direction:column', 'gap:6px', 'min-width:150px',
            'box-shadow:0 4px 16px rgba(0,0,0,0.5)'
        ].join(';');

        var titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding-bottom:4px;border-bottom:1px solid #444;';

        var title = document.createElement('div');
        title.textContent = 'MODEL RIPPER';
        title.style.cssText = 'font-weight:bold;color:#f80;cursor:move;user-select:none;flex:1;text-align:left;';
        titleRow.appendChild(title);

        var gear = document.createElement('span');
        gear.textContent = '⚙';
        gear.title = 'Settings';
        gear.style.cssText = 'cursor:pointer;color:#aaa;font-size:14px;padding:0 4px;user-select:none;';
        titleRow.appendChild(gear);

        panel.appendChild(titleRow);

        var btnDL = document.createElement('button');
        btnDL.textContent = 'DOWNLOAD GLB';
        btnDL.style.cssText = 'padding:6px 10px;background:#c22;color:#fff;border:0;border-radius:4px;cursor:pointer;font-family:monospace;font-size:12px;';
        btnDL.addEventListener('click', function () { downloadGLB(); });
        panel.appendChild(btnDL);

        var btnRec = document.createElement('button');
        btnRec.id = 'recBtnLabel';
        btnRec.textContent = 'RECORD';
        btnRec.style.cssText = btnDL.style.cssText;
        btnRec.addEventListener('click', function () {
            if (!window.animationRecording) startRecording(); else stopRecording();
        });
        panel.appendChild(btnRec);

        var btnAll = document.createElement('button');
        btnAll.id = 'recAllBtn';
        btnAll.textContent = 'RECORD ALL CLIPS';
        btnAll.style.cssText = btnDL.style.cssText;
        btnAll.addEventListener('click', function () {
            if (window.clipRecording) {
                window.clipCancel = true;
                setRecAllLabel('CANCELLING...');
                log('record-all: cancel requested');
                return;
            }
            recordAllClips();
        });
        panel.appendChild(btnAll);

        // RECORD ALL CLIPS only makes sense with 2+ clips: grey it out otherwise.
        function refreshAllBtn() {
            if (window.clipRecording) return;
            var n = 0;
            try { n = getClipCount(); } catch (e) {}
            var off = n < 2;
            btnAll.disabled = off;
            btnAll.style.opacity = off ? '0.4' : '1';
            btnAll.style.cursor = off ? 'not-allowed' : 'pointer';
            btnAll.title = off ? (n === 1 ? 'Only one clip: use RECORD (records one full loop automatically)' : 'No animation clips found yet') : '';
        }
        refreshAllBtn();
        setInterval(refreshAllBtn, 2000);

        var status = document.createElement('div');
        status.id = 'ripper-status';
        status.style.cssText = 'font-size:10px;color:#aaa;text-align:center;';
        status.textContent = 'idle';
        panel.appendChild(status);

        // ---- config form (hidden until gear clicked) ----
        var configDiv = document.createElement('div');
        configDiv.id = 'ripper-config';
        configDiv.style.cssText = 'display:none;flex-direction:column;gap:5px;padding-top:5px;border-top:1px solid #444;font-size:11px;';

        var row1 = document.createElement('div');
        row1.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        var label1 = document.createElement('span');
        label1.textContent = 'Max seconds:';
        row1.appendChild(label1);
        var input1 = document.createElement('input');
        input1.type = 'number';
        input1.min = '1';
        input1.max = '60';
        input1.value = CONFIG.MAX_RECORD_SECONDS;
        input1.style.cssText = 'width:52px;background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        input1.addEventListener('change', function () {
            var v = parseInt(input1.value, 10);
            if (isNaN(v) || v < 1) v = 1;
            if (v > 60) v = 60;
            input1.value = v;
            CONFIG.MAX_RECORD_SECONDS = v;
            saveConfig();
        });
        row1.appendChild(input1);
        configDiv.appendChild(row1);

        var row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        var label2 = document.createElement('span');
        label2.textContent = 'Auto-reload:';
        row2.appendChild(label2);
        var check2 = document.createElement('input');
        check2.type = 'checkbox';
        check2.checked = CONFIG.AUTO_RELOAD_ON_FAILURE;
        check2.addEventListener('change', function () {
            CONFIG.AUTO_RELOAD_ON_FAILURE = check2.checked;
            saveConfig();
        });
        row2.appendChild(check2);
        configDiv.appendChild(row2);

        var row5 = document.createElement('div');
        row5.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        var label5 = document.createElement('span');
        label5.textContent = 'Double sided:';
        row5.appendChild(label5);
        var check5 = document.createElement('input');
        check5.type = 'checkbox';
        check5.checked = !!CONFIG.DOUBLE_SIDED;
        check5.addEventListener('change', function () {
            CONFIG.DOUBLE_SIDED = check5.checked;
            saveConfig();
            log('double sided set to ' + check5.checked);
        });
        row5.appendChild(check5);
        configDiv.appendChild(row5);

        var row6 = document.createElement('div');
        row6.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        var label6 = document.createElement('span');
        label6.textContent = 'Vertex color sRGB>linear:';
        row6.appendChild(label6);
        var check6 = document.createElement('input');
        check6.type = 'checkbox';
        check6.checked = !!CONFIG.VERTEX_COLOR_SRGB;
        check6.addEventListener('change', function () {
            CONFIG.VERTEX_COLOR_SRGB = check6.checked;
            saveConfig();
            log('vertex color sRGB->linear set to ' + check6.checked);
        });
        row6.appendChild(check6);
        configDiv.appendChild(row6);

        var row3 = document.createElement('div');
        row3.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        var label3 = document.createElement('span');
        label3.textContent = 'MR format:';
        row3.appendChild(label3);
        var sel3 = document.createElement('select');
        sel3.style.cssText = 'background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        [['jpeg','JPEG (small)'], ['png','PNG (lossless)']].forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt[0];
            o.textContent = opt[1];
            if (CONFIG.MR_TEXTURE_FORMAT === opt[0]) o.selected = true;
            sel3.appendChild(o);
        });
        sel3.addEventListener('change', function () {
            CONFIG.MR_TEXTURE_FORMAT = sel3.value;
            saveConfig();
        });
        row3.appendChild(sel3);
        configDiv.appendChild(row3);

        var row4 = document.createElement('div');
        row4.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        var label4 = document.createElement('span');
        label4.textContent = 'Rest pose:';
        row4.appendChild(label4);
        var sel4 = document.createElement('select');
        sel4.style.cssText = 'background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        [['clip0','Clip 1st frame'], ['static','Static Pose']].forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt[0];
            o.textContent = opt[1];
            if (CONFIG.REST_POSE_SOURCE === opt[0]) o.selected = true;
            sel4.appendChild(o);
        });
        sel4.addEventListener('change', function () {
            CONFIG.REST_POSE_SOURCE = sel4.value;
            saveConfig();
            log('rest pose source set to ' + sel4.value);
        });
        row4.appendChild(sel4);
        configDiv.appendChild(row4);

        panel.appendChild(configDiv);

        gear.addEventListener('click', function () {
            configDiv.style.display = configDiv.style.display === 'none' ? 'flex' : 'none';
        });

        document.body.appendChild(panel);
        button_dw = true;
        log('panel added');

        // Warn if the bad bundle was served. After 8s, show hint. After
        // 12s, auto-reload once (guarded by sessionStorage so we don't loop).
        setTimeout(function () {
            if (window._anyAnchorsMatched) return;
            var s = document.getElementById('ripper-status');
            if (s) {
                s.textContent = '⚠ no anchors — reload page';
                s.style.color = '#f80';
            }
            log('no anchors matched after 8s; bundle is the incompatible build');
        }, 8000);

        setTimeout(function () {
            if (window._anyAnchorsMatched) return;
            var already;
            try { already = sessionStorage.getItem('ripper_reloaded'); } catch (e) { already = '1'; }
            if (already) return;
            if (!CONFIG.AUTO_RELOAD_ON_FAILURE) return;
            try { sessionStorage.setItem('ripper_reloaded', '1'); } catch (e) {}
            log('no anchors after 12s, auto-reloading once');
            location.reload();
        }, 12000);

        setInterval(function () {
            var s = document.getElementById('ripper-status');
            if (!s) return;
            var m = window.allmodel.length;
            var f = window.recordedFrames.length;
            var busy = window.animationRecording || window.clipRecording;
            s.textContent = (window.animationRecording ? '● REC'
                          : (window.clipRecording ? '● CLIPS ' + window.clipProgress : 'idle'))
                          + ' · meshes:' + m + ' frames:' + f
                          + ' · clips:' + getClipCount()
                          + (window.clips.length ? ' (rec ' + window.clips.length + ')' : '');
            s.style.color = busy ? '#f66' : '#aaa';
        }, 500);

        (function (el, handle) {
            var ox = 0, oy = 0, drag = false;
            handle.addEventListener('mousedown', function (e) {
                drag = true; ox = e.clientX - el.offsetLeft; oy = e.clientY - el.offsetTop; e.preventDefault();
            });
            document.addEventListener('mousemove', function (e) {
                if (!drag) return;
                el.style.left = (e.clientX - ox) + 'px';
                el.style.top  = (e.clientY - oy) + 'px';
                el.style.right = 'auto';
            });
            document.addEventListener('mouseup', function () { drag = false; });
        })(panel, title);
    }

    // ====================================================================
    // parseobj
    // ====================================================================
    function parseobj(obj) {
        var list = [];
        (obj._primitives || []).forEach(function (p) {
            if (p && p.indices) list.push({ mode: p.mode, indices: p.indices._elements });
        });
        var attr = obj._attributes || {};
        var joints  = attr.Joints0  || attr.JOINTS_0 || attr.joints0 || attr.Joints  || attr.JOINTS  || attr.Bones || attr.BONES;
        var weights = attr.Weights0 || attr.WEIGHTS_0 || attr.weights0 || attr.Weights || attr.WEIGHTS || attr.BoneWeights || attr.BONEWEIGHTS;
        if (joints)  joints  = joints._elements;
        if (weights) weights = weights._elements;
        // Sketchfab assigns arbitrary TexCoordN indices per mesh
        // (e.g. TexCoord0, TexCoord3, TexCoord6 on the same model),
        // so scan for any TexCoordN key rather than hard-coding.
        var uvAttr = null;
        var _uvBestNum = Infinity;
        for (var _k in attr) {
            if (!attr.hasOwnProperty(_k)) continue;
            var _m = /^TexCoord(\d+)$/.exec(_k);
            if (!_m) continue;
            var _a = attr[_k];
            if (!_a || !_a._elements || !_a._elements.length) continue;
            var _n = parseInt(_m[1], 10);
            if (_n < _uvBestNum) {
                _uvBestNum = _n;
                uvAttr = _a;
            }
        }

        return {
            vertex: attr.Vertex ? attr.Vertex._elements : [],
            normal: attr.Normal ? attr.Normal._elements : [],
            uv: uvAttr ? uvAttr._elements : [],
            color: (attr.Color && attr.Color._elements) ? attr.Color._elements : [],
            joints: joints,
            weights: weights,
            primitives: list
        };
    }

    // ====================================================================
    // MetallicRoughness merge
    // ====================================================================
    // glTF wants metalness in B, roughness in G of one texture. Sketchfab
    // ships them as separate grayscale images (MetalnessPBR, RoughnessPBR,
    // or GlossinessPBR). Merge per mesh into one <mesh>_MR.png.
    function _blobForSanitizedName(sanitized) {
        for (var key in saveimagecache2) {
            if (!saveimagecache2.hasOwnProperty(key)) continue;
            var t = saveimagecache2[key];
            if (!t || !t.dataURL) continue;
            if (sanitizeTextureName(t.name) === sanitized) {
                var ext = t.fileExt || '.png';
                var fname = t.name + ext;
                if (objects[fname]) return objects[fname];
            }
        }
        return null;
    }

    function _mergeOneMR(cm) {
        var metalSan = cm.MetalnessPBR && cm.MetalnessPBR.name
                     ? sanitizeTextureName(cm.MetalnessPBR.name) : null;
        var roughSan = cm.RoughnessPBR && cm.RoughnessPBR.name
                     ? sanitizeTextureName(cm.RoughnessPBR.name) : null;
        var glossSan = cm.GlossinessPBR && cm.GlossinessPBR.name
                     ? sanitizeTextureName(cm.GlossinessPBR.name) : null;

        var metalBlob = metalSan ? _blobForSanitizedName(metalSan) : null;
        var roughBlob = roughSan ? _blobForSanitizedName(roughSan) : null;
        var glossBlob = glossSan ? _blobForSanitizedName(glossSan) : null;

        if (!metalBlob && !roughBlob && !glossBlob) return Promise.resolve(null);

        var pending = [];
        if (metalBlob) pending.push(createImageBitmap(metalBlob));
        if (roughBlob) pending.push(createImageBitmap(roughBlob));
        if (glossBlob) pending.push(createImageBitmap(glossBlob));

        return Promise.all(pending).then(function (bmps) {
            var i = 0;
            var mBmp = metalBlob ? bmps[i++] : null;
            var rBmp = roughBlob ? bmps[i++] : null;
            var gBmp = glossBlob ? bmps[i++] : null;
            var ref = mBmp || rBmp || gBmp;
            var W = ref.width, H = ref.height;

            function readGray(bmp) {
                var c = document.createElement('canvas');
                c.width = W; c.height = H;
                var x = c.getContext('2d');
                x.drawImage(bmp, 0, 0, W, H);
                return x.getImageData(0, 0, W, H).data;
            }
            var mData = mBmp ? readGray(mBmp) : null;
            var rData = rBmp ? readGray(rBmp) : null;
            var gData = gBmp ? readGray(gBmp) : null;

            var out = new Uint8ClampedArray(W * H * 4);
            for (var p = 0; p < W * H; p++) {
                var metal = mData ? mData[p * 4] : 0;
                var rough;
                if (rData) rough = rData[p * 4];
                else if (gData) rough = 255 - gData[p * 4];
                else rough = 255;
                out[p * 4 + 0] = 255;
                out[p * 4 + 1] = rough;
                out[p * 4 + 2] = metal;
                out[p * 4 + 3] = 255;
            }

            var oc = document.createElement('canvas');
            oc.width = W; oc.height = H;
            oc.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
            var useJpeg = CONFIG.MR_TEXTURE_FORMAT !== 'png';
            var mime = useJpeg ? 'image/jpeg' : 'image/png';
            var ext  = useJpeg ? '.jpg' : '.png';
            var q    = useJpeg ? 0.92 : undefined;
            return new Promise(function (res) {
                oc.toBlob(function (b) { res({ blob: b, ext: ext }); }, mime, q);
            });
        });
    }

    function mergeMRTextures() {
        var jobs = [];
        var seen = {};
        window.allmodel.forEach(function (obj, i) {
            var ss = obj.stateset;
            var meshName = obj._name
                         || (ss && ss._name)
                         || ('mesh_' + i);
            var cm = getChannelTextureMap(obj);
            if (!cm.MetalnessPBR && !cm.RoughnessPBR && !cm.GlossinessPBR) return;
            var san = sanitizeTextureName(meshName);
            if (seen[san]) return;
            seen[san] = true;
            jobs.push(
                _mergeOneMR(cm).then(function (result) {
                    if (!result || !result.blob) return;
                    var fname = san + '_MR' + result.ext;
                    objects[fname] = result.blob;
                    saveimagecache2['__merged_mr__:' + san] = {
                        name: san + '_MR',
                        fileExt: result.ext,
                        dataURL: 'merged'
                    };
                    log('merged MR:', meshName, '→', fname, result.blob.size + 'B');
                }).catch(function (e) {
                    warn('MR merge failed for', meshName, e.message);
                })
            );
        });
        return jobs.length ? Promise.all(jobs) : Promise.resolve();
    }

    // ====================================================================
    // Opacity merge
    // ====================================================================
    // Sketchfab ships transparency as a separate grayscale Opacity image
    // (black = see-through, white = opaque; often a JPEG, so we use its
    // luminance, not a real alpha channel). glTF wants it in the alpha of the
    // base color texture. Merge per mesh into <mesh>_Alpha.png and mark the
    // material BLEND. The color and mask can share one metadata name (both
    // "HEMTT_Glass_BaseColor" on the Patriot), so sources are matched by URL.
    function _urlTail(u) {
        var parts = normalizeUrl(u).split('/');
        var last = parts[parts.length - 1] || '';
        return last.replace(/\.[A-Za-z0-9]+$/, '');
    }

    function _blobForUrl(url) {
        var want = normalizeUrl(url), wantTail = _urlTail(url), hit = null, key, t;
        // Exact URL first, then the file hash (Sketchfab serves size variants of
        // the same file under different paths).
        for (key in saveimagecache2) {
            if (!saveimagecache2.hasOwnProperty(key)) continue;
            t = saveimagecache2[key];
            if (t && t.dataURL && want && normalizeUrl(key) === want) { hit = t; break; }
        }
        if (!hit && wantTail) {
            for (key in saveimagecache2) {
                if (!saveimagecache2.hasOwnProperty(key)) continue;
                t = saveimagecache2[key];
                if (t && t.dataURL && _urlTail(key) === wantTail) { hit = t; break; }
            }
        }
        if (!hit) return null;
        return objects[hit.name + (hit.fileExt || '.png')] || null;
    }

    function _mergeOneOpacity(cm) {
        var colorBlob = _blobForUrl(cm.AlbedoPBR.url);
        var maskBlob = _blobForUrl(cm.Opacity.url);
        if (!colorBlob || !maskBlob) {
            warn('opacity merge: missing source (color=' + !!colorBlob + ' mask=' + !!maskBlob + ')');
            return Promise.resolve(null);
        }
        return Promise.all([createImageBitmap(colorBlob), createImageBitmap(maskBlob)]).then(function (bmps) {
            var cBmp = bmps[0], mBmp = bmps[1];
            var W = cBmp.width, H = cBmp.height;
            function readPixels(bmp) {
                var c = document.createElement('canvas');
                c.width = W; c.height = H;
                var x = c.getContext('2d');
                x.drawImage(bmp, 0, 0, W, H);   // the mask is scaled to the color size
                return x.getImageData(0, 0, W, H).data;
            }
            var cData = readPixels(cBmp), mData = readPixels(mBmp);
            var out = new Uint8ClampedArray(W * H * 4);
            for (var p = 0; p < W * H; p++) {
                var q = p * 4;
                out[q] = cData[q];
                out[q + 1] = cData[q + 1];
                out[q + 2] = cData[q + 2];
                // luminance of the mask: black = clear, white = solid
                out[q + 3] = Math.round(0.2126 * mData[q] + 0.7152 * mData[q + 1] + 0.0722 * mData[q + 2]);
            }
            var oc = document.createElement('canvas');
            oc.width = W; oc.height = H;
            oc.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
            return new Promise(function (res) {
                oc.toBlob(function (b) { res({ blob: b, ext: '.png' }); }, 'image/png');   // PNG: JPEG drops alpha
            });
        });
    }

    function mergeOpacityTextures() {
        var jobs = [];
        var seen = {};
        window.allmodel.forEach(function (obj, i) {
            var ss = obj.stateset;
            var meshName = obj._name || (ss && ss._name) || ('mesh_' + i);
            var cm = getChannelTextureMap(obj);
            if (!cm.Opacity || !cm.AlbedoPBR) return;
            var san = sanitizeTextureName(meshName);
            if (seen[san]) return;
            seen[san] = true;
            if (normalizeUrl(cm.Opacity.url) === normalizeUrl(cm.AlbedoPBR.url)) {
                log('opacity merge: ' + meshName + ' uses one file for color and opacity, skipped');
                return;
            }
            jobs.push(
                _mergeOneOpacity(cm).then(function (result) {
                    if (!result || !result.blob) return;
                    var fname = san + '_Alpha' + result.ext;
                    objects[fname] = result.blob;
                    saveimagecache2['__merged_op__:' + san] = {
                        name: san + '_Alpha',
                        fileExt: result.ext,
                        dataURL: 'merged'
                    };
                    log('merged opacity:', meshName, '→', fname, result.blob.size + 'B');
                }).catch(function (e) {
                    warn('opacity merge failed for', meshName, e.message);
                })
            );
        });
        return jobs.length ? Promise.all(jobs) : Promise.resolve();
    }

    // ====================================================================
    // Texture readiness
    // ====================================================================
    // Textures are only captured when the viewer draws them, which happens in a
    // burst while the model loads (and lags most). Exporting before that burst
    // ends produces a GLB with missing images. Count what the meshes reference
    // against what has been captured, and wait a little if some are missing.
    function textureReadiness() {
        var seen = {}, expected = 0, missing = 0;
        window.allmodel.forEach(function (obj) {
            var cm = getChannelTextureMap(obj);
            for (var ch in cm) {
                if (!cm.hasOwnProperty(ch) || !cm[ch] || !cm[ch].url) continue;
                var id = _urlTail(cm[ch].url) || normalizeUrl(cm[ch].url);
                if (seen[id]) continue;
                seen[id] = true;
                expected++;
                if (!_blobForUrl(cm[ch].url)) missing++;
            }
        });
        return { expected: expected, missing: missing };
    }

    function waitForTextures() {
        var maxMs = (CONFIG.TEXTURE_WAIT_SECONDS || 0) * 1000;
        var first = textureReadiness();
        if (maxMs <= 0 || first.missing === 0) return Promise.resolve();
        log('textures still loading: ' + (first.expected - first.missing) + '/' + first.expected +
            ' captured, waiting up to ' + CONFIG.TEXTURE_WAIT_SECONDS + 's (keep this tab visible)');
        return new Promise(function (resolve) {
            var start = Date.now(), lastProgressAt = start, lastCaptured = first.expected - first.missing;
            (function poll() {
                setTimeout(function () {
                    var r = textureReadiness(), captured = r.expected - r.missing, now = Date.now();
                    if (captured > lastCaptured) {
                        lastCaptured = captured;
                        lastProgressAt = now;
                        log('textures captured: ' + captured + '/' + r.expected);
                    }
                    if (r.missing === 0) { log('all ' + r.expected + ' textures captured'); resolve(); return; }
                    // Some textures are never drawn (tiny ones are skipped on purpose). Once
                    // some arrived and then nothing new came for 5 s, stop waiting.
                    if (captured > 0 && now - lastProgressAt > 5000) {
                        warn('textures: ' + r.missing + '/' + r.expected + ' never appeared, exporting without them');
                        resolve();
                        return;
                    }
                    if (now - start >= maxMs) {
                        warn('textures: timed out with ' + r.missing + '/' + r.expected + ' missing, exporting without them');
                        resolve();
                        return;
                    }
                    poll();
                }, 500);
            })();
        });
    }

    // ====================================================================
    // GLB Export
    // ====================================================================
    function downloadGLB() {
        log('export started');
        waitForTextures().then(mergeMRTextures).then(mergeOpacityTextures).then(function () {
            _downloadGLBSync();
        }).catch(function (e) {
            err('export failed:', e.message, e.stack);
        });
    }

    function _downloadGLBSync() {
        try {
            function pad(o) { return o % 4 ? o + (4 - o % 4) : o; }

            var allNodes = window.allmodel;
            var nodeMap = new Map();
            var nodes = [];

            allNodes.forEach(function (obj, idx) {
                nodeMap.set(obj, idx);
                var name = obj._name || (obj.stateset && obj.stateset._name) || ('mesh_' + idx);
                var world = computeWorldMatrix(obj);
                nodes.push({ name: name, matrix: world, mesh: undefined, children: [] });
            });

            var meshes = [], accs = [], bvs = [], mats = [];
            var matsChannelInfo = {}; // mi -> { channelName: {url, name} }
            var matsFlat = {};        // mi -> { channelName: {enable, factor, color} } from the material model
            var binChunks = [], off = 0;   // Uint8Array chunks, joined once at the end
            var matHasUV = {};
            var meshHasSkinning = {};
            var morphInfo = {};   // mIdx -> { meshIdx, n } for meshes with morph targets

            function addBV(ta, target) {
                var len = ta.byteLength;
                var al = pad(off), padn = al - off;
                if (padn > 0) { binChunks.push(new Uint8Array(padn)); off += padn; }
                var idx = bvs.length;
                var bv = { buffer: 0, byteOffset: off, byteLength: len };
                if (target) bv.target = target;
                bvs.push(bv);
                var bytes = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
                binChunks.push(bytes);
                off += len;
                return idx;
            }

            allNodes.forEach(function (obj, mIdx) {
                if (!obj._primitives) return;
                var mdl = parseobj(obj);
                if (!mdl.vertex || mdl.vertex.length === 0) return;
                var nm = obj._name || (obj.stateset && obj.stateset._name) || ('mesh_' + mIdx);
                var vc = mdl.vertex.length / 3;

                var posArr = new Float32Array(mdl.vertex);
                var posMin = [Infinity, Infinity, Infinity];
                var posMax = [-Infinity, -Infinity, -Infinity];
                for (var pi = 0; pi < posArr.length; pi += 3) {
                    for (var ci = 0; ci < 3; ci++) {
                        var v = posArr[pi + ci];
                        if (v < posMin[ci]) posMin[ci] = v;
                        if (v > posMax[ci]) posMax[ci] = v;
                    }
                }
                var accPos = accs.length;
                accs.push({ bufferView: addBV(posArr, 34962), componentType: 5126,
                            count: vc, type: 'VEC3', min: posMin, max: posMax });

                var aN = -1, aU = -1, aI = -1, aJ = -1, aW = -1;
                if (mdl.normal.length) {
                    aN = accs.length;
                    accs.push({ bufferView: addBV(new Float32Array(mdl.normal), 34962),
                                componentType: 5126, count: vc, type: 'VEC3' });
                }
                if (mdl.uv.length) {
                    // glTF uses top-left UV origin; Sketchfab's osgjs uses
                    // bottom-left. Flip V (index 1 of each pair) so the
                    // texture lands right-side up. Keep this export-local:
                    // if we later add an FBX path, FBX may not want it.
                    var uvArr = new Float32Array(mdl.uv);
                    for (var uvi = 1; uvi < uvArr.length; uvi += 2) {
                        uvArr[uvi] = 1 - uvArr[uvi];
                    }
                    aU = accs.length;
                    accs.push({ bufferView: addBV(uvArr, 34962),
                                componentType: 5126, count: vc, type: 'VEC2' });
                    matHasUV[nm] = true;
                }
                // Vertex colors (Sketchfab "Color" attribute). Uint8 RGBA is written as a
                // normalized UNSIGNED_BYTE VEC4; float RGBA as FLOAT VEC4; RGB is widened
                // to float VEC3 (3-byte ubyte elements are not 4-byte aligned in glTF).
                var aC = -1, colArr = mdl.color;
                if (colArr && colArr.length) {
                    var isU8 = (colArr instanceof Uint8Array || colArr instanceof Uint8ClampedArray);
                    var conv = !!CONFIG.VERTEX_COLOR_SRGB;
                    var cStride = (colArr.length === vc * 4) ? 4 : ((colArr.length === vc * 3) ? 3 : 0);
                    if (cStride && !conv && cStride === 4) {
                        aC = accs.length;
                        if (isU8) {
                            accs.push({ bufferView: addBV(new Uint8Array(colArr), 34962), componentType: 5121,
                                        normalized: true, count: vc, type: 'VEC4' });
                        } else {
                            accs.push({ bufferView: addBV(new Float32Array(colArr), 34962), componentType: 5126,
                                        count: vc, type: 'VEC4' });
                        }
                        log('vertex colors:', nm, isU8 ? '(RGBA8)' : '(RGBA float)');
                    } else if (cStride) {
                        // Float output (RGB widened since 3-byte ubyte elements are not 4-byte
                        // aligned). With VERTEX_COLOR_SRGB the RGB channels go sRGB -> linear.
                        var cf = new Float32Array(colArr.length);
                        for (var cfi = 0; cfi < cf.length; cfi++) {
                            var cv = isU8 ? colArr[cfi] / 255 : colArr[cfi];
                            if (conv && (cStride === 3 || cfi % 4 !== 3)) {
                                cv = (cv <= 0.04045) ? cv / 12.92 : Math.pow((cv + 0.055) / 1.055, 2.4);
                            }
                            cf[cfi] = cv;
                        }
                        aC = accs.length;
                        accs.push({ bufferView: addBV(cf, 34962), componentType: 5126, count: vc, type: cStride === 4 ? 'VEC4' : 'VEC3' });
                        log('vertex colors:', nm, cStride === 4 ? '(RGBA)' : '(RGB)', conv ? 'sRGB->linear' : 'as is');
                    } else {
                        warn('vertex colors: unexpected length', colArr.length, 'for', vc, 'vertices on', nm, ', skipped');
                    }
                }
                if (mdl.primitives.length > 0 && mdl.primitives[0].indices) {
                    var ind = mdl.primitives[0].indices, mx = 0;
                    for (var k = 0; k < ind.length; k++) if (ind[k] > mx) mx = ind[k];
                    var idxD = mx <= 65535 ? new Uint16Array(ind) : new Uint32Array(ind);
                    aI = accs.length;
                    accs.push({ bufferView: addBV(idxD, 34963),
                                componentType: idxD instanceof Uint32Array ? 5125 : 5123,
                                count: ind.length, type: 'SCALAR' });
                }

                var expected = vc * 4;
                if (mdl.joints && mdl.weights &&
                    mdl.joints.length === expected && mdl.weights.length === expected) {
                    var mj = 0;
                    for (var jj = 0; jj < mdl.joints.length; jj++) if (mdl.joints[jj] > mj) mj = mdl.joints[jj];
                    var jD = mj <= 255 ? new Uint8Array(mdl.joints) : new Uint16Array(mdl.joints);
                    aJ = accs.length;
                    accs.push({ bufferView: addBV(jD, 34962),
                                componentType: mj <= 255 ? 5121 : 5123,
                                count: vc, type: 'VEC4' });
                    aW = accs.length;
                    accs.push({ bufferView: addBV(new Float32Array(mdl.weights), 34962),
                                componentType: 5126, count: vc, type: 'VEC4' });
                    meshHasSkinning[mIdx] = mj + 1;
                    log('skinned mesh:', nm, 'jointsMax=' + mj);
                }

                // Morph targets. The viewer blends  (1 - sum w) * base + sum w_k * target_k  with
                // absolute targets, which equals glTF's  base + sum w_k * (target_k - base).
                var morphTargets = [], mAttr = obj._attributes || {};
                function morphEls(a) {
                    var b = a && (a._initialBufferArray || a._bufferArray);
                    return (b && b._elements) || (a && a._elements) || null;
                }
                for (var mk = 0, mN = morphTargetCount(obj); mk < mN; mk++) {
                    var tv = morphEls(mAttr['Vertex_' + mk]);
                    if (!tv || tv.length !== mdl.vertex.length) {
                        warn('morph target', mk, 'of', nm, 'skipped (vertex data missing or wrong size)');
                        continue;
                    }
                    var dv = new Float32Array(tv.length), dMin = [Infinity, Infinity, Infinity], dMax = [-Infinity, -Infinity, -Infinity];
                    for (var di = 0; di < tv.length; di++) {
                        var dd = tv[di] - mdl.vertex[di];
                        dv[di] = dd;
                        var dax = di % 3;
                        if (dd < dMin[dax]) dMin[dax] = dd;
                        if (dd > dMax[dax]) dMax[dax] = dd;
                    }
                    var tgt = { POSITION: accs.length };
                    accs.push({ bufferView: addBV(dv, 34962), componentType: 5126, count: vc,
                                type: 'VEC3', min: dMin, max: dMax });
                    var tn = morphEls(mAttr['Normal_' + mk]);
                    if (tn && mdl.normal.length && tn.length === mdl.normal.length) {
                        var dn = new Float32Array(tn.length);
                        for (var dni = 0; dni < tn.length; dni++) dn[dni] = tn[dni] - mdl.normal[dni];
                        tgt.NORMAL = accs.length;
                        accs.push({ bufferView: addBV(dn, 34962), componentType: 5126, count: vc, type: 'VEC3' });
                    }
                    morphTargets.push(tgt);
                }
                if (morphTargets.length) log('morph targets:', nm, morphTargets.length);

                var primMode = (mdl.primitives.length > 0 && mdl.primitives[0].mode) ? mdl.primitives[0].mode : 4;
                var prim = { attributes: { POSITION: accPos }, mode: primMode };
                if (aN >= 0) prim.attributes.NORMAL = aN;
                if (aU >= 0) prim.attributes.TEXCOORD_0 = aU;
                if (aC >= 0) prim.attributes.COLOR_0 = aC;
                if (aJ >= 0) prim.attributes.JOINTS_0 = aJ;
                if (aW >= 0) prim.attributes.WEIGHTS_0 = aW;
                if (aI >= 0) prim.indices = aI;
                if (morphTargets.length) prim.targets = morphTargets;

                var mi = -1;
                for (var q = 0; q < mats.length; q++) if (mats[q].name === nm) { mi = q; break; }
                if (mi === -1) {
                    mi = mats.length;
                    mats.push({ name: nm, pbrMetallicRoughness: {
                        baseColorFactor: [1,1,1,1], metallicFactor: 1, roughnessFactor: 1 } });
                    matsChannelInfo[mi] = getChannelTextureMap(obj);
                    matsFlat[mi] = getMaterialChannels(obj);
                }
                prim.material = mi;

                var mshIdx = meshes.length;
                if (morphTargets.length) morphInfo[mIdx] = { meshIdx: meshes.length, n: morphTargets.length };
                meshes.push({ name: nm, primitives: [prim] });
                var ni = nodeMap.get(obj);
                if (ni !== undefined) nodes[ni].mesh = mshIdx;
            });

            var images = [], textures = [];
            var textureUrlToIndex  = {};
            var textureNameToIndex = {};
            for (var key in saveimagecache2) {
                if (!saveimagecache2.hasOwnProperty(key)) continue;
                var t = saveimagecache2[key];
                if (!t || !t.dataURL) continue;
                var ext = t.fileExt || '.png';
                var path = 'textures/' + (t.name || 'texture') + ext;
                var ii = images.length;
                images.push({ uri: path });
                textures.push({ source: ii });
                var nu = normalizeUrl(key);
                if (nu) textureUrlToIndex[nu] = ii;
                var sn = sanitizeTextureName(t.name);
                if (sn) textureNameToIndex[sn] = ii;
            }

            function findTexIdx(info) {
                if (!info) return undefined;
                var u = normalizeUrl(info.url);
                if (u && textureUrlToIndex[u] !== undefined) return textureUrlToIndex[u];
                var n = sanitizeTextureName(info.name);
                if (n && textureNameToIndex[n] !== undefined) return textureNameToIndex[n];
                return undefined;
            }

            if (textures.length) {
                mats.forEach(function (m, mi) {
                    if (!matHasUV[m.name]) return;
                    var chan = matsChannelInfo[mi] || {};
                    var assigned = false;

                    var albedo = chan.AlbedoPBR || chan.DiffusePBR || chan.BaseColorPBR;
                    var ai = findTexIdx(albedo);
                    if (ai !== undefined) {
                        m.pbrMetallicRoughness.baseColorTexture = { index: ai };
                        assigned = true;
                    }

                    var nrm = chan.NormalMap || chan.NormalPBR;
                    var ni = findTexIdx(nrm);
                    if (ni !== undefined) {
                        m.normalTexture = { index: ni };
                        assigned = true;
                    }

                    var ao = chan.AOPBR || chan.OcclusionPBR;
                    var oi = findTexIdx(ao);
                    if (oi !== undefined) {
                        m.occlusionTexture = { index: oi };
                        assigned = true;
                    }

                    var em = chan.EmissivePBR || chan.EmissionPBR || chan.EmitColor;
                    var ei = findTexIdx(em);
                    if (ei !== undefined) {
                        m.emissiveTexture = { index: ei };
                        assigned = true;
                    }

                    // Merged MR (see mergeMRTextures): registered in the
                    // pool under name "<sanitized mesh name>_MR".
                    var mrName = sanitizeTextureName(m.name) + '_MR';
                    var mrIdx = textureNameToIndex[mrName];
                    if (mrIdx !== undefined) {
                        m.pbrMetallicRoughness.metallicRoughnessTexture = { index: mrIdx };
                        assigned = true;
                    }

                    // Merged opacity (see mergeOpacityTextures): the RGBA texture
                    // replaces the plain base color and the material blends.
                    var alphaIdx = textureNameToIndex[sanitizeTextureName(m.name) + '_Alpha'];
                    if (alphaIdx !== undefined) {
                        m.pbrMetallicRoughness.baseColorTexture = { index: alphaIdx };
                        m.alphaMode = 'BLEND';
                        assigned = true;
                        log('material ' + m.name + ': alphaMode BLEND with merged opacity texture');
                    }

                    if (!assigned) {
                        // fallback: keep old behaviour so nothing regresses
                        m.pbrMetallicRoughness.baseColorTexture = { index: 0 };
                    }
                });
            }

            // Flat material values for channels without a texture (texture-less models): base
            // color, metalness, roughness, emission. Textured channels keep factor 1 so the
            // texture alone decides, as before.
            mats.forEach(function (m, mi) {
                var flat = matsFlat[mi], chan = matsChannelInfo[mi] || {}, pbr = m.pbrMetallicRoughness;
                if (!flat) return;
                var did = [];
                var alb = flat.AlbedoPBR;
                if (alb && alb.enable && alb.color && !pbr.baseColorTexture && !(chan.AlbedoPBR || chan.DiffusePBR)) {
                    var af = (typeof alb.factor === 'number') ? alb.factor : 1;
                    pbr.baseColorFactor = [alb.color[0] * af, alb.color[1] * af, alb.color[2] * af, 1];
                    did.push('base color');
                }
                var mt = flat.MetalnessPBR, rg = flat.RoughnessPBR;
                if (!pbr.metallicRoughnessTexture) {
                    if (mt && mt.enable && typeof mt.factor === 'number' && !chan.MetalnessPBR) {
                        pbr.metallicFactor = mt.factor; did.push('metalness');
                    }
                    if (rg && rg.enable && typeof rg.factor === 'number' && !chan.RoughnessPBR) {
                        pbr.roughnessFactor = rg.factor; did.push('roughness');
                    }
                }
                var em = flat.EmitColor;
                if (em && em.enable && em.color && !m.emissiveTexture && !chan.EmitColor) {
                    var ef = (typeof em.factor === 'number') ? em.factor : 1;
                    var ev = [em.color[0] * ef, em.color[1] * ef, em.color[2] * ef];
                    if (ev[0] > 0 || ev[1] > 0 || ev[2] > 0) { m.emissiveFactor = ev; did.push('emission'); }
                }
                if (did.length) log('material ' + m.name + ': flat values from material model (' + did.join(', ') + ')');
            });

            // Sketchfab can render a model two-sided (Inspector: Single Sided OFF), which glTF
            // expresses per material. We cannot read that setting yet, so it is a manual option.
            if (CONFIG.DOUBLE_SIDED) {
                mats.forEach(function (m) { m.doubleSided = true; });
                log('materials marked doubleSided: ' + mats.length);
            }

            // ---- animation clips (multi-clip aware) ----
            var mlA = document.getElementsByClassName('model-name__label')[0];
            var animBase = mlA ? mlA.textContent.trim().replace(/\.+$/, '') : 'model';
            var clipSets = [];
            if (window.clips && window.clips.length > 1) {
                window.clips.forEach(function (c) {
                    if (c && c.frames && c.frames.length > 1) {
                        clipSets.push({ name: c.name, frames: c.frames });
                    }
                });
            }
            if (clipSets.length > 1) {
                log('export: multi-clip mode, clips=' + clipSets.length);
            } else {
                // single-clip path: same data source and behaviour as before
                clipSets = (window.recordedFrames.length > 1)
                    ? [{ name: animBase + '_anim', frames: window.recordedFrames }] : [];
            }
            var hasFrames = clipSets.length > 0;
            var liveSnap = hasFrames ? null : snapshotFrame().meshes;
            var gltfSkins = [];
            var animations;

            // One time accessor + sampler/channel lists per clip.
            var tracks = clipSets.map(function (cs) {
                // Start every clip at exactly t = 0 (the single-clip recorder's first frame
                // lands ~16 ms after the start). Store float32-rounded values so the
                // accessor min/max match the buffer exactly.
                var tFirst = cs.frames[0].time;
                var times = cs.frames.map(function (f) { return Math.fround(f.time - tFirst); });
                var tV = addBV(new Float32Array(times));
                var tAcc = accs.length;
                accs.push({ bufferView: tV, componentType: 5126, count: times.length,
                            type: 'SCALAR', min: [times[0]], max: [times[times.length - 1]] });
                return { name: cs.name, frames: cs.frames, times: times, timeAcc: tAcc,
                         samplers: [], channels: [] };
            });

            function expandMat3x4(pal, boneIdx) {
                var b = boneIdx * 12;
                return [
                    pal[b + 0], pal[b + 4], pal[b + 8], 0,
                    pal[b + 1], pal[b + 5], pal[b + 9], 0,
                    pal[b + 2], pal[b + 6], pal[b + 10], 0,
                    pal[b + 3], pal[b + 7], pal[b + 11], 1
                ];
            }

            var staticWarned = false;
            allNodes.forEach(function (obj, mIdx) {
                if (!meshHasSkinning[mIdx]) return;

                var meshNodeIdx = nodeMap.get(obj);
                if (meshNodeIdx === undefined) return;

                var jointCount = meshHasSkinning[mIdx];
                var paletteRef = null;
                if (hasFrames) {
                    var refFrames = tracks[0].frames;
                    for (var fi = 0; fi < refFrames.length; fi++) {
                        var fm = refFrames[fi].meshes[mIdx];
                        if (fm && fm.palette) {
                            var fromPal = (fm.palette.length / 12) | 0;
                            if (fromPal > jointCount) jointCount = fromPal;
                            paletteRef = fm;
                            break;
                        }
                    }
                }

                var W_mesh = computeWorldMatrix(obj);

                var skelRootIdx = nodes.length;
                nodes.push({ name: 'skel_root_' + mIdx, matrix: W_mesh, children: [] });

                var jointNodeIndices = [];
                for (var ji = 0; ji < jointCount; ji++) {
                    var jIdx = nodes.length;
                    nodes.push({ name: 'joint_' + mIdx + '_' + ji, children: [] });
                    nodes[skelRootIdx].children.push(jIdx);
                    jointNodeIndices.push(jIdx);
                }

                var ibmFlat = new Float32Array(jointCount * 16);
                for (var pi2 = 0; pi2 < jointCount; pi2++) {
                    ibmFlat[pi2 * 16 + 0]  = 1;
                    ibmFlat[pi2 * 16 + 5]  = 1;
                    ibmFlat[pi2 * 16 + 10] = 1;
                    ibmFlat[pi2 * 16 + 15] = 1;
                }
                var ibmV = addBV(ibmFlat);
                var ibmA = accs.length;
                accs.push({ bufferView: ibmV, componentType: 5126,
                            count: jointCount, type: 'MAT4' });

                var skinIdx = gltfSkins.length;
                gltfSkins.push({
                    inverseBindMatrices: ibmA,
                    joints: jointNodeIndices,
                    skeleton: skelRootIdx
                });

                nodes[meshNodeIdx].skin = skinIdx;
                delete nodes[meshNodeIdx].matrix;

                if (hasFrames && paletteRef) {
                    var animatedCount = 0;
                    var animatedJoints = {};
                    for (var jn = 0; jn < jointCount; jn++) {
                        // Per-clip motion test: does this joint's TRS vary across
                        // each clip's own frames? Only clips where it varies get
                        // channels. This lets separate clips compose in Blender's
                        // NLA without fighting each other.
                        var clipHasMotion = [];
                        var anyMotion = false;
                        for (var cj = 0; cj < tracks.length; cj++) {
                            var frC = tracks[cj].frames;
                            var prev = null, movedHere = false;   // prev = the clip's FIRST frame
                            for (var fj = 0; fj < frC.length && !movedHere; fj++) {
                                var fmeshJ = frC[fj].meshes[mIdx];
                                var palJ = fmeshJ && fmeshJ.palette;
                                var mJ = (palJ && palJ.length >= (jn + 1) * 12)
                                       ? expandMat3x4(palJ, jn) : identityMat4();
                                if (prev !== null) {
                                    for (var vv = 0; vv < 16; vv++) {
                                        if (Math.abs(mJ[vv] - prev[vv]) > 1e-5 * Math.max(1, Math.abs(prev[vv]))) { movedHere = true; break; }
                                    }
                                }
                                if (prev === null) prev = mJ;   // slow drift is caught: always compare to frame 0
                            }
                            clipHasMotion[cj] = movedHere;
                            if (movedHere) anyMotion = true;
                        }
                        if (!anyMotion) continue;
                        animatedCount++;
                        var nIdx = jointNodeIndices[jn];
                        animatedJoints[nIdx] = true;

                        for (var ci = 0; ci < tracks.length; ci++) {
                            if (!clipHasMotion[ci]) continue;   // only clips where it moved
                            var tr = tracks[ci];
                            var T = [], R = [], S = [];
                            var prevQ = null;   // hemisphere fix resets per clip, per joint
                            for (var fi3 = 0; fi3 < tr.frames.length; fi3++) {
                                var fmesh = tr.frames[fi3].meshes[mIdx];
                                var pal = fmesh && fmesh.palette;
                                var mPal = (pal && pal.length >= (jn + 1) * 12)
                                         ? expandMat3x4(pal, jn) : identityMat4();
                                var d = decomposeMat4(mPal);
                                if (prevQ) {
                                    var dot = d.rotation[0]*prevQ[0] + d.rotation[1]*prevQ[1]
                                            + d.rotation[2]*prevQ[2] + d.rotation[3]*prevQ[3];
                                    if (dot < 0) {
                                        d.rotation[0] = -d.rotation[0];
                                        d.rotation[1] = -d.rotation[1];
                                        d.rotation[2] = -d.rotation[2];
                                        d.rotation[3] = -d.rotation[3];
                                    }
                                }
                                prevQ = d.rotation.slice();
                                T.push(d.translation[0], d.translation[1], d.translation[2]);
                                R.push(d.rotation[0], d.rotation[1], d.rotation[2], d.rotation[3]);
                                S.push(d.scale[0], d.scale[1], d.scale[2]);
                            }

                            var aT = accs.length;
                            accs.push({ bufferView: addBV(new Float32Array(T)), componentType: 5126,
                                        count: tr.times.length, type: 'VEC3' });
                            tr.samplers.push({ input: tr.timeAcc, interpolation: 'LINEAR', output: aT });
                            tr.channels.push({ sampler: tr.samplers.length - 1,
                                               target: { node: nIdx, path: 'translation' } });

                            var aR = accs.length;
                            accs.push({ bufferView: addBV(new Float32Array(R)), componentType: 5126,
                                        count: tr.times.length, type: 'VEC4' });
                            tr.samplers.push({ input: tr.timeAcc, interpolation: 'LINEAR', output: aR });
                            tr.channels.push({ sampler: tr.samplers.length - 1,
                                               target: { node: nIdx, path: 'rotation' } });

                            var aS = accs.length;
                            accs.push({ bufferView: addBV(new Float32Array(S)), componentType: 5126,
                                        count: tr.times.length, type: 'VEC3' });
                            tr.samplers.push({ input: tr.timeAcc, interpolation: 'LINEAR', output: aS });
                            tr.channels.push({ sampler: tr.samplers.length - 1,
                                               target: { node: nIdx, path: 'scale' } });
                        }
                    }

                    // Give every joint its rest-pose TRS as the node default.
                    // Animation channels override this where present. Without
                    // it, a joint that has animation would collapse to identity
                    // (origin) when no animation is playing.
                    // Rest pose source: the first frame of the first clip, or the viewer's
                    // Static Pose snapshot (REST_POSE_SOURCE). Static falls back to the clip
                    // frame when no usable snapshot exists (e.g. single-clip RECORD).
                    var restPal = paletteRef.palette;
                    var sm = window.staticPoseSnapshot && window.staticPoseSnapshot.meshes[mIdx];
                    var staticOk = !!(sm && sm.palette && sm.palette.length >= paletteRef.palette.length);
                    if (staticOk) {
                        var diffJ = 0;
                        for (var dj = 0; dj < jointCount; dj++) {
                            for (var dk = 0; dk < 12; dk++) {
                                var di = dj * 12 + dk;
                                if (di >= paletteRef.palette.length) break;
                                if (Math.abs(sm.palette[di] - paletteRef.palette[di]) > 1e-4) { diffJ++; break; }
                            }
                        }
                        log('rest pose: mesh ' + mIdx + ' Static Pose vs clip frame 0 differ on ' +
                            diffJ + '/' + jointCount + ' joints');
                    }
                    if (CONFIG.REST_POSE_SOURCE === 'static') {
                        if (staticOk) restPal = sm.palette;
                        else if (!staticWarned) {
                            staticWarned = true;   // once per export, not once per mesh
                            warn('rest pose: Static Pose snapshot unavailable (run RECORD ALL CLIPS first); using clip frame 0');
                        }
                    }
                    log('rest pose source: ' + (restPal === paletteRef.palette ? 'clip frame 0' : 'Static Pose') +
                        ' (mesh ' + mIdx + ')');
                    var restSkipped = 0;
                    for (var sj = 0; sj < jointCount; sj++) {
                        var jnIdx = jointNodeIndices[sj];
                        if ((sj + 1) * 12 > restPal.length || jnIdx === undefined) {
                            restSkipped++;   // palette shorter than the joint list: leave node default
                            continue;
                        }
                        var pal0 = expandMat3x4(restPal, sj);
                        var d0 = decomposeMat4(pal0);
                        nodes[jnIdx].translation = d0.translation;
                        nodes[jnIdx].rotation = d0.rotation;
                        nodes[jnIdx].scale = d0.scale;
                    }

                    if (restSkipped) warn('skin', skinIdx, ': rest pose skipped for', restSkipped, 'joint(s), palette too short');
                    log('skin', skinIdx, 'for mesh', meshes[nodes[meshNodeIdx].mesh].name,
                        '→', jointCount, 'joints,', animatedCount, 'animated,',
                        tracks.length, 'clip(s)');
                } else {
                    var live = liveSnap && liveSnap[mIdx];
                    if (live && live.palette) {
                        for (var sj2 = 0; sj2 < jointCount; sj2++) {
                            if ((sj2 + 1) * 12 > live.palette.length) break;
                            var dl = decomposeMat4(expandMat3x4(live.palette, sj2));
                            var jn2 = jointNodeIndices[sj2];
                            nodes[jn2].translation = dl.translation;
                            nodes[jn2].rotation = dl.rotation;
                            nodes[jn2].scale = dl.scale;
                        }
                    }
                    log('skin', skinIdx, 'static from live palette, joints:', jointCount);
                }
            });

            // ---- animation of UNSKINNED meshes: node motion and morph weights ----
            // Skinned meshes animate through their palette (above). A mesh that has no
            // skin can still move (its node chain is animated) and/or morph (weights).
            function emitNodeTRS(tr, nIdx, matAt) {
                var T = [], R = [], S = [], prevQ = null;
                for (var fi4 = 0; fi4 < tr.frames.length; fi4++) {
                    var d4 = decomposeMat4(matAt(fi4));
                    if (prevQ) {
                        var dot4 = d4.rotation[0]*prevQ[0] + d4.rotation[1]*prevQ[1]
                                 + d4.rotation[2]*prevQ[2] + d4.rotation[3]*prevQ[3];
                        if (dot4 < 0) {
                            d4.rotation[0] = -d4.rotation[0]; d4.rotation[1] = -d4.rotation[1];
                            d4.rotation[2] = -d4.rotation[2]; d4.rotation[3] = -d4.rotation[3];
                        }
                    }
                    prevQ = d4.rotation.slice();
                    T.push(d4.translation[0], d4.translation[1], d4.translation[2]);
                    R.push(d4.rotation[0], d4.rotation[1], d4.rotation[2], d4.rotation[3]);
                    S.push(d4.scale[0], d4.scale[1], d4.scale[2]);
                }
                var paths = [['translation', T, 'VEC3'], ['rotation', R, 'VEC4'], ['scale', S, 'VEC3']];
                paths.forEach(function (pp) {
                    var aX = accs.length;
                    accs.push({ bufferView: addBV(new Float32Array(pp[1])), componentType: 5126,
                                count: tr.times.length, type: pp[2] });
                    tr.samplers.push({ input: tr.timeAcc, interpolation: 'LINEAR', output: aX });
                    tr.channels.push({ sampler: tr.samplers.length - 1, target: { node: nIdx, path: pp[0] } });
                });
            }

            if (hasFrames) {
                allNodes.forEach(function (obj, mIdx) {
                    var nodeIdx = nodeMap.get(obj);
                    if (nodeIdx === undefined || nodes[nodeIdx].mesh === undefined) return;

                    // node motion: the recorded world matrix changes within a clip
                    if (!meshHasSkinning[mIdx]) {
                        var moves = [], anyMove = false;
                        tracks.forEach(function (trk, ti) {
                            var f0 = trk.frames[0].meshes[mIdx], w0 = f0 && f0.world, moved = false;
                            for (var fm2 = 1; w0 && fm2 < trk.frames.length && !moved; fm2++) {
                                var fw = trk.frames[fm2].meshes[mIdx], wn = fw && fw.world;
                                if (!wn) continue;
                                for (var wv = 0; wv < 16; wv++) {
                                    if (Math.abs(wn[wv] - w0[wv]) > 1e-5 * Math.max(1, Math.abs(w0[wv]))) { moved = true; break; }
                                }
                            }
                            moves[ti] = moved;
                            if (moved) anyMove = true;
                        });
                        if (anyMove) {
                            var rest0 = tracks[0].frames[0].meshes[mIdx].world;
                            var dRest = decomposeMat4(rest0);
                            delete nodes[nodeIdx].matrix;
                            nodes[nodeIdx].translation = dRest.translation;
                            nodes[nodeIdx].rotation = dRest.rotation;
                            nodes[nodeIdx].scale = dRest.scale;
                            tracks.forEach(function (trk, ti) {
                                if (!moves[ti]) return;
                                emitNodeTRS(trk, nodeIdx, function (f) {
                                    var fx = trk.frames[f].meshes[mIdx];
                                    return (fx && fx.world) || rest0;
                                });
                            });
                            log('node animation: ' + nodes[nodeIdx].name + ' moves in ' +
                                moves.filter(function (x) { return x; }).length + ' clip(s)');
                        }
                    }

                    // morph weights
                    var mi2 = morphInfo[mIdx];
                    if (mi2) {
                        var wRest = tracks[0].frames[0].meshes[mIdx];
                        var wr = (wRest && wRest.weights) || null;
                        if (wr) {
                            var restW = [];
                            for (var rw = 0; rw < mi2.n; rw++) restW.push(wr[rw] || 0);
                            meshes[mi2.meshIdx].weights = restW;
                        }
                        tracks.forEach(function (trk) {
                            var base = trk.frames[0].meshes[mIdx], bw = base && base.weights, varies = false;
                            if (!bw) return;
                            for (var fw2 = 1; fw2 < trk.frames.length && !varies; fw2++) {
                                var ww = trk.frames[fw2].meshes[mIdx];
                                var wv2 = ww && ww.weights;
                                if (!wv2) continue;
                                for (var kk = 0; kk < mi2.n; kk++) {
                                    if (Math.abs((wv2[kk] || 0) - (bw[kk] || 0)) > 1e-4) { varies = true; break; }
                                }
                            }
                            if (!varies) return;
                            var out = new Float32Array(trk.frames.length * mi2.n);
                            for (var fw3 = 0; fw3 < trk.frames.length; fw3++) {
                                var wm = trk.frames[fw3].meshes[mIdx], wa = (wm && wm.weights) || bw;
                                for (var kw = 0; kw < mi2.n; kw++) out[fw3 * mi2.n + kw] = wa[kw] || 0;
                            }
                            var aWt = accs.length;
                            accs.push({ bufferView: addBV(out), componentType: 5126,
                                        count: out.length, type: 'SCALAR' });
                            trk.samplers.push({ input: trk.timeAcc, interpolation: 'LINEAR', output: aWt });
                            trk.channels.push({ sampler: trk.samplers.length - 1,
                                                target: { node: nodeIdx, path: 'weights' } });
                            log('morph animation: ' + nodes[nodeIdx].name + ' (' + mi2.n + ' target(s))');
                        });
                    }
                });
            }

            if (tracks.length) {
                var animList = [];
                tracks.forEach(function (tr) {
                    if (tr.channels.length) {
                        animList.push({ name: tr.name, samplers: tr.samplers, channels: tr.channels });
                        log('animation "' + tr.name + '": ' + tr.channels.length + ' channels, '
                            + tr.times.length + ' frames');
                    }
                });
                if (animList.length) animations = animList;
            }

            // Scene root with YUP
            var sceneRootIdx = nodes.length;
            nodes.push({ name: 'scene_root', matrix: YUP.slice(), children: [] });

            var naturalRoots = [];
            nodes.forEach(function (n, i) {
                if (i === sceneRootIdx) return;
                var hasP = false;
                for (var j = 0; j < nodes.length; j++) {
                    if (nodes[j].children && nodes[j].children.indexOf(i) !== -1) { hasP = true; break; }
                }
                if (!hasP) naturalRoots.push(i);
            });
            naturalRoots.forEach(function (r) {
                nodes[sceneRootIdx].children.push(r);
            });

            var rootNodes = [sceneRootIdx];
            nodes.forEach(function (n) {
                if (n.children && n.children.length === 0) delete n.children;
            });

            var gltf = {
                asset: { version: '2.0' },
                scene: 0,
                scenes: [{ nodes: rootNodes }],
                nodes: nodes,
                meshes: meshes,
                accessors: accs,
                bufferViews: bvs,
                materials: mats,
                buffers: [{ byteLength: off }]
            };
            // glTF forbids empty arrays (validator: EMPTY_ENTITY), so texture-less models omit these.
            if (images.length) gltf.images = images;
            if (textures.length) gltf.textures = textures;
            if (gltfSkins.length) gltf.skins = gltfSkins;
            if (animations) gltf.animations = animations;

            log('built scene: nodes=' + nodes.length,
                'meshes=' + meshes.length,
                'skins=' + gltfSkins.length,
                'animClips=' + (animations ? animations.length : 0),
                'animFrames=' + (animations ? tracks[0].times.length : 0));

            var jsonStr = JSON.stringify(gltf);
            var jsonBytes = new TextEncoder().encode(jsonStr);
            var jAl = pad(jsonBytes.byteLength), jPad = jAl - jsonBytes.byteLength;
            var binAll = new Uint8Array(off), binPos = 0;
            for (var bc = 0; bc < binChunks.length; bc++) {
                binAll.set(binChunks[bc], binPos);
                binPos += binChunks[bc].length;
            }
            var bin = binAll.buffer;
            var bAl = pad(bin.byteLength), bPad = bAl - bin.byteLength;
            var total = 12 + 8 + jAl + 8 + bAl;

            var glb = new ArrayBuffer(total);
            var dv = new DataView(glb), o = 0;
            dv.setUint32(o, 0x46546C67, true); o += 4;
            dv.setUint32(o, 2, true); o += 4;
            dv.setUint32(o, total, true); o += 4;
            dv.setUint32(o, jAl, true); o += 4;
            dv.setUint32(o, 0x4E4F534A, true); o += 4;
            new Uint8Array(glb, o, jsonBytes.length).set(jsonBytes); o += jsonBytes.length;
            for (var k1 = 0; k1 < jPad; k1++) new Uint8Array(glb, o + k1, 1)[0] = 0x20;
            o += jPad;
            dv.setUint32(o, bAl, true); o += 4;
            dv.setUint32(o, 0x004E4942, true); o += 4;
            new Uint8Array(glb, o, bin.byteLength).set(new Uint8Array(bin)); o += bin.byteLength;
            for (var k2 = 0; k2 < bPad; k2++) new Uint8Array(glb, o + k2, 1)[0] = 0;

            var ml2 = document.getElementsByClassName('model-name__label')[0];
            var modelName = ml2 ? ml2.textContent.trim().replace(/\.+$/, '') : 'model';

            var zip = new JSZip();
            zip.file(modelName + '.glb', new Blob([glb], { type: 'application/octet-stream' }));
            for (var tn in objects) {
                if (objects.hasOwnProperty(tn) && objects[tn]) {
                    zip.file('textures/' + tn, objects[tn]);
                }
            }
            zip.generateAsync({ type: 'blob' }).then(function (content) {
                saveAs(content, modelName + '.zip');
                log('export done:', modelName + '.zip');
            });
        } catch (e) {
            err('export failed:', e.message, e.stack);
        }
    }

    // ====================================================================
    // Script interceptor
    // ====================================================================
    (function installInterceptor() {
        var Ev = function (s, t) {
            this.script = s; this.target = t;
            this._cancel = false; this._replace = null; this._stop = false;
        };
        Ev.prototype.preventDefault = function () { this._cancel = true; };
        Ev.prototype.stopPropagation = function () { this._stop = true; };
        Ev.prototype.replacePayload = function (p) { this._replace = p; };

        var cbs = [];
        window.addBeforeScriptExecuteListener = function (f) {
            if (typeof f !== 'function') throw new Error('callback must be function');
            cbs.push(f);
        };
        window.removeBeforeScriptExecuteListener = function (f) {
            var i = cbs.length; while (i--) if (cbs[i] === f) cbs.splice(i, 1);
        };

        function dispatch(script, target) {
            if (!script || script.tagName !== 'SCRIPT') return;
            var e = new Ev(script, target);
            if (typeof window.onbeforescriptexecute === 'function') {
                try { window.onbeforescriptexecute(e); } catch (err) { console.error(err); }
            }
            for (var i = 0; i < cbs.length; i++) {
                if (e._stop) break;
                try { cbs[i](e); } catch (err) { console.error(err); }
            }
            if (e._cancel) { script.textContent = ''; script.remove(); }
            else if (typeof e._replace === 'string') { script.textContent = e._replace; }
        }

        var obs = new MutationObserver(function (ms) {
            for (var i = 0; i < ms.length; i++) {
                var m = ms[i];
                var an = m.addedNodes;
                for (var j = 0; j < an.length; j++) {
                    var n = an[j];
                    if (n && n.tagName === 'SCRIPT') dispatch(n, m.target);
                }
            }
        });
        obs.observe(window.document, { childList: true, subtree: true });
    })();

    var RE = {
        renderInto1      : /A\.renderInto\(n,E,R/g,
        renderInto2      : /g\.renderInto=function\(e,i,r/g,
        drawArrays       : /t\.drawArrays\(t\.TRIANGLES,0,6\)/g,
        getResourceImage : /getResourceImage:function\(e,t\){/g,
        drawGeometry     : /(this\._stateCache\.drawGeometry\(this\._graphicContext,t\))/g,
    };

    window.onbeforescriptexecute = function (e) {
        Array.from(e.target.childNodes).forEach(function (node) {
            if (!node || node.tagName !== 'SCRIPT') return;
            var src = node.src || '';
            if (src.indexOf('web/dist/') < 0 && src.indexOf('standaloneViewer') < 0) return;

            e.preventDefault();
            e.stopPropagation();

            var req = new XMLHttpRequest();
            req.open('GET', src, false);
            req.send('');
            var js = req.responseText;
            var ret, applied = [];

            if ((ret = RE.renderInto1.exec(js))) {
                js = js.slice(0, ret.index + ret[0].length) + ',i' + js.slice(ret.index + ret[0].length);
                applied.push('patch_0');
            }
            if ((ret = RE.renderInto2.exec(js))) {
                js = js.slice(0, ret.index + ret[0].length) + ',image_data' + js.slice(ret.index + ret[0].length);
                applied.push('patch_1');
            }
            if ((ret = RE.drawArrays.exec(js))) {
                js = js.slice(0, ret.index + ret[0].length) + ',window.drawhookimg(t,image_data)' + js.slice(ret.index + ret[0].length);
                applied.push('patch_2');
            }
            if ((ret = RE.getResourceImage.exec(js))) {
                js = js.slice(0, ret.index + ret[0].length) + 'e = window.drawhookcanvas(e,this._imageModel);' + js.slice(ret.index + ret[0].length);
                applied.push('patch_3');
            }
            if ((ret = RE.drawGeometry.exec(js))) {
                js = js.slice(0, ret.index + ret[1].length) + ';try{window.attachbody(t);}catch(_){}' + js.slice(ret.index + ret[1].length);
                applied.push('patch_4');
                setTimeout(addbtnfunc, 2000);
            }

            if (applied.length) {
                window._anyAnchorsMatched = true;
                try { sessionStorage.removeItem('ripper_reloaded'); } catch (e) {}
                log('patched', src.split('/').pop(), '→', applied.join(','));
            }

            var s = document.createElement('script');
            s.type = 'text/javascript';
            s.text = js;
            (document.head || document.getElementsByTagName('head')[0]).appendChild(s);
        });
    };

    (function kickoff() {
        var isViewerFrame = (window.self !== window.top) || (location.pathname.indexOf('/embed') !== -1);
        if (!isViewerFrame) return;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { setTimeout(addbtnfunc, 500); });
        } else {
            setTimeout(addbtnfunc, 500);
        }
    })();
})();
