// ==UserScript==
// @name         Sketchfab Ripper V16
// @version      16.0.0
// @description  download Sketchfab models as GLB with skeleton and recorded animation
// @author       Risk + community
// @include      /^https?://(www\.)?sketchfab\.com/.*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/1.3.8/FileSaver.js
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';
    var window = unsafeWindow;

    window.allmodel            = window.allmodel            || [];
    window.animationRecording  = false;
    window.recordedFrames      = [];
    window.recordingStartTime  = 0;
    window.recordingRafId      = null;
    window._anyAnchorsMatched  = false;

    var saveimagecache2 = {};
    var objects         = {};
    var button_dw       = false;

    var CONFIG = {
        MAX_RECORD_SECONDS: 5,
        AUTO_RELOAD_ON_FAILURE: true
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

    window.drawhookcanvas = function (e, imagemodel) {
        try {
            if (!e) return e;
            if ((e.width === 128 && e.height === 128) ||
                (e.width === 32  && e.height === 32)  ||
                (e.width === 64  && e.height === 64)) return e;
            if (imagemodel && e.options && imagemodel.attributes && imagemodel.attributes.images) {
                var alpha = e.options.format;
                // --- diagnostic: capture both name sources ---
                window.__ripperTexInfo = window.__ripperTexInfo || [];
                var _imgModelName = (imagemodel && imagemodel.attributes &&
                                     imagemodel.attributes.name) || null;
                var _eUrl = e.url;
                // ----------------------------------------------
                var filename_image = null; // derived from URL below
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
                    window.__ripperTexInfo.push({
                        url_image: url_image,
                        e_url: _eUrl,
                        imagemodel_name: _imgModelName,
                        chosen: texName
                    });
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
            window.allmodel.push(obj);
        } catch (e) { err('attachbody', e.message); }
    };

    // ====================================================================
    // Recorder
    // ====================================================================
    function snapshotFrame() {
        var meshesOut = [];
        window.allmodel.forEach(function (obj) {
            var world = computeWorldMatrix(obj);
            var pal = null;
            try {
                var impl = obj._rigTransformImplementation;
                if (impl && impl._skinningAttribute && impl._skinningAttribute._matrixPalette) {
                    var src = impl._skinningAttribute._matrixPalette;
                    pal = new Float32Array(src.length);
                    for (var i = 0; i < src.length; i++) pal[i] = src[i];
                }
            } catch (e) {}
            meshesOut.push({ world: world, palette: pal });
        });
        return { meshes: meshesOut };
    }

    function startRecording() {
        if (window.animationRecording) return;
        window.animationRecording = true;
        window.recordedFrames = [];
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
            s.textContent = (window.animationRecording ? '● REC' : 'idle')
                          + ' · meshes:' + m + ' frames:' + f;
            s.style.color = window.animationRecording ? '#f66' : '#aaa';
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
        return {
            vertex: attr.Vertex ? attr.Vertex._elements : [],
            normal: attr.Normal ? attr.Normal._elements : [],
            uv: attr.TexCoord0 ? attr.TexCoord0._elements : [],
            joints: joints,
            weights: weights,
            primitives: list
        };
    }

    // ====================================================================
    // GLB Export
    // ====================================================================
    function downloadGLB() {
        log('export started');
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
            var totalBuf = [], off = 0;
            var matHasUV = {};
            var meshHasSkinning = {};

            function addBV(ta, target) {
                var len = ta.byteLength;
                var al = pad(off), padn = al - off;
                if (padn > 0) { for (var i = 0; i < padn; i++) totalBuf.push(0); off += padn; }
                var idx = bvs.length;
                var bv = { buffer: 0, byteOffset: off, byteLength: len };
                if (target) bv.target = target;
                bvs.push(bv);
                var bytes = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
                for (var j = 0; j < bytes.length; j++) totalBuf.push(bytes[j]);
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
                    aU = accs.length;
                    accs.push({ bufferView: addBV(new Float32Array(mdl.uv), 34962),
                                componentType: 5126, count: vc, type: 'VEC2' });
                    matHasUV[nm] = true;
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

                var primMode = (mdl.primitives.length > 0 && mdl.primitives[0].mode) ? mdl.primitives[0].mode : 4;
                var prim = { attributes: { POSITION: accPos }, mode: primMode };
                if (aN >= 0) prim.attributes.NORMAL = aN;
                if (aU >= 0) prim.attributes.TEXCOORD_0 = aU;
                if (aJ >= 0) prim.attributes.JOINTS_0 = aJ;
                if (aW >= 0) prim.attributes.WEIGHTS_0 = aW;
                if (aI >= 0) prim.indices = aI;

                var mi = -1;
                for (var q = 0; q < mats.length; q++) if (mats[q].name === nm) { mi = q; break; }
                if (mi === -1) {
                    mi = mats.length;
                    mats.push({ name: nm, pbrMetallicRoughness: {
                        baseColorFactor: [1,1,1,1], metallicFactor: 1, roughnessFactor: 1 } });
                }
                prim.material = mi;

                var mshIdx = meshes.length;
                meshes.push({ name: nm, primitives: [prim] });
                var ni = nodeMap.get(obj);
                if (ni !== undefined) nodes[ni].mesh = mshIdx;
            });

            var images = [], textures = [];
            var textureUrlToIndex = {};
            for (var key in saveimagecache2) {
                var t = saveimagecache2[key];
                if (!t || !t.dataURL) continue;
                var ext = t.fileExt || '.png';
                var path = 'textures/' + (t.name || 'texture') + ext;
                var ii = images.length;
                images.push({ uri: path });
                textures.push({ source: ii });
                textureUrlToIndex[key] = ii;
            }
            if (textures.length) {
                mats.forEach(function (m) {
                    if (matHasUV[m.name]) m.pbrMetallicRoughness.baseColorTexture = { index: 0 };
                });
            }

            var liveSnap = (window.recordedFrames.length > 1) ? null : snapshotFrame().meshes;
            var gltfSkins = [];
            var animations;
            var hasFrames = window.recordedFrames.length > 1;
            var times = hasFrames ? window.recordedFrames.map(function (f) { return f.time; }) : null;
            var timeAccIdx = -1;
            if (hasFrames) {
                var tV = addBV(new Float32Array(times));
                timeAccIdx = accs.length;
                accs.push({ bufferView: tV, componentType: 5126, count: times.length,
                            type: 'SCALAR', min: [times[0]], max: [times[times.length - 1]] });
            }

            var allSamplers = [], allChannels = [];

            function expandMat3x4(pal, boneIdx) {
                var b = boneIdx * 12;
                return [
                    pal[b + 0], pal[b + 4], pal[b + 8], 0,
                    pal[b + 1], pal[b + 5], pal[b + 9], 0,
                    pal[b + 2], pal[b + 6], pal[b + 10], 0,
                    pal[b + 3], pal[b + 7], pal[b + 11], 1
                ];
            }

            allNodes.forEach(function (obj, mIdx) {
                if (!meshHasSkinning[mIdx]) return;

                var meshNodeIdx = nodeMap.get(obj);
                if (meshNodeIdx === undefined) return;

                var jointCount = meshHasSkinning[mIdx];
                var paletteRef = null;
                if (hasFrames) {
                    for (var fi = 0; fi < window.recordedFrames.length; fi++) {
                        var fm = window.recordedFrames[fi].meshes[mIdx];
                        if (fm && fm.palette) {
                            var fromPal = (fm.palette.length / 12) | 0;
                            if (fromPal > jointCount) jointCount = fromPal;
                            paletteRef = fm;
                            break;
                        }
                    }
                }

                // The mesh's own world transform (via getMatrix()/.matrix chain)
                // Parent of the joints so the whole rig inherits it.
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
                    for (var jn = 0; jn < jointCount; jn++) {
                        var T = [], R = [], S = [];
                        var moved = false, first = null;
                        var prevQ = null;
                        for (var fi2 = 0; fi2 < window.recordedFrames.length; fi2++) {
                            var fmesh = window.recordedFrames[fi2].meshes[mIdx];
                            var pal = fmesh && fmesh.palette;
                            var mPal = (pal && pal.length >= (jn + 1) * 12)
                                     ? expandMat3x4(pal, jn) : identityMat4();
                            if (first === null) first = mPal.slice();
                            else if (!moved) {
                                for (var vi = 0; vi < 16; vi++) {
                                    if (Math.abs(mPal[vi] - first[vi]) > 1e-5) { moved = true; break; }
                                }
                            }
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
                        if (!moved) continue;
                        animatedCount++;

                        var nIdx = jointNodeIndices[jn];
                        var aT = accs.length;
                        accs.push({ bufferView: addBV(new Float32Array(T)), componentType: 5126,
                                    count: times.length, type: 'VEC3' });
                        allSamplers.push({ input: timeAccIdx, interpolation: 'LINEAR', output: aT });
                        allChannels.push({ sampler: allSamplers.length - 1,
                                           target: { node: nIdx, path: 'translation' } });

                        var aR = accs.length;
                        accs.push({ bufferView: addBV(new Float32Array(R)), componentType: 5126,
                                    count: times.length, type: 'VEC4' });
                        allSamplers.push({ input: timeAccIdx, interpolation: 'LINEAR', output: aR });
                        allChannels.push({ sampler: allSamplers.length - 1,
                                           target: { node: nIdx, path: 'rotation' } });

                        var aS = accs.length;
                        accs.push({ bufferView: addBV(new Float32Array(S)), componentType: 5126,
                                    count: times.length, type: 'VEC3' });
                        allSamplers.push({ input: timeAccIdx, interpolation: 'LINEAR', output: aS });
                        allChannels.push({ sampler: allSamplers.length - 1,
                                           target: { node: nIdx, path: 'scale' } });
                    }

                    for (var sj = 0; sj < jointCount; sj++) {
                        var wasAnimated = false;
                        for (var cc = 0; cc < allChannels.length; cc++) {
                            if (allChannels[cc].target.node === jointNodeIndices[sj]) {
                                wasAnimated = true; break;
                            }
                        }
                        if (wasAnimated) continue;
                        var pal0 = expandMat3x4(paletteRef.palette, sj);
                        var d0 = decomposeMat4(pal0);
                        var jnIdx = jointNodeIndices[sj];
                        nodes[jnIdx].translation = d0.translation;
                        nodes[jnIdx].rotation = d0.rotation;
                        nodes[jnIdx].scale = d0.scale;
                    }

                    log('skin', skinIdx, 'for mesh', meshes[nodes[meshNodeIdx].mesh].name,
                        '→', jointCount, 'joints,', animatedCount, 'animated');
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

            if (allChannels.length) {
                var ml = document.getElementsByClassName('model-name__label')[0];
                var an = ml ? ml.textContent.trim().replace(/\.+$/, '') : 'model';
                animations = [{ name: an + '_anim', samplers: allSamplers, channels: allChannels }];
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
                images: images,
                textures: textures,
                buffers: [{ byteLength: off }]
            };
            if (gltfSkins.length) gltf.skins = gltfSkins;
            if (animations) gltf.animations = animations;

            log('built scene: nodes=' + nodes.length,
                'meshes=' + meshes.length,
                'skins=' + gltfSkins.length,
                'animFrames=' + (animations ? times.length : 0));

            var jsonStr = JSON.stringify(gltf);
            var jsonBytes = new TextEncoder().encode(jsonStr);
            var jAl = pad(jsonBytes.byteLength), jPad = jAl - jsonBytes.byteLength;
            var bin = new Uint8Array(totalBuf).buffer;
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

    // ====================================================================
    // Debug: dump uniform lists so we can wire materials → textures
    // ====================================================================
    window.dumpRipperUniforms = function () {
        if (!window.allmodel.length) { log('no meshes loaded yet'); return; }
        var obj = window.allmodel[0];
        var ss = obj.stateset;
        if (!ss) { log('no stateset'); return; }

        log('=== 1. ss.uniforms ===');
        var u = ss.uniforms;
        log('  type:', typeof u, ' isArray:', Array.isArray(u),
            ' ctor:', u && u.constructor && u.constructor.name);
        if (u && typeof u === 'object') {
            var uks = Object.keys(u);
            log('  keys (' + uks.length + '):');
            for (var i = 0; i < uks.length; i++) {
                var un = uks[i], uv = u[un];
                var uvT = uv == null ? 'null'
                        : ((uv.constructor && uv.constructor.name) || typeof uv);
                var hint = '';
                if (uv && uv._image) hint = ' | _image';
                if (uv && uv._imageModel) hint = ' | _imageModel';
                if (uv && uv.url) hint += ' | url=' + uv.url;
                if (uv && typeof uv === 'object' && uv._name) hint += ' | name=' + uv._name;
                log('    ' + un + ' → ' + uvT + hint);
            }
        }

        log('=== 2. ss._textureAttributeArrayList ===');
        var ta = ss._textureAttributeArrayList;
        log('  type:', typeof ta, ' isArray:', Array.isArray(ta),
            ' len:', ta && ta.length);
        if (ta && ta.length) {
            for (var j = 0; j < ta.length; j++) {
                var t = ta[j];
                if (!t) { log('    [' + j + '] null'); continue; }
                var tks = [];
                for (var tk in t) { if (t.hasOwnProperty(tk)) tks.push(tk); }
                log('    [' + j + '] ctor=' + (t.constructor && t.constructor.name),
                    ' keys=' + tks.join(','));
                if (t._image) {
                    log('       _image.url =', t._image._url || t._image.url || '?');
                    log('       _image.name =', t._image._name || t._image.name || '?');
                }
                if (t._imageModel) {
                    log('       _imageModel.attrs.name =',
                        (t._imageModel.attributes && t._imageModel.attributes.name) || '?');
                }
                if (t._texture) {
                    log('       _texture ctor =',
                        t._texture.constructor && t._texture.constructor.name);
                }
                if (t._name) log('       _name =', t._name);
            }
        }

        log('=== 3. ss._shaderGeneratorPair ===');
        var sp = ss._shaderGeneratorPair;
        if (sp) {
            var spk = [];
            for (var sp1 in sp) { if (sp.hasOwnProperty(sp1)) spk.push(sp1); }
            log('  keys:', spk.join(','));
        } else log('  null');

        log('=== 4. ss.getUniformList() contents ===');
        try {
            var ul = ss.getUniformList();
            var ulk = Object.keys(ul);
            log('  keys (' + ulk.length + '):', ulk.join(', '));
            for (var k = 0; k < ulk.length; k++) {
                var key = ulk[k], val = ul[key];
                var vT = val == null ? 'null'
                       : ((val.constructor && val.constructor.name) || typeof val);
                var ex = '';
                if (val && val._image) ex = ' | _image';
                if (val && val._imageModel) ex = ' | _imageModel';
                log('    ' + key + ' → ' + vT + ex);
            }
        } catch (e) { log('  threw:', e.message); }

        log('=== 5. walk parents for texture state ===');
        var curr = obj, lvl = 0;
        while (curr && lvl++ < 6) {
            var cName = curr._name ||
                (curr.stateset && curr.stateset._name) || '?';
            var cSS = curr.stateset;
            var hasTA = cSS && cSS._textureAttributeArrayList &&
                        cSS._textureAttributeArrayList.length;
            var hasU  = cSS && cSS.uniforms &&
                        Object.keys(cSS.uniforms).length;
            log('  [' + lvl + '] ' + cName
                + ' | stateset=' + (cSS ? 'yes' : 'no')
                + ' uniforms=' + (hasU || 0)
                + ' texAttrs=' + (hasTA || 0));
            curr = curr._parents && curr._parents[0];
        }

        log('--- end of dump v3 ---');
    };
})();