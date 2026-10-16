// ==UserScript==
// @name         Sketchfab Ripper (modern syntax test)
// @namespace    https://github.com/anotherRandomPersonlol/SketchFabModelRipping
// @version      1.3.0
// @description  Download Sketchfab models as GLB: skeleton, recorded animation clips, PBR textures, vertex colours, morph targets
// @author       anotherRandomPersonlol
// @license      MIT
// @match        https://sketchfab.com/*
// @match        https://www.sketchfab.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/1.3.8/FileSaver.js
// @run-at       document-start
// @grant        unsafeWindow
// @homepageURL  https://github.com/anotherRandomPersonlol/SketchFabModelRipping
// @supportURL   https://github.com/anotherRandomPersonlol/SketchFabModelRipping/issues
// ==/UserScript==
// Based off Risk's extraction
(() => {
    'use strict';
    const window = unsafeWindow;

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

    const saveimagecache2 = {};
    const objects         = {};
    let button_dw       = false;
    let _exporting      = false;   // true while downloadGLB runs (read by the recorders, which are defined first)

    const CONFIG = {
        MAX_RECORD_SECONDS: 12,
        AUTO_RELOAD_ON_FAILURE: true,
        MR_TEXTURE_FORMAT: 'jpeg',  // 'jpeg' (small) or 'png' (lossless)
        RECORD_FPS: 0,              // recording sample rate: 0 = every rendered frame, or 60 / 30 / 24 / 15
        CLIP_SETTLE_FRAMES: 2,      // rAF ticks to wait after seeking to a clip's start
        DEDUPE_STRICT_WORLD: false, // true: keep same-name meshes at different positions
        REST_POSE_SOURCE: 'clip0',  // joint rest pose: 'clip0' (first frame of first clip) or 'static' (viewer's Static Pose)
        TEXTURE_WAIT_SECONDS: 12,   // max wait at export for textures the viewer is still loading (0 = never wait)
        VERTEX_COLOR_SRGB: true,    // true: treat Sketchfab Color bytes as sRGB and write linear COLOR_0 (matches the viewer's look)
        EXPORT_SCALE: 1,            // uniform scale on the scene root (0.01 for models authored in centimetres)
        FLAT_MR_FROM_VIEWER: true,  // true: metalness/roughness of texture-less materials as the viewer shows them; false: neutral metal 0 / rough 0.5
        DROP_STRIP_SLIVERS: true,   // drop long, near-zero-width bridging triangles inside triangle strips (the "stripes")
        REDUCE_KEYS: true,          // drop keyframes that interpolation between the kept keys already reproduces (tolerance scales with the model size)
        KEEP_STILL_CLIPS: false,    // true: a clip in which no joint moves is exported as a pose clip (2 equal keys); false: such clips are left out
        DOUBLE_SIDED_AUTO: true,    // true: follow the viewer's Single Sided flag per material (cullFace != 0 -> single sided); false: use DOUBLE_SIDED for all
        DOUBLE_SIDED: true          // true: mark every material doubleSided (matches Sketchfab's default, Single Sided OFF); untick for single-sided export
    };
    const CONFIG_KEY = 'ripper_config_v1';

    function loadConfig() {
        try {
            const saved = localStorage.getItem(CONFIG_KEY);
            if (!saved) return;
            const parsed = JSON.parse(saved);
            for (let k in parsed) {
                if (parsed.hasOwnProperty(k) && CONFIG.hasOwnProperty(k)
                    && typeof parsed[k] === typeof CONFIG[k]
                    && (typeof parsed[k] !== 'number' || isFinite(parsed[k]))) {
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
    const YUP = [
        1, 0, 0, 0,
        0, 0, -1, 0,
        0, 1, 0, 0,
        0, 0, 0, 1
    ];

    const TAG = '[Ripper]';
    function log(...args)  { console.log(TAG, ...args); }
    function warn(...args) { console.warn(TAG, ...args); }
    function err(...args)  { console.error(TAG, ...args); }

    log('init');

    // ====================================================================
    // Math
    // ====================================================================
    function identityMat4() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
    function mulMat4(a, b) {   // column-major a * b
        let r = new Array(16), c, rr, k;
        for (c = 0; c < 4; c++) for (rr = 0; rr < 4; rr++) {
            let v = 0;
            for (k = 0; k < 4; k++) v += a[k * 4 + rr] * b[c * 4 + k];
            r[c * 4 + rr] = v;
        }
        return r;
    }

    function matToArr(m) {
        if (!m || m.length !== 16) return null;
        const o = new Array(16);
        for (let i = 0; i < 16; i++) o[i] = m[i];
        return o;
    }

    function mat4Mul(a, b) {
        const o = new Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
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
                const m1 = matToArr(node.getMatrix());
                if (m1) return m1;
            } catch (e) {}
        }
        if (node.matrix) {
            const m2 = matToArr(node.matrix);
            if (m2) return m2;
        }
        if (node._matrix) {
            const m3 = matToArr(node._matrix);
            if (m3) return m3;
        }
        return identityMat4();
    }

    function computeWorldMatrix(obj) {
        const chain = [];
        let curr = obj;
        let guard = 0;
        while (curr && guard++ < 64) {
            chain.unshift(getLocalNodeMatrix(curr));
            curr = curr._parents && curr._parents[0];
        }
        let world = identityMat4();
        for (let i = 0; i < chain.length; i++) world = mat4Mul(world, chain[i]);
        return world;
    }

    // ====================================================================
    // Sheared joint matrices: M = T * U * diag(s) * Vt (exact for any 3x3), stored as two glTF nodes
    // ====================================================================
    function _mat3FromMat4(m) { return [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]]; }
    function _quatFromCols(c0, c1, c2) {
        // c0..c2: columns of a proper rotation matrix -> quaternion via decomposeMat4
        return decomposeMat4([c0[0], c0[1], c0[2], 0, c1[0], c1[1], c1[2], 0, c2[0], c2[1], c2[2], 0, 0, 0, 0, 1]).rotation;
    }
    function _cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
    function _dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    function _norm(a) { const l = Math.sqrt(_dot(a, a)); return l > 1e-20 ? [a[0] / l, a[1] / l, a[2] / l] : null; }
    function _anyPerp(a) {
        const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        return _norm(_cross(a, t));
    }
    // Symmetric 3x3 eigen decomposition (cyclic Jacobi). Returns eigenvalues and eigenvector columns.
    function _eigSym3(S) {
        const a = [[S[0][0], S[0][1], S[0][2]], [S[1][0], S[1][1], S[1][2]], [S[2][0], S[2][1], S[2][2]]];
        let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sweep, p, q, r;
        for (sweep = 0; sweep < 50; sweep++) {
            const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
            if (off < 1e-30) break;
            for (p = 0; p < 2; p++) for (q = p + 1; q < 3; q++) {
                if (Math.abs(a[p][q]) < 1e-300) continue;
                const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
                const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
                const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
                for (r = 0; r < 3; r++) { const arp = a[r][p], arq = a[r][q]; a[r][p] = c * arp - sn * arq; a[r][q] = sn * arp + c * arq; }
                for (r = 0; r < 3; r++) { const apr = a[p][r], aqr = a[q][r]; a[p][r] = c * apr - sn * aqr; a[q][r] = sn * apr + c * aqr; }
                for (r = 0; r < 3; r++) { const vrp = v[r][p], vrq = v[r][q]; v[r][p] = c * vrp - sn * vrq; v[r][q] = sn * vrp + c * vrq; }
            }
        }
        return { vals: [a[0][0], a[1][1], a[2][2]], vecs: [[v[0][0], v[1][0], v[2][0]], [v[0][1], v[1][1], v[2][1]], [v[0][2], v[1][2], v[2][2]]] };
    }
    // m: column-major 4x4. prevV: previous frame's V columns (for continuity) or null.
    // Returns { translation, rotU, scale, rotV, V } with M = T * U * diag(scale) * V^T.
    function svdDecompose(m, prevV) {
        let A = _mat3FromMat4(m), i, j, k;
        const ATA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) for (k = 0; k < 3; k++) ATA[i][j] += A[k][i] * A[k][j];
        const e = _eigSym3(ATA), order = [0, 1, 2];
        order.sort((x, y) => e.vals[y] - e.vals[x]);
        let V = [e.vecs[order[0]], e.vecs[order[1]], e.vecs[order[2]]];
        const lmax = Math.max(e.vals[0], e.vals[1], e.vals[2]), lmin = Math.min(e.vals[0], e.vals[1], e.vals[2]);
        if (prevV) {
            // Two equal singular values: any basis of that plane is exact; use the one closest to the previous frame.
            const sv = [e.vals[order[0]], e.vals[order[1]], e.vals[order[2]]], gtol = 1e-4 * Math.max(lmax, 1e-30);
            const pa = (sv[0] - sv[1] <= gtol && sv[1] - sv[2] > gtol) ? 0 : ((sv[1] - sv[2] <= gtol && sv[0] - sv[1] > gtol) ? 1 : -1);
            if (pa >= 0) {
                let pc = V[pa === 0 ? 2 : 0], pr = null, bl = -1;
                for (i = 0; i < 3; i++) {
                    const dp = _dot(prevV[i], pc), pj = [prevV[i][0] - dp * pc[0], prevV[i][1] - dp * pc[1], prevV[i][2] - dp * pc[2]];
                    if (_dot(pj, pj) > bl) { bl = _dot(pj, pj); pr = pj; }
                }
                const va = _norm(pr);
                if (va) { V[pa] = va; V[pa + 1] = _cross(pc, va); }
            }
        }
        if (prevV && lmax - lmin <= 1e-6 * Math.max(lmax, 1e-30)) {
            V = [prevV[0], prevV[1], prevV[2]];   // uniform scale: any basis works, keep the previous one (no jump)
        } else if (prevV) {
            // Keep the same column order and signs as the previous frame (no flips during interpolation).
            const used = [false, false, false], nv = [];
            for (i = 0; i < 3; i++) {
                let best = -1, bd = -1;
                for (j = 0; j < 3; j++) { if (used[j]) continue; const dd = Math.abs(_dot(prevV[i], V[j])); if (dd > bd) { bd = dd; best = j; } }
                used[best] = true;
                nv.push(_dot(prevV[i], V[best]) < 0 ? [-V[best][0], -V[best][1], -V[best][2]] : V[best]);
            }
            V = nv;
        }
        if (_dot(_cross(V[0], V[1]), V[2]) < 0) V[2] = [-V[2][0], -V[2][1], -V[2][2]];
        let sig = [], U = [], smax = 0;
        for (i = 0; i < 3; i++) {
            const av = [A[0][0] * V[i][0] + A[0][1] * V[i][1] + A[0][2] * V[i][2],
                      A[1][0] * V[i][0] + A[1][1] * V[i][1] + A[1][2] * V[i][2],
                      A[2][0] * V[i][0] + A[2][1] * V[i][1] + A[2][2] * V[i][2]];
            sig[i] = Math.sqrt(_dot(av, av));
            if (sig[i] > smax) smax = sig[i];
            U[i] = av;
        }
        const ok = [];
        for (i = 0; i < 3; i++) { ok[i] = sig[i] > 1e-9 * Math.max(smax, 1e-30); U[i] = ok[i] ? [U[i][0] / sig[i], U[i][1] / sig[i], U[i][2] / sig[i]] : null; if (!ok[i]) sig[i] = 0; }
        // Complete / orthonormalise U (Gram-Schmidt in V order). A zero axis is rebuilt from the two real ones.
        if (!U[0] && U[1] && U[2]) U[0] = _cross(U[1], U[2]);
        else if (U[0] && !U[1] && U[2]) U[1] = _cross(U[2], U[0]);
        if (!U[0]) U[0] = U[1] ? _anyPerp(U[1]) : (U[2] ? _anyPerp(U[2]) : [1, 0, 0]);
        if (U[1]) { const d01 = _dot(U[1], U[0]); U[1] = _norm([U[1][0] - d01 * U[0][0], U[1][1] - d01 * U[0][1], U[1][2] - d01 * U[0][2]]); }
        if (!U[1]) U[1] = _anyPerp(U[0]);
        const u2 = _cross(U[0], U[1]);
        if (U[2] && _dot(U[2], u2) < 0) { sig[2] = -sig[2]; }   // mirrored: keep U a rotation, move the sign into scale
        U[2] = u2;
        return {
            translation: [m[12], m[13], m[14]],
            rotU: _quatFromCols(U[0], U[1], U[2]),
            scale: sig,
            // V^T as a rotation: its columns are the rows of V-as-columns
            rotV: _quatFromCols([V[0][0], V[1][0], V[2][0]], [V[0][1], V[1][1], V[2][1]], [V[0][2], V[1][2], V[2][2]]),
            V,
            uniform: lmax - lmin <= 1e-6 * Math.max(lmax, 1e-30)
        };
    }
    // SVD for a whole frame sequence: start at the first non-uniform frame (its basis is meaningful),
    // go forward from there, then backward for the leading uniform frames, so no frame picks a random basis.
    function svdSequence(mats) {
        let n = mats.length, out = new Array(n), k = 0, i;
        while (k < n && svdDecompose(mats[k], null).uniform) k++;
        if (k >= n) k = 0;
        out[k] = svdDecompose(mats[k], null);
        for (i = k + 1; i < n; i++) out[i] = svdDecompose(mats[i], out[i - 1].V);
        for (i = k - 1; i >= 0; i--) out[i] = svdDecompose(mats[i], out[i + 1].V);
        return out;
    }
    function _quatCont(q, prev) {
        if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) return [-q[0], -q[1], -q[2], -q[3]];
        return q;
    }
    function trsError(m) {
        let dc = composeTRS(decomposeMat4(m)), de = 0, dsc = 1e-9, dq;
        for (dq = 0; dq < 11; dq++) { if (dq % 4 === 3) continue; de = Math.max(de, Math.abs(dc[dq] - m[dq])); dsc = Math.max(dsc, Math.abs(m[dq])); }   // 3x3 part only: translation round-trips exactly
        return de / dsc;
    }

    // Inverse of decomposeMat4: column-major T*R*S matrix (used to measure decomposition error).
    function composeTRS(d) {
        const x = d.rotation[0], y = d.rotation[1], z = d.rotation[2], w = d.rotation[3], s = d.scale, t = d.translation;
        return [
            (1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y + z * w)) * s[0], (2 * (x * z - y * w)) * s[0], 0,
            (2 * (x * y - z * w)) * s[1], (1 - 2 * (x * x + z * z)) * s[1], (2 * (y * z + x * w)) * s[1], 0,
            (2 * (x * z + y * w)) * s[2], (2 * (y * z - x * w)) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
            t[0], t[1], t[2], 1
        ];
    }

    function decomposeMat4(m) {
        const tx = m[12], ty = m[13], tz = m[14];
        let sx = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
        const sy = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
        const sz = Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);
        const iX = sx ? 1/sx : 0, iY = sy ? 1/sy : 0, iZ = sz ? 1/sz : 0;

        let m00 = m[0]*iX, m01 = m[4]*iY, m02 = m[8]*iZ;
        let m10 = m[1]*iX, m11 = m[5]*iY, m12 = m[9]*iZ;
        let m20 = m[2]*iX, m21 = m[6]*iY, m22 = m[10]*iZ;
        // A zero-scaled axis (rigs hide unused expression parts this way) leaves an empty column:
        // rebuild it from the other two so the rotation stays valid; keep the 0 scale.
        if (!sx && sy && sz) { m00 = m11 * m22 - m21 * m12; m10 = m21 * m02 - m01 * m22; m20 = m01 * m12 - m11 * m02; }
        else if (!sy && sx && sz) { m01 = m12 * m20 - m22 * m10; m11 = m22 * m00 - m02 * m20; m21 = m02 * m10 - m12 * m00; }
        else if (!sz && sx && sy) { m02 = m10 * m21 - m20 * m11; m12 = m20 * m01 - m00 * m21; m22 = m00 * m11 - m10 * m01; }
        else if ((!sx ? 1 : 0) + (!sy ? 1 : 0) + (!sz ? 1 : 0) === 2) {
            // One axis left: keep its direction, complete the rotation with any perpendicular pair.
            const c0 = sx ? [m00, m10, m20] : (sy ? [m01, m11, m21] : [m02, m12, m22]), c1 = _anyPerp(c0), c2 = _cross(c0, c1);
            if (sx) { m01 = c1[0]; m11 = c1[1]; m21 = c1[2]; m02 = c2[0]; m12 = c2[1]; m22 = c2[2]; }
            else if (sy) { m02 = c1[0]; m12 = c1[1]; m22 = c1[2]; m00 = c2[0]; m10 = c2[1]; m20 = c2[2]; }
            else { m00 = c1[0]; m10 = c1[1]; m20 = c1[2]; m01 = c2[0]; m11 = c2[1]; m21 = c2[2]; }
        } else if (!sx && !sy && !sz) { m00 = 1; m01 = 0; m02 = 0; m10 = 0; m11 = 1; m12 = 0; m20 = 0; m21 = 0; m22 = 1; }
        // Mirrored transform (negative determinant): move the reflection into the X scale.
        const det = m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20);
        if (det < 0) { sx = -sx; m00 = -m00; m10 = -m10; m20 = -m20; }

        const trace = m00 + m11 + m22;
        let qw, qx, qy, qz;

        if (trace > 0) {
            const S = Math.sqrt(trace + 1) * 2;
            qw = 0.25 * S;
            qx = (m21 - m12) / S;
            qy = (m02 - m20) / S;
            qz = (m10 - m01) / S;
        } else if (m00 > m11 && m00 > m22) {
            const S1 = Math.sqrt(1 + m00 - m11 - m22) * 2;
            qw = (m21 - m12) / S1;
            qx = 0.25 * S1;
            qy = (m01 + m10) / S1;
            qz = (m02 + m20) / S1;
        } else if (m11 > m22) {
            const S2 = Math.sqrt(1 + m11 - m00 - m22) * 2;
            qw = (m02 - m20) / S2;
            qx = (m01 + m10) / S2;
            qy = 0.25 * S2;
            qz = (m12 + m21) / S2;
        } else {
            const S3 = Math.sqrt(1 + m22 - m00 - m11) * 2;
            qw = (m10 - m01) / S3;
            qx = (m02 + m20) / S3;
            qy = (m12 + m21) / S3;
            qz = 0.25 * S3;
        }
        const ql = Math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw);
        if (ql) { qx /= ql; qy /= ql; qz /= ql; qw /= ql; }
        return {
            translation: [tx, ty, tz],
            rotation: [qx, qy, qz, qw],
            scale: [sx, sy, sz]
        };
    }

    // ====================================================================
    // Texture capture
    // ====================================================================
    const _usedTextureNames = {};

    function sanitizeTextureName(raw) {
        if (!raw) return '';
        let s = String(raw);
        try { s = decodeURIComponent(s); } catch (e) {}
        s = s.replace(/\.(jpe?g|png|webp|gif|ktx2?|basis|tga|bmp)$/i, '');
        s = s.replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').trim();
        return s;
    }

    function deriveTextureName(url) {
        if (!url) return 'texture';
        const clean = String(url).split('?')[0].split('#')[0];
        const base = clean.substring(clean.lastIndexOf('/') + 1);
        const s = sanitizeTextureName(base);
        return s || 'texture';
    }

    function pickTextureName(imagemodel, url) {
        // Prefer Sketchfab's metadata name (semantic, e.g.
        // "Patriot_Radar_Body_D_Desert"). Fall back to URL base if
        // metadata is missing or empty.
        const metaName = imagemodel && imagemodel.attributes && imagemodel.attributes.name;
        const s = sanitizeTextureName(metaName);
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
            const ta = ss && ss._textureAttributeArrayList;
            if (!ta || !ta.length) return false;
            for (let i = 0; i < ta.length; i++) if (ta[i] && ta[i][0]) return true;
            return false;
        }
        if (!obj) return null;
        if (hasTex(obj.stateset)) return obj.stateset;
        let cur = obj._parents && obj._parents[0], guard = 0;
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
        let cur = obj, guard = 0;
        while (cur && guard++ < 8) {
            const ss = cur.stateset || cur._stateSet || null;
            const a0 = unwrap(ss && ss._attributeArray && ss._attributeArray[0]);
            const mm = a0 && a0._materialModel;
            const ch = mm && mm.attributes && mm.attributes.channels;
            if (ch) {
                const out = {};
                for (let k in ch) {
                    if (!ch.hasOwnProperty(k)) continue;
                    const at = ch[k] && ch[k].attributes;
                    if (at) out[k] = at;
                }
                // Which channels have a texture: the stateset's channel mapping (>= 0 = texture unit).
                out.__map = a0._channelMapping || null;
                out.__cull = mm.attributes.cullFace;   // 0 = Single Sided OFF; ON value to be confirmed from logs
                return out;
            }
            cur = cur._parents && cur._parents[0];
        }
        return null;
    }

    function getChannelTextureMap(obj) {
        const map = {};
        try {
            const ss = textureStateSet(obj);
            if (!ss) return map;
            const ta = ss._textureAttributeArrayList;
            if (!ta || !ta.length) return map;
            for (let s = 0; s < ta.length; s++) {
                const slot = ta[s];
                if (!slot || !slot[0]) continue;
                const tex = slot[0]._object;
                if (!tex) continue;
                const channels = tex._channels || [];
                const packedAll = tex._packedTextures || {};
                for (let c = 0; c < channels.length; c++) {
                    const chName = channels[c];
                    if (!chName) continue;
                    const packed = packedAll[chName];
                    if (!packed || !packed.texture) continue;
                    const img = packed.texture._image;
                    const imM = packed.texture._imageModel;
                    map[chName] = {
                        url : img && (img._url || img.url),
                        name: imM && imM.attributes && imM.attributes.name,
                        // Texture-less materials: Sketchfab packs the flat colours into a generated
                        // colour atlas (no image file); the channel then only looks textured.
                        atlas: (packed.texture._isColorAtlas === true || tex._isColorAtlas === true)
                    };
                }
            }
        } catch (e) { warn('getChannelTextureMap', e.message); }
        return map;
    }

    window.drawhookcanvas = (e, imagemodel) => {
        try {
            if (!e) return e;
            // 32/64/128 px square images are usually low-res placeholders of a bigger texture; they are
            // skipped only while a larger variant exists (a texture whose real size is 128 px is kept).
            const isSmall = (e.width === 128 && e.height === 128) ||
                          (e.width === 32  && e.height === 32)  ||
                          (e.width === 64  && e.height === 64);
            if (isSmall && !(imagemodel && e.options && imagemodel.attributes && imagemodel.attributes.images)) return e;
            if (imagemodel && e.options && imagemodel.attributes && imagemodel.attributes.images) {
                const alpha = e.options.format;
                let url_image = e.url, max_size = 0, obr = e;
                imagemodel.attributes.images.forEach((img) => {
                    const ok = alpha === 'A' ? img.options.format === alpha : true;
                    let d = img.width; while (d > 0 && d % 2 === 0) d = d / 2;
                    if (img.size > max_size && ok && d === 1) {
                        max_size = img.size; url_image = img.url; obr = img;
                    }
                });
                if (isSmall && !(obr && obr.width <= e.width)) return e;   // a larger variant will come
                if (!saveimagecache2[url_image]) {
                    const base = pickTextureName(imagemodel, url_image);
                    let texName = base, n = 1;
                    while (_usedTextureNames[texName]) texName = `${base}_${n++}`;
                    _usedTextureNames[texName] = true;
                    saveimagecache2[url_image] = { name: texName };
                }
                return obr;
            }
        } catch (e2) { warn('drawhookcanvas', e2.message); }
        return e;
    };

    window.drawhookimg = (gl, t) => {
        try {
            const url = t[5].currentSrc, width = t[5].width, height = t[5].height;
            if (!saveimagecache2[url]) return;
            if (saveimagecache2[url].dataURL) return;
            const data = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
            const hh = height / 2 | 0, bpr = width * 4, temp = new Uint8Array(width * 4);
            for (let y = 0; y < hh; ++y) {
                const t0 = y * bpr, b0 = (height - y - 1) * bpr;
                temp.set(data.subarray(t0, t0 + bpr));
                data.copyWithin(t0, b0, b0 + bpr);
                data.set(temp, b0);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            const id = ctx.createImageData(width, height);
            id.data.set(data);
            ctx.putImageData(id, 0, 0);
            const isJpeg = /\.(jpe?g)(?:\?|$)/i.test(url);
            const mime   = isJpeg ? 'image/jpeg' : 'image/png';
            const ext    = isJpeg ? '.jpg' : '.png';
            const q      = isJpeg ? 0.92 : undefined;
            const name   = saveimagecache2[url].name + ext;
            saveimagecache2[url].fileExt = ext;
            saveimagecache2[url].dataURL = true;   // capture flag only (a base64 copy was never read)
            canvas.toBlob((b) => { objects[name] = b; }, mime, q);
        } catch (e) { warn('drawhookimg', e.message); }
    };

    // ====================================================================
    // attachbody
    // ====================================================================
    function geomKey(o, noIndices) {
        const v = o && o._attributes && o._attributes.Vertex && o._attributes.Vertex._elements;
        if (!v || !v.length) return '';
        let n = v.length, parts = [n], k;
        for (k = 0; k < 16; k++) parts.push(v[Math.floor(k * (n - 1) / 15)]);
        if (!noIndices) {
            const pr = o._primitives && o._primitives[0];
            parts.push(pr && pr.indices && pr.indices._elements ? pr.indices._elements.length : -1);
        }
        return parts.join(',');
    }

    // The viewer can hold a second copy of a mesh that only has LINES (its wireframe display).
    // It has the same vertices as the real mesh but no triangles. Returns the index of the real
    // mesh when obj is such an overlay, otherwise -1. A line mesh with no twin is real and is kept.
    function wireOverlayTwin(list, idx) {
        let obj = list[idx], prims = obj && obj._primitives, i, p, hasLines = false, key;
        if (!prims || !prims.length) return -1;
        for (i = 0; i < prims.length; i++) {
            p = prims[i];
            if (!p || !p.indices) continue;
            if (p.mode === 1 || p.mode === 2 || p.mode === 3) hasLines = true;
            else return -1;   // has a triangle (or point) primitive: not an overlay
        }
        if (!hasLines) return -1;
        key = geomKey(obj, true);
        if (!key) return -1;
        for (i = 0; i < list.length; i++) {
            let o2 = list[i], pr2 = o2 && o2._primitives, j, tri = false;
            if (i === idx || !pr2 || geomKey(o2, true) !== key) continue;
            for (j = 0; j < pr2.length; j++) {
                const m2 = pr2[j] && pr2[j].mode;
                if (pr2[j] && pr2[j].indices && (m2 === undefined || m2 === null || m2 === 4 || m2 === 5 || m2 === 6)) tri = true;
            }
            if (tri) return i;
        }
        return -1;
    }

    // Keyframe reduction. Keeps the first and last key, and every key that is needed so that
    // interpolation between the kept keys stays within tol of each recorded sample (per component).
    // Rotations (isQuat) are checked with slerp, as glTF interpolates them. A segment spans at most
    // maxSpan recorded frames, which limits the run time. Returns the indices of the kept keys.
    function reduceKeys(times, vals, n, tol, isQuat, maxSpan) {
        let nk = times.length, keep = [0], i = 0, j, k, c, ok, best, tmp = [0, 0, 0, 0];
        if (nk < 3) { for (k = 1; k < nk; k++) keep.push(k); return keep; }
        function interp(a, b, u) {
            const ia = a * n, ib = b * n;
            if (isQuat && n === 4) {
                let dt = vals[ia] * vals[ib] + vals[ia + 1] * vals[ib + 1] + vals[ia + 2] * vals[ib + 2] + vals[ia + 3] * vals[ib + 3];
                let sg = dt < 0 ? -1 : 1, w0, w1;
                dt = Math.abs(dt);
                if (dt > 0.9995) { w0 = 1 - u; w1 = u; }
                else {
                    const th = Math.acos(Math.min(1, dt)), sn = Math.sin(th);
                    w0 = Math.sin((1 - u) * th) / sn; w1 = Math.sin(u * th) / sn;
                }
                let len = 0;
                for (c = 0; c < 4; c++) { tmp[c] = w0 * vals[ia + c] + sg * w1 * vals[ib + c]; len += tmp[c] * tmp[c]; }
                len = Math.sqrt(len) || 1;
                for (c = 0; c < 4; c++) tmp[c] /= len;
            } else {
                for (c = 0; c < n; c++) tmp[c] = vals[ia + c] + (vals[ib + c] - vals[ia + c]) * u;
            }
        }
        while (i < nk - 1) {
            best = i + 1;
            for (j = i + 2; j < nk && j - i <= maxSpan; j++) {
                ok = true;
                const span = times[j] - times[i];
                for (k = i + 1; k < j && ok; k++) {
                    interp(i, j, span > 0 ? (times[k] - times[i]) / span : 0);
                    for (c = 0; c < n; c++) if (Math.abs(tmp[c] - vals[k * n + c]) > tol) { ok = false; break; }
                }
                if (!ok) break;
                best = j;
            }
            keep.push(best);
            i = best;
        }
        return keep;
    }

    // Remove nodes (the skipped wireframe overlay) and renumber every reference to a node.
    // Changes the list in place and returns the new index of the scene root.
    function removeNodes(nodes, skins, animations, drop, rootIdx) {
        let remap = [], kept = [], i;
        for (i = 0; i < nodes.length; i++) {
            if (drop[i]) remap.push(-1);
            else { remap.push(kept.length); kept.push(nodes[i]); }
        }
        kept.forEach((n) => {
            if (!n.children) return;
            const c2 = [];
            n.children.forEach((c) => { if (remap[c] >= 0) c2.push(remap[c]); });
            n.children = c2;
        });
        skins.forEach((sk) => {
            sk.joints = sk.joints.map((j) => remap[j]);
            if (typeof sk.skeleton === 'number') sk.skeleton = remap[sk.skeleton];
        });
        (animations || []).forEach((a) => {
            a.channels.forEach((c) => {
                if (c.target && typeof c.target.node === 'number') c.target.node = remap[c.target.node];
            });
        });
        nodes.length = 0;
        kept.forEach((n) => { nodes.push(n); });
        return remap[rootIdx];
    }

    window.attachbody = (obj) => {
        try {
            if (!obj || obj._faked === true) return;
            const name = obj._name;
            const ssName = obj.stateset && obj.stateset._name;
            const pName = (obj._parents && obj._parents.length > 0 && obj._parents[0] && obj._parents[0]._name) || null;
            if (!name && !ssName && !pName) return;
            obj._faked = true;
            if (name === 'composer layer' || name === 'Ground - Geometry') return;
            
            // Dedupe: viewer re-instantiates meshes when WebGL contexts
            // get recycled. A new obj has _faked = false again, so the
            // basic guard doesn't catch it. Merge by name + vertex count.
            // M_Patriot_Radar_Tires legitimately appears twice with
            // DIFFERENT vertex counts, so this won't merge them.
            const displayName = ssName || name || '';
            const vcount = (obj._attributes && obj._attributes.Vertex &&
                        obj._attributes.Vertex._elements)
                        ? obj._attributes.Vertex._elements.length : 0;
            // Name + vertex count alone is not enough: big models are split into unnamed chunks that
            // often have the same vertex count (e.g. 65532), so also compare sampled vertex data.
            const gk = geomKey(obj);
            for (let i = 0; i < window.allmodel.length; i++) {
                const ex = window.allmodel[i];
                if (!ex) continue;
                const exName = (ex.stateset && ex.stateset._name) || ex._name || '';
                if (exName !== displayName) continue;
                const exVcount = (ex._attributes && ex._attributes.Vertex &&
                                ex._attributes.Vertex._elements)
                            ? ex._attributes.Vertex._elements.length : 0;
                if (exVcount === vcount && geomKey(ex) === gk) {
                    // Same name + vertex count but a different world position may be a
                    // genuine second instance (e.g. repeated parts), not a re-instantiation.
                    // Animated parents also move a mesh, so by default this only warns and
                    // still merges (unchanged behaviour). Set DEDUPE_STRICT_WORLD to keep both.
                    let wNew = computeWorldMatrix(obj), wEx = computeWorldMatrix(ex), wd = 0;
                    for (let wi = 12; wi < 15; wi++) wd = Math.max(wd, Math.abs(wNew[wi] - wEx[wi]));
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
        let attr = obj && obj._attributes, n = 0;
        if (!attr) return 0;
        for (let k in attr) {
            if (!attr.hasOwnProperty(k)) continue;
            const m = /^Vertex_(\d+)$/.exec(k);
            if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
        }
        return n;
    }

    function unitNormals(a) {
        let o = new Float32Array(a.length), i, x, y, z, l;
        for (i = 0; i + 2 < a.length; i += 3) {
            x = a[i]; y = a[i + 1]; z = a[i + 2];
            l = Math.sqrt(x * x + y * y + z * z);
            if (l > 1e-12) { o[i] = x / l; o[i + 1] = y / l; o[i + 2] = z / l; }
            else { o[i] = 0; o[i + 1] = 1; o[i + 2] = 0; }
        }
        return o;
    }

    function snapshotFrame() {
        const meshesOut = [];
        window.allmodel.forEach((obj) => {
            const world = computeWorldMatrix(obj);
            let wts = null;
            try {
                const nT = morphTargetCount(obj);
                if (nT && obj._targetWeights) {
                    wts = new Float32Array(nT);
                    for (let wi = 0; wi < nT; wi++) wts[wi] = obj._targetWeights[wi] || 0;
                }
            } catch (e) {}
            let pal = null;
            try {
                const impl = obj._rigTransformImplementation;
                if (impl && impl._skinningAttribute && impl._skinningAttribute._matrixPalette) {
                    const src = impl._skinningAttribute._matrixPalette;
                    pal = new Float32Array(src.length);
                    for (let i = 0; i < src.length; i++) pal[i] = src[i];
                }
            } catch (e) {}
            meshesOut.push({ world, palette: pal, weights: wts });
        });
        return { meshes: meshesOut };
    }

    // True when a frame at time t should be kept for the chosen RECORD_FPS (0 = keep every frame).
    function fpsDue(t, lastT) {
        const f = +CONFIG.RECORD_FPS || 0;
        return lastT < 0 || f <= 0 || t - lastT >= 1 / f - Math.min(0.004, 0.25 / f);   // tolerance for rAF jitter
    }

    // Single-clip RECORD with exactly one active clip: restart that clip and record
    // exactly one loop (0..duration) automatically. Returns false when that is not
    // possible, so the caller falls back to the manual timed recording.
    function startAutoSingleRecording() {
        const mgr = findAnimationManager();
        if (!mgr) return false;
        const act = activeClipUids(mgr);
        if (act.length !== 1) return false;
        const inst = mgr._instanceAnimations[act[0]];
        if (!inst || !(inst.duration > 0)) return false;
        const def = { uid: act[0], name: inst.name || act[0], duration: inst.duration };
        window.animationRecording = true;
        window.autoRecordActive = true;
        window.clipCancel = false;
        window.recordedFrames = [];
        if (window.clips && window.clips.length) {
            log(`single-clip record: discarded ${window.clips.length} stored multi-clip recording(s)`);
        }
        window.clips = [];
        setRecLabel('STOP');
        const base = inst.start || 0;
        log(`auto record: one full loop of the active clip (${def.duration.toFixed(2)}s)`);
        try { mgr.setSeekTime(base); } catch (e) {
            err('auto record seek', e.message);
            window.animationRecording = false; window.autoRecordActive = false; setRecLabel('RECORD');
            return false;
        }
        function done(frames) {
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
        }
        waitFrames(CONFIG.CLIP_SETTLE_FRAMES, () => {
            try { recordClipRealtime(mgr, def, base, done); } catch (e) { err('auto record', e.message); done([]); }
        });
        return true;
    }

    function startRecording() {
        if (window.animationRecording || window.clipRecording) return;
        if (_exporting) { warn('export is running: wait for "export done" before recording'); return; }
        if (startAutoSingleRecording()) return;
        window.animationRecording = true;
        window.recordedFrames = [];
        // A fresh single-clip recording must win at export time. Stale multi-clip
        // data from an earlier RECORD ALL CLIPS run would otherwise override it.
        if (window.clips && window.clips.length) {
            log(`single-clip record: discarded ${window.clips.length} stored multi-clip recording(s)`);
        }
        window.clips = [];
        window.recordingStartTime = performance.now() / 1000;
        setRecLabel('STOP');
        log(`recording started (max ${CONFIG.MAX_RECORD_SECONDS}s)`);
        function tick() {
            if (!window.animationRecording) return;
            const t = performance.now() / 1000 - window.recordingStartTime;
            const rf = window.recordedFrames;
            if (fpsDue(t, rf.length ? rf[rf.length - 1].time : -1)) {
                rf.push({ time: t, meshes: snapshotFrame().meshes });
            }
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
        const el = document.getElementById('recBtnLabel');
        if (el) el.textContent = text;
    }

    // ====================================================================
    // Animation clips
    // ====================================================================
    let _clipMgrCache = null;

    function findAnimationManager() {
        if (_clipMgrCache && _clipMgrCache._instanceAnimations) return _clipMgrCache;
        let cur = window.allmodel[0], guard = 0;
        while (cur && guard++ < 64) {
            const cbs = cur._updateCallbacks || [];
            for (let i = 0; i < cbs.length; i++) {
                const c = cbs[i];
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
        const mgr = findAnimationManager();
        return mgr ? Object.keys(mgr._instanceAnimations).length : 0;
    }

    function waitFrames(n, cb) {
        if (n <= 0) { cb(); return; }
        requestAnimationFrame(() => { waitFrames(n - 1, cb); });
    }

    function activeClipUids(mgr) {
        const out = [];
        const list = mgr._activeAnimationList || [];
        for (let i = 0; i < list.length; i++) out.push(list[i].name);
        return out;
    }

    // UI class names can change; try the known selector first, then looser ones.
    // Non-clip items are harmless: discovery skips any item that activates no clip.
    const CLIP_ITEM_SELECTORS = [
        '.animation-list .animation-item',
        '[class*="animation"][class*="list"] li',
        'li[class*="animation-item"]'
    ];

    function getClipItems() {
        for (let s = 0; s < CLIP_ITEM_SELECTORS.length; s++) {
            const found = document.querySelectorAll(CLIP_ITEM_SELECTORS[s]);
            if (found.length) return found;
        }
        return [];
    }

    // Click list item k (the viewer does its own stop/start) and wait.
    function selectClipItem(k, cb) {
        const items = getClipItems();
        if (!items[k]) { cb(false); return; }
        // Drain any start queued earlier (e.g. by a stray playAnimation call). The
        // manager flushes _startAnimations on its next update, and a leftover shows up
        // as an extra active clip. stopAllAnimation() does NOT clear this queue.
        const mgr = findAnimationManager();
        if (mgr && mgr._startAnimations) mgr._startAnimations = {};
        try { items[k].click(); } catch (e) { warn('clip item click', e.message); cb(false); return; }
        waitFrames(6, () => { cb(true); });
    }

    // Clicks every list item and reads which clip UID became active.
    // cb(defs, origIdx): defs = [{ index, uid, name, duration }];
    // origIdx = list item that was selected before discovery (restored at the end).
    function discoverAnimationClips(cb) {
        const mgr = findAnimationManager();
        const count = getClipItems().length;
        if (!mgr || !count) {
            warn(`clip discovery: manager=${!!mgr} listItems=${count}`);
            cb([], 0);
            return;
        }
        const origUid = activeClipUids(mgr)[0] || null;
        let defs = [], noClipIdx = -1, i = 0;

        function next() {
            if (i >= count) { finish(); return; }
            const k = i++;
            selectClipItem(k, (ok) => {
                if (!ok) { next(); return; }
                const li = getClipItems()[k];
                if (!li) { warn(`clip list item ${k} vanished during discovery, skipped`); next(); return; }
                const name = (li.textContent || '').trim().replace(/\s+/g, ' ');
                const act = activeClipUids(mgr);
                if (act.length === 1) {
                    const inst = mgr._instanceAnimations[act[0]];
                    defs.push({ index: k, uid: act[0], name,
                                duration: inst ? inst.duration : 0 });
                } else if (act.length === 0) {
                    noClipIdx = k;
                    log(`list item ${k} "${name}" has no clip (treated as the Static Pose item)`);
                } else {
                    warn(`list item ${k} "${name}" activated ${act.length} clips, skipped`);
                }
                next();
            });
        }

        function finish() {
            window.clipStaticIdx = noClipIdx;
            let origIdx = (noClipIdx >= 0) ? noClipIdx : 0;
            for (let d = 0; d < defs.length; d++) {
                if (defs[d].uid === origUid) { origIdx = defs[d].index; break; }
            }
            selectClipItem(origIdx, () => {
                window.clipDefs = defs;
                log(`discovered ${defs.length} clips`);
                for (let q = 0; q < defs.length; q++) {
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
        const hasSimClock = typeof mgr.getSimulationTime === 'function';
        let wall0 = performance.now() / 1000, sim0 = null, lastT = -1, lastSeen = -1, frames = [];
        let useSim = hasSimClock;
        function clockNow() {
            if (useSim) {
                const s = mgr.getSimulationTime();
                if (typeof s === 'number' && isFinite(s)) {
                    if (sim0 === null) sim0 = s;
                    return s - sim0;
                }
                warn(`sim clock returned ${s}, falling back to wall clock`);
                useSim = false;
                wall0 = performance.now() / 1000 - (lastT > 0 ? lastT : 0);
            }
            return performance.now() / 1000 - wall0;
        }
        // Samples cover [0, duration). The closing frame at t = duration is a copy
        // of frame 0 (the clip loops). We never keep a sample taken at or past the
        // end: in "Play all" mode the viewer may already have switched clips there.
        let finished = false;
        function finish(why) {
            if (finished) return;
            finished = true;
            if (!why && frames.length && frames[frames.length - 1].time < def.duration - 1e-4) {
                frames.push({ time: def.duration, meshes: frames[0].meshes });
            }
            if (why) warn(`clip ${def.name}: ${why}, frames=${frames.length}`);
            cb(frames);
        }
        function tick() {
            try { tickBody(); } catch (e) {
                err(`clip ${def.name} tick`, e.message);
                finish('error, truncated');
            }
        }
        function tickBody() {
            if (window.clipCancel) { finish('cancelled'); return; }
            const t = clockNow();
            if (t >= def.duration) { finish(null); return; }
            const act = activeClipUids(mgr);
            if (act.length !== 1 || act[0] !== def.uid) {
                // "Play all" advances to the next clip as this one ends, and the sim
                // clock restarts. If we already have (almost) the whole clip, that is
                // the normal end, not a problem.
                if (lastT >= def.duration - 0.1 || lastSeen >= def.duration - 0.1) {
                    log(`clip ${def.name}: viewer moved to the next clip at the end, frames=${frames.length}`);
                    finish(null);
                    return;
                }
                finish('active clip changed mid-recording at t=' + t.toFixed(3) +
                       ' (active=' + act.join(',') + '), truncated');
                return;
            }
            // Keep times strictly increasing (a paused/stuck clock repeats values).
            if (t > lastT && fpsDue(t, lastT)) {
                frames.push({ time: t, meshes: snapshotFrame().meshes });
                lastT = t;
            }
            // Safety net: sim clock stuck, so end by wall time instead of looping forever.
            if (performance.now() / 1000 - wall0 > def.duration + 3) {
                finish(`clock stalled at t=${t.toFixed(3)}`);
                return;
            }
            lastSeen = t;   // last clock value seen (kept or skipped by RECORD_FPS), for end-of-clip detection
            requestAnimationFrame(tick);
        }
        log(`clip clock: ${useSim ? 'manager simulation time' : 'wall clock'} (${def.name})`);
        requestAnimationFrame(tick);
    }

    function recordClip(mgr, def, cb) {
        selectClipItem(def.index, (ok) => {
            const act = activeClipUids(mgr);
            if (!ok || act.length !== 1 || act[0] !== def.uid) {
                warn(`clip switch failed: ${def.name} active=${act.join(',')}`);
                cb(null);
                return;
            }
            const inst = mgr._instanceAnimations[def.uid];
            const base = (inst && inst.start) || 0;
            // Real-time capture only: seek-based sampling while paused updates the
            // palette too sparsely on this viewer. Seek to the clip start, let it
            // settle, then record while the clip plays.
            try {
                if (!mgr._pause) mgr.togglePause();
                mgr.setSeekTime(base);
            } catch (e) { err(`clip seek ${def.name}`, e.message); cb(null); return; }
            waitFrames(CONFIG.CLIP_SETTLE_FRAMES, () => {
                try { recordClipRealtime(mgr, def, base, cb); } catch (e) { err(`clip record ${def.name}`, e.message); cb(null); }
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
        selectClipItem(window.clipStaticIdx, (ok) => {
            const act = activeClipUids(mgr);
            if (!ok || act.length) {
                warn(`static pose: selecting the item failed or left clips active (${act.length})`);
                cb();
                return;
            }
            // The viewer may skip updates while paused with no clip; let it run briefly.
            if (mgr._pause) mgr.togglePause();
            waitFrames(6, () => {
                const snapA = snapshotFrame();
                waitFrames(3, () => {
                    let snapB = snapshotFrame(), moved = 0;
                    for (let m = 0; m < snapA.meshes.length; m++) {
                        const pa = snapA.meshes[m].palette, pb = snapB.meshes[m] && snapB.meshes[m].palette;
                        if (!pa || !pb) continue;
                        for (let i = 0; i < pa.length; i++) {
                            if (Math.abs(pa[i] - pb[i]) > 1e-5) { moved++; break; }
                        }
                    }
                    if (moved) warn(`static pose: ${moved} mesh palette(s) still changing; using the later snapshot`);
                    window.staticPoseSnapshot = snapB;
                    log(`static pose captured, meshes=${snapB.meshes.length}`);
                    cb();
                });
            });
        });
    }

    function setRecAllLabel(text) {
        const el = document.getElementById('recAllBtn');
        if (el) el.textContent = text;
    }

    function endRecordAll(mgr, wasPaused, origIdx) {
        function reset() {
            window.clipRecording = false;
            window.clipCancel = false;
            window.clipProgress = '';
            setRecAllLabel('RECORD ALL CLIPS');
            log(`record-all finished, clips recorded: ${window.clips.length}`);
        }
        try {
            selectClipItem(origIdx, () => {
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
        if (_exporting) { warn('export is running: wait for "export done" before recording'); return; }
        const mgr = findAnimationManager();
        if (!mgr) { warn('no animation manager found; use RECORD (single clip)'); return; }
        window.clipRecording = true;
        window.clips = [];
        window.recordedFrames = [];   // a stale single recording must not win over the new clips
        window.clipCancel = false;
        setRecAllLabel('CANCEL');
        const wasPaused = mgr._pause;
        log('record-all started, clips in manager: ' + getClipCount() +
            ', fps ' + (+CONFIG.RECORD_FPS > 0 ? CONFIG.RECORD_FPS : 'every frame') + ' (keep this tab visible: a hidden tab pauses rendering and frames are skipped)');
        let safeOrigIdx = 0;
        try {
        discoverAnimationClips((defs, origIdx) => {
            safeOrigIdx = origIdx;
            if (defs.length < 2) {
                warn(`only ${defs.length} usable clip(s); single-clip path stays in use`);
                endRecordAll(mgr, wasPaused, origIdx);
                return;
            }
            let i = 0;
            function nextClip() {
                if (i >= defs.length || window.clipCancel) {
                    if (window.clipCancel) warn(`record-all cancelled, keeping ${window.clips.length} recorded clip(s)`);
                    endRecordAll(mgr, wasPaused, origIdx);
                    return;
                }
                const d = defs[i++];
                window.clipProgress = `${i}/${defs.length}`;
                try {
                recordClip(mgr, d, (frames) => {
                    if (window.clipCancel) {
                        warn(`clip discarded (cancelled): ${d.name}`);
                    } else if (frames && frames.length > 1) {
                        window.clips.push({ name: d.name, uid: d.uid, frames });
                        log(`clip recorded: ${d.name} frames=${frames.length}`);
                    } else {
                        warn(`clip skipped: ${d.name}`);
                    }
                    nextClip();
                });
                } catch (e) {
                    err(`record-all clip ${d.name}`, e.message);
                    endRecordAll(mgr, wasPaused, origIdx);
                }
            }
            captureStaticPose(mgr, () => { nextClip(); });
        });
        } catch (e) {
            err('record-all', e.message);
            endRecordAll(mgr, wasPaused, safeOrigIdx);
        }
    }

    // ====================================================================
    // UI panel
    // ====================================================================
    // A hidden tab stops requestAnimationFrame: the viewer stops rendering and recording skips frames.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && (window.animationRecording || window.clipRecording)) {
            warn('tab hidden during recording: rendering pauses, frames will be skipped or the clip may be truncated; keep the tab visible');
        }
    });

    function addbtnfunc() {
        if (button_dw) return;
        if (!document.body) { setTimeout(addbtnfunc, 500); return; }
        if (document.getElementById('ripper-panel')) { button_dw = true; return; }

        const panel = document.createElement('div');
        panel.id = 'ripper-panel';
        panel.style.cssText = [
            'position:fixed', 'top:70px', 'right:16px', 'z-index:2147483647',
            'background:rgba(20,20,20,0.9)', 'border:1px solid #444', 'border-radius:8px',
            'padding:8px', 'font-family:monospace', 'font-size:12px', 'color:#eee',
            'display:flex', 'flex-direction:column', 'gap:6px', 'min-width:150px',
            'box-shadow:0 4px 16px rgba(0,0,0,0.5)'
        ].join(';');

        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding-bottom:4px;border-bottom:1px solid #444;';

        const title = document.createElement('div');
        title.textContent = 'MODEL RIPPER';
        title.style.cssText = 'font-weight:bold;color:#f80;cursor:move;user-select:none;flex:1;text-align:left;';
        titleRow.appendChild(title);

        const gear = document.createElement('span');
        gear.textContent = '⚙';
        gear.title = 'Settings';
        gear.style.cssText = 'cursor:pointer;color:#aaa;font-size:14px;padding:0 4px;user-select:none;';
        titleRow.appendChild(gear);

        panel.appendChild(titleRow);

        const btnDL = document.createElement('button');
        btnDL.textContent = 'DOWNLOAD GLB';
        btnDL.style.cssText = 'padding:6px 10px;background:#c22;color:#fff;border:0;border-radius:4px;cursor:pointer;font-family:monospace;font-size:12px;';
        btnDL.addEventListener('click', () => { downloadGLB(); });
        panel.appendChild(btnDL);

        const btnRec = document.createElement('button');
        btnRec.id = 'recBtnLabel';
        btnRec.textContent = 'RECORD';
        btnRec.style.cssText = btnDL.style.cssText;
        btnRec.addEventListener('click', () => {
            if (!window.animationRecording) startRecording(); else stopRecording();
        });
        panel.appendChild(btnRec);

        const btnAll = document.createElement('button');
        btnAll.id = 'recAllBtn';
        btnAll.textContent = 'RECORD ALL CLIPS';
        btnAll.style.cssText = btnDL.style.cssText;
        btnAll.addEventListener('click', () => {
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
            let n = 0;
            try { n = getClipCount(); } catch (e) {}
            const off = n < 2;
            btnAll.disabled = off;
            btnAll.style.opacity = off ? '0.4' : '1';
            btnAll.style.cursor = off ? 'not-allowed' : 'pointer';
            btnAll.title = off ? (n === 1 ? 'Only one clip: use RECORD (records one full loop automatically)' : 'No animation clips found yet') : '';
        }
        refreshAllBtn();
        setInterval(refreshAllBtn, 2000);

        const status = document.createElement('div');
        status.id = 'ripper-status';
        status.style.cssText = 'font-size:10px;color:#aaa;text-align:center;';
        status.textContent = 'idle';
        panel.appendChild(status);

        // ---- config form (hidden until gear clicked) ----
        const configDiv = document.createElement('div');
        configDiv.id = 'ripper-config';
        configDiv.style.cssText = 'display:none;flex-direction:column;gap:5px;padding-top:5px;border-top:1px solid #444;font-size:11px;';

        const row1 = document.createElement('div');
        row1.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label1 = document.createElement('span');
        label1.textContent = 'Max seconds:';
        label1.title = 'Stops a manual recording after this time. RECORD and RECORD ALL CLIPS stop by themselves at the end of each clip.';
        row1.appendChild(label1);
        const input1 = document.createElement('input');
        input1.type = 'number';
        input1.min = '1';
        input1.max = '60';
        input1.value = CONFIG.MAX_RECORD_SECONDS;
        input1.style.cssText = 'width:52px;background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        input1.addEventListener('change', () => {
            let v = parseInt(input1.value, 10);
            if (isNaN(v) || v < 1) v = 1;
            if (v > 60) v = 60;
            input1.value = v;
            CONFIG.MAX_RECORD_SECONDS = v;
            saveConfig();
        });
        row1.appendChild(input1);
        configDiv.appendChild(row1);

        const rowF = document.createElement('div');
        rowF.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const labelF = document.createElement('span');
        labelF.textContent = 'Record FPS:';
        labelF.title = 'Frames per second in the recording. Max records every frame the viewer draws. Lower values make smaller files.';
        rowF.appendChild(labelF);
        const selF = document.createElement('select');
        selF.style.cssText = 'background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        [[0, 'Max (every frame)'], [60, '60'], [30, '30'], [24, '24'], [15, '15']].forEach((o) => {
            const op = document.createElement('option');
            op.value = String(o[0]); op.textContent = o[1];
            if ((+CONFIG.RECORD_FPS || 0) === o[0]) op.selected = true;
            selF.appendChild(op);
        });
        selF.addEventListener('change', () => {
            CONFIG.RECORD_FPS = parseInt(selF.value, 10) || 0;
            saveConfig();
            log(`record fps set to ${CONFIG.RECORD_FPS || 'every frame'}`);
        });
        rowF.appendChild(selF);
        configDiv.appendChild(rowF);

        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label2 = document.createElement('span');
        label2.textContent = 'Auto-reload:';
        label2.title = 'On: reloads the page one time if the script cannot connect to the viewer. Off: no reload.';
        row2.appendChild(label2);
        const check2 = document.createElement('input');
        check2.type = 'checkbox';
        check2.checked = CONFIG.AUTO_RELOAD_ON_FAILURE;
        check2.addEventListener('change', () => {
            CONFIG.AUTO_RELOAD_ON_FAILURE = check2.checked;
            saveConfig();
        });
        row2.appendChild(check2);
        configDiv.appendChild(row2);

        const row5 = document.createElement('div');
        row5.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label5 = document.createElement('span');
        label5.textContent = 'Double sided:';
        label5.title = 'On: materials show both sides, as in the viewer. Off: materials show the front side only.';
        row5.appendChild(label5);
        const check5 = document.createElement('input');
        check5.type = 'checkbox';
        check5.checked = !!CONFIG.DOUBLE_SIDED;
        check5.addEventListener('change', () => {
            CONFIG.DOUBLE_SIDED = check5.checked;
            saveConfig();
            log(`double sided set to ${check5.checked}`);
        });
        row5.appendChild(check5);
        configDiv.appendChild(row5);

        const row5b = document.createElement('div');
        row5b.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label5b = document.createElement('span');
        label5b.textContent = 'Auto single sided (viewer flag):';
        label5b.title = 'On: a material that the viewer shows single sided stays single sided. Off: the Double sided setting applies to all materials.';
        row5b.appendChild(label5b);
        const check5b = document.createElement('input');
        check5b.type = 'checkbox';
        check5b.checked = !!CONFIG.DOUBLE_SIDED_AUTO;
        check5b.addEventListener('change', () => {
            CONFIG.DOUBLE_SIDED_AUTO = check5b.checked;
            saveConfig();
            log(`auto single sided set to ${check5b.checked}`);
        });
        row5b.appendChild(check5b);
        configDiv.appendChild(row5b);

        const row5c = document.createElement('div');
        row5c.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label5c = document.createElement('span');
        label5c.textContent = 'Drop strip slivers (stripes):';
        label5c.title = 'On: removes long thin triangles that connect separate parts of a mesh. Off: keeps all triangles.';
        row5c.appendChild(label5c);
        const check5c = document.createElement('input');
        check5c.type = 'checkbox';
        check5c.checked = !!CONFIG.DROP_STRIP_SLIVERS;
        check5c.addEventListener('change', () => {
            CONFIG.DROP_STRIP_SLIVERS = check5c.checked;
            saveConfig();
            log(`drop strip slivers set to ${check5c.checked}`);
        });
        row5c.appendChild(check5c);
        configDiv.appendChild(row5c);

        const row5d = document.createElement('div');
        row5d.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label5d = document.createElement('span');
        label5d.textContent = 'Reduce keyframes:';
        label5d.title = 'On: leaves out animation keys that the keys before and after them already give. The file is about half as large. Off: keeps every recorded frame.';
        row5d.appendChild(label5d);
        const check5d = document.createElement('input');
        check5d.type = 'checkbox';
        check5d.checked = !!CONFIG.REDUCE_KEYS;
        check5d.addEventListener('change', () => {
            CONFIG.REDUCE_KEYS = check5d.checked;
            saveConfig();
            log(`reduce keyframes set to ${check5d.checked}`);
        });
        row5d.appendChild(check5d);
        configDiv.appendChild(row5d);

        const row5e = document.createElement('div');
        row5e.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label5e = document.createElement('span');
        label5e.textContent = 'Keep still clips:';
        label5e.title = 'On: a clip in which no joint moves (a pose clip) is exported as a pose of the skeleton. Off: such clips are left out of the file.';
        row5e.appendChild(label5e);
        const check5e = document.createElement('input');
        check5e.type = 'checkbox';
        check5e.checked = !!CONFIG.KEEP_STILL_CLIPS;
        check5e.addEventListener('change', () => {
            CONFIG.KEEP_STILL_CLIPS = check5e.checked;
            saveConfig();
            log(`keep still clips set to ${check5e.checked}`);
        });
        row5e.appendChild(check5e);
        configDiv.appendChild(row5e);

        const row6 = document.createElement('div');
        row6.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label6 = document.createElement('span');
        label6.textContent = 'Vertex color sRGB>linear:';
        label6.title = 'On: converts vertex colors to linear color, as glTF requires. The colors then look as in the viewer. Off: writes the colors unchanged.';
        row6.appendChild(label6);
        const check6 = document.createElement('input');
        check6.type = 'checkbox';
        check6.checked = !!CONFIG.VERTEX_COLOR_SRGB;
        check6.addEventListener('change', () => {
            CONFIG.VERTEX_COLOR_SRGB = check6.checked;
            saveConfig();
            log(`vertex color sRGB->linear set to ${check6.checked}`);
        });
        row6.appendChild(check6);
        configDiv.appendChild(row6);

        const row7 = document.createElement('div');
        row7.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label7 = document.createElement('span');
        label7.textContent = 'Flat metal/rough from viewer:';
        label7.title = 'On: materials without textures use the metalness and roughness of the viewer. Off: metalness 0, roughness 0.5.';
        row7.appendChild(label7);
        const check7 = document.createElement('input');
        check7.type = 'checkbox';
        check7.checked = !!CONFIG.FLAT_MR_FROM_VIEWER;
        check7.addEventListener('change', () => {
            CONFIG.FLAT_MR_FROM_VIEWER = check7.checked;
            saveConfig();
            log(`flat metal/rough from viewer set to ${check7.checked}`);
        });
        row7.appendChild(check7);
        configDiv.appendChild(row7);

        const row8 = document.createElement('div');
        row8.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label8 = document.createElement('span');
        label8.textContent = 'Export scale:';
        label8.title = 'Multiplies the size of the whole model. Use 0.01 for a model in centimeters.';
        row8.appendChild(label8);
        const input8 = document.createElement('input');
        input8.type = 'number';
        input8.step = 'any';
        input8.min = '0.0001';
        input8.value = CONFIG.EXPORT_SCALE;
        input8.style.cssText = 'width:64px;background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        input8.addEventListener('change', () => {
            let v = parseFloat(input8.value);
            if (isNaN(v) || v <= 0) v = 1;
            input8.value = v;
            CONFIG.EXPORT_SCALE = v;
            saveConfig();
            log(`export scale set to ${v}`);
        });
        row8.appendChild(input8);
        configDiv.appendChild(row8);

        const row3 = document.createElement('div');
        row3.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label3 = document.createElement('span');
        label3.textContent = 'MR format:';
        label3.title = 'File format of the merged metallic-roughness textures. JPEG: smaller files. PNG: no quality loss.';
        row3.appendChild(label3);
        const sel3 = document.createElement('select');
        sel3.style.cssText = 'background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        [['jpeg','JPEG (small)'], ['png','PNG (lossless)']].forEach((opt) => {
            const o = document.createElement('option');
            o.value = opt[0];
            o.textContent = opt[1];
            if (CONFIG.MR_TEXTURE_FORMAT === opt[0]) o.selected = true;
            sel3.appendChild(o);
        });
        sel3.addEventListener('change', () => {
            CONFIG.MR_TEXTURE_FORMAT = sel3.value;
            saveConfig();
        });
        row3.appendChild(sel3);
        configDiv.appendChild(row3);

        const row4 = document.createElement('div');
        row4.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:6px;';
        const label4 = document.createElement('span');
        label4.textContent = 'Rest pose:';
        label4.title = 'Sets the rest pose of the skeleton. Clip 1st frame: the first recorded frame. Static Pose: the Static Pose of the viewer.';
        row4.appendChild(label4);
        const sel4 = document.createElement('select');
        sel4.style.cssText = 'background:#222;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
        [['clip0','Clip 1st frame'], ['static','Static Pose']].forEach((opt) => {
            const o = document.createElement('option');
            o.value = opt[0];
            o.textContent = opt[1];
            if (CONFIG.REST_POSE_SOURCE === opt[0]) o.selected = true;
            sel4.appendChild(o);
        });
        sel4.addEventListener('change', () => {
            CONFIG.REST_POSE_SOURCE = sel4.value;
            saveConfig();
            log(`rest pose source set to ${sel4.value}`);
        });
        row4.appendChild(sel4);
        configDiv.appendChild(row4);

        panel.appendChild(configDiv);

        gear.addEventListener('click', () => {
            configDiv.style.display = configDiv.style.display === 'none' ? 'flex' : 'none';
        });

        document.body.appendChild(panel);
        button_dw = true;
        log('panel added');

        // Warn if the bad bundle was served. After 8s, show hint. After
        // 12s, auto-reload once (guarded by sessionStorage so we don't loop).
        setTimeout(() => {
            if (window._anyAnchorsMatched) return;
            const s = document.getElementById('ripper-status');
            if (s) {
                s.textContent = '⚠ no anchors — reload page';
                s.style.color = '#f80';
            }
            log('no anchors matched after 8s; bundle is the incompatible build');
        }, 8000);

        setTimeout(() => {
            if (window._anyAnchorsMatched) return;
            let already;
            try { already = sessionStorage.getItem('ripper_reloaded'); } catch (e) { already = '1'; }
            if (already) return;
            if (!CONFIG.AUTO_RELOAD_ON_FAILURE) return;
            try { sessionStorage.setItem('ripper_reloaded', '1'); if (sessionStorage.getItem('ripper_reloaded') !== '1') return; } catch (e) { return; }
            log('no anchors after 12s, auto-reloading once');
            location.reload();
        }, 12000);

        setInterval(() => {
            const s = document.getElementById('ripper-status');
            if (!s) return;
            const m = window.allmodel.length;
            const f = window.recordedFrames.length;
            const busy = window.animationRecording || window.clipRecording;
            s.textContent = (window.animationRecording ? '● REC'
                          : (window.clipRecording ? `● CLIPS ${window.clipProgress}` : 'idle'))
                          + ' · meshes:' + m + ' frames:' + f
                          + ' · clips:' + getClipCount()
                          + (window.clips.length ? ` (rec ${window.clips.length})` : '');
            s.style.color = busy ? '#f66' : '#aaa';
        }, 500);

        ((el, handle) => {
            let ox = 0, oy = 0, drag = false;
            handle.addEventListener('mousedown', (e) => {
                drag = true; ox = e.clientX - el.offsetLeft; oy = e.clientY - el.offsetTop; e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
                if (!drag) return;
                el.style.left = `${e.clientX - ox}px`;
                el.style.top  = `${e.clientY - oy}px`;
                el.style.right = 'auto';
            });
            document.addEventListener('mouseup', () => { drag = false; });
        })(panel, title);
    }

    // ====================================================================
    // parseobj
    // ====================================================================
    function parseobj(obj) {
        const list = [];
        (obj._primitives || []).forEach((p) => {
            if (p && p.indices) list.push({ mode: p.mode, indices: p.indices._elements });
        });
        const attr = obj._attributes || {};
        let joints  = attr.Joints0  || attr.JOINTS_0 || attr.joints0 || attr.Joints  || attr.JOINTS  || attr.Bones || attr.BONES;
        let weights = attr.Weights0 || attr.WEIGHTS_0 || attr.weights0 || attr.Weights || attr.WEIGHTS || attr.BoneWeights || attr.BONEWEIGHTS;
        if (joints)  joints  = joints._elements;
        if (weights) weights = weights._elements;
        // Sketchfab assigns arbitrary TexCoordN indices per mesh
        // (e.g. TexCoord0, TexCoord3, TexCoord6 on the same model),
        // so scan for any TexCoordN key rather than hard-coding.
        let uvAttr = null;
        let _uvBestNum = Infinity;
        for (let _k in attr) {
            if (!attr.hasOwnProperty(_k)) continue;
            const _m = /^TexCoord(\d+)$/.exec(_k);
            if (!_m) continue;
            const _a = attr[_k];
            if (!_a || !_a._elements || !_a._elements.length) continue;
            const _n = parseInt(_m[1], 10);
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
            joints,
            weights,
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
        for (let key in saveimagecache2) {
            if (!saveimagecache2.hasOwnProperty(key)) continue;
            const t = saveimagecache2[key];
            if (!t || !t.dataURL) continue;
            if (sanitizeTextureName(t.name) === sanitized) {
                const ext = t.fileExt || '.png';
                const fname = t.name + ext;
                if (objects[fname]) return objects[fname];
            }
        }
        return null;
    }

    function _mergeOneMR(cm) {
        const metalSan = cm.MetalnessPBR && cm.MetalnessPBR.name
                     ? sanitizeTextureName(cm.MetalnessPBR.name) : null;
        const roughSan = cm.RoughnessPBR && cm.RoughnessPBR.name
                     ? sanitizeTextureName(cm.RoughnessPBR.name) : null;
        const glossSan = cm.GlossinessPBR && cm.GlossinessPBR.name
                     ? sanitizeTextureName(cm.GlossinessPBR.name) : null;

        const metalBlob = metalSan ? _blobForSanitizedName(metalSan) : null;
        const roughBlob = roughSan ? _blobForSanitizedName(roughSan) : null;
        const glossBlob = glossSan ? _blobForSanitizedName(glossSan) : null;

        if (!metalBlob && !roughBlob && !glossBlob) return Promise.resolve(null);

        const pending = [];
        if (metalBlob) pending.push(createImageBitmap(metalBlob));
        if (roughBlob) pending.push(createImageBitmap(roughBlob));
        if (glossBlob) pending.push(createImageBitmap(glossBlob));

        return Promise.all(pending).then((bmps) => {
            let i = 0;
            const mBmp = metalBlob ? bmps[i++] : null;
            const rBmp = roughBlob ? bmps[i++] : null;
            const gBmp = glossBlob ? bmps[i++] : null;
            const ref = mBmp || rBmp || gBmp;
            const W = ref.width, H = ref.height;

            function readGray(bmp) {
                const c = document.createElement('canvas');
                c.width = W; c.height = H;
                const x = c.getContext('2d');
                x.drawImage(bmp, 0, 0, W, H);
                const px = x.getImageData(0, 0, W, H).data;
                c.width = 0; if (bmp.close) bmp.close();   // release the bitmap and canvas memory early
                return px;
            }
            const mData = mBmp ? readGray(mBmp) : null;
            const rData = rBmp ? readGray(rBmp) : null;
            const gData = gBmp ? readGray(gBmp) : null;

            const out = new Uint8ClampedArray(W * H * 4);
            for (let p = 0; p < W * H; p++) {
                const metal = mData ? mData[p * 4] : 255;   // no metal map: 255, the metallicFactor carries the flat value
                let rough;
                if (rData) rough = rData[p * 4];
                else if (gData) rough = 255 - gData[p * 4];
                else rough = 255;
                out[p * 4 + 0] = 255;
                out[p * 4 + 1] = rough;
                out[p * 4 + 2] = metal;
                out[p * 4 + 3] = 255;
            }

            const oc = document.createElement('canvas');
            oc.width = W; oc.height = H;
            oc.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
            const useJpeg = CONFIG.MR_TEXTURE_FORMAT !== 'png';
            const mime = useJpeg ? 'image/jpeg' : 'image/png';
            const ext  = useJpeg ? '.jpg' : '.png';
            const q    = useJpeg ? 0.92 : undefined;
            return new Promise((res) => {
                oc.toBlob((b) => { res({ blob: b, ext, hasM: !!mBmp, hasR: !!(rBmp || gBmp) }); }, mime, q);
            });
        });
    }

    function mergeMRTextures() {
        const jobs = [];
        const seen = {};
        window.allmodel.forEach((obj, i) => {
            const ss = obj.stateset;
            const meshName = obj._name
                         || (ss && ss._name)
                         || (`mesh_${i}`);
            const cm = getChannelTextureMap(obj);
            if (!cm.MetalnessPBR && !cm.RoughnessPBR && !cm.GlossinessPBR) return;
            const san = sanitizeTextureName(meshName);
            if (seen[san]) return;
            seen[san] = true;
            jobs.push(
                _mergeOneMR(cm).then((result) => {
                    if (!result || !result.blob) return;
                    const fname = `${san}_MR${result.ext}`;
                    objects[fname] = result.blob;
                    saveimagecache2[`__merged_mr__:${san}`] = {
                        name: `${san}_MR`,
                        fileExt: result.ext,
                        dataURL: 'merged',
                        hasM: result.hasM,
                        hasR: result.hasR
                    };
                    log('merged MR:', meshName, '→', fname, `${result.blob.size}B`);
                }).catch((e) => {
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
        const parts = normalizeUrl(u).split('/');
        const last = parts[parts.length - 1] || '';
        return last.replace(/\.[A-Za-z0-9]+$/, '');
    }

    function _blobForUrl(url) {
        let want = normalizeUrl(url), wantTail = _urlTail(url), hit = null, key, t;
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

    // Opacity comes either from the Opacity channel (blend) or the AlphaMask channel (cutout).
    function opacitySource(cm) {
        function real(c) { return c && (c.url || c.name) && !c.atlas; }
        return real(cm.Opacity) ? cm.Opacity : (real(cm.AlphaMask) ? cm.AlphaMask : (cm.Opacity || cm.AlphaMask || null));
    }

    function _mergeOneOpacity(cm) {
        const noColor = !cm.AlbedoPBR || !(cm.AlbedoPBR.url || cm.AlbedoPBR.name) || cm.AlbedoPBR.atlas;
        const colorBlob = noColor ? null : _blobForUrl(cm.AlbedoPBR.url);
        const maskBlob = _blobForUrl(opacitySource(cm).url);
        if ((!noColor && !colorBlob) || !maskBlob) {
            warn(`opacity merge: missing source (color=${!!colorBlob} mask=${!!maskBlob})`);
            return Promise.resolve(null);
        }
        return Promise.all([noColor ? null : createImageBitmap(colorBlob), createImageBitmap(maskBlob)]).then((bmps) => {
            const mBmp = bmps[1], cBmp = bmps[0] || mBmp;
            const W = cBmp.width, H = cBmp.height;
            function readPixels(bmp) {
                const c = document.createElement('canvas');
                c.width = W; c.height = H;
                const x = c.getContext('2d');
                x.drawImage(bmp, 0, 0, W, H);   // the mask is scaled to the color size
                const px = x.getImageData(0, 0, W, H).data;
                c.width = 0; if (bmp.close) bmp.close();   // release the bitmap and canvas memory early
                return px;
            }
            const cData = noColor ? null : readPixels(cBmp), mData = readPixels(mBmp);
            const out = new Uint8ClampedArray(W * H * 4);
            for (let p = 0; p < W * H; p++) {
                const q = p * 4;
                out[q] = cData ? cData[q] : 255;          // no colour image: white, the factor gives the colour
                out[q + 1] = cData ? cData[q + 1] : 255;
                out[q + 2] = cData ? cData[q + 2] : 255;
                // luminance of the mask: black = clear, white = solid
                out[q + 3] = Math.round(0.2126 * mData[q] + 0.7152 * mData[q + 1] + 0.0722 * mData[q + 2]);
            }
            const oc = document.createElement('canvas');
            oc.width = W; oc.height = H;
            oc.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
            return new Promise((res) => {
                oc.toBlob((b) => { res({ blob: b, ext: '.png' }); }, 'image/png');   // PNG: JPEG drops alpha
            });
        });
    }

    let _opacityKind = {};      // sanitized mesh name -> 'opacity' | 'alphamask'
    let _alphaFirst = {};       // 'colorUrl|maskUrl' -> first sanitized mesh name that merged it
    let _alphaShare = {};       // sanitized mesh name -> sanitized name that owns the merged texture
    let _opacityNoColor = {};   // sanitized mesh name -> merged opacity has no colour image (white RGB, alpha only)
    let _opacityOneFile = {};   // sanitized mesh name -> true when opacity lives in the base color file's alpha

    function mergeOpacityTextures() {
        _opacityOneFile = {};
        _opacityKind = {};
        _alphaFirst = {};
        _alphaShare = {};
        _opacityNoColor = {};
        const jobs = [];
        const seen = {};
        window.allmodel.forEach((obj, i) => {
            const ss = obj.stateset;
            const meshName = obj._name || (ss && ss._name) || (`mesh_${i}`);
            const cm = getChannelTextureMap(obj);
            const opSrc = opacitySource(cm);
            if (!opSrc || !(opSrc.url || opSrc.name) || opSrc.atlas) return;
            const mch = getMaterialChannels(obj);
            const isOpacity = opSrc === cm.Opacity;
            const opCh = mch && (isOpacity ? mch.Opacity : mch.AlphaMask);
            if (opCh && opCh.enable === false) return;   // texture present but the channel is switched off in the viewer
            const san = sanitizeTextureName(meshName);
            if (seen[san]) return;
            seen[san] = true;
            // Opacity channel of a cutout type behaves like a mask (MASK), blend types use BLEND.
            const oType = String((opCh && opCh.type) || '');
            _opacityKind[san] = (isOpacity && !/mask|dither|cutout/i.test(oType)) ? 'opacity' : 'alphamask';
            if (!cm.AlbedoPBR || !(cm.AlbedoPBR.url || cm.AlbedoPBR.name) || cm.AlbedoPBR.atlas) {
                _opacityNoColor[san] = true;   // opacity image only: merge into a white RGB + alpha texture
            } else if (normalizeUrl(opSrc.url) === normalizeUrl(cm.AlbedoPBR.url)) {
                _opacityOneFile[san] = true;
                log(`opacity merge: ${meshName} uses one file for color and opacity, skipped`);
                return;
            }
            // Meshes sharing the same colour and mask images share one merged texture.
            const okey = `${_opacityNoColor[san] ? 'white' : normalizeUrl(cm.AlbedoPBR.url)}|${normalizeUrl(opSrc.url)}`;
            if (_alphaFirst[okey]) { _alphaShare[san] = _alphaFirst[okey]; log(`opacity merge: ${meshName} shares the merged texture of ${_alphaFirst[okey]}`); return; }
            _alphaFirst[okey] = san;
            jobs.push(
                _mergeOneOpacity(cm).then((result) => {
                    if (!result || !result.blob) return;
                    const fname = `${san}_Alpha${result.ext}`;
                    objects[fname] = result.blob;
                    saveimagecache2[`__merged_op__:${san}`] = {
                        name: `${san}_Alpha`,
                        fileExt: result.ext,
                        dataURL: 'merged'
                    };
                    log('merged opacity:', meshName, '→', fname, `${result.blob.size}B`);
                }).catch((e) => {
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
        let seen = {}, expected = 0, missing = 0;
        window.allmodel.forEach((obj) => {
            const cm = getChannelTextureMap(obj);
            for (let ch in cm) {
                if (!cm.hasOwnProperty(ch) || !cm[ch] || !cm[ch].url) continue;
                const id = _urlTail(cm[ch].url) || normalizeUrl(cm[ch].url);
                if (seen[id]) continue;
                seen[id] = true;
                expected++;
                if (!_blobForUrl(cm[ch].url)) missing++;
            }
        });
        return { expected, missing };
    }

    function waitForTextures() {
        const maxMs = (CONFIG.TEXTURE_WAIT_SECONDS || 0) * 1000;
        const first = textureReadiness();
        if (maxMs <= 0 || first.missing === 0) return Promise.resolve();
        log('textures still loading: ' + (first.expected - first.missing) + '/' + first.expected +
            ' captured, waiting up to ' + CONFIG.TEXTURE_WAIT_SECONDS + 's (keep this tab visible)');
        return new Promise((resolve) => {
            let start = Date.now(), lastProgressAt = start, lastCaptured = first.expected - first.missing;
            (function poll() {
                setTimeout(() => {
                    const r = textureReadiness(), captured = r.expected - r.missing, now = Date.now();
                    if (captured > lastCaptured) {
                        lastCaptured = captured;
                        lastProgressAt = now;
                        log(`textures captured: ${captured}/${r.expected}`);
                    }
                    if (r.missing === 0) { log(`all ${r.expected} textures captured`); resolve(); return; }
                    // Some textures are never drawn (tiny ones are skipped on purpose). Once
                    // some arrived and then nothing new came for 5 s, stop waiting.
                    if (captured > 0 && now - lastProgressAt > 5000) {
                        warn(`textures: ${r.missing}/${r.expected} never appeared, exporting without them`);
                        resolve();
                        return;
                    }
                    if (now - start >= maxMs) {
                        warn(`textures: timed out with ${r.missing}/${r.expected} missing, exporting without them`);
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
        if (_exporting) { warn('export already running, ignored'); return; }
        if (window.animationRecording || window.clipRecording) { warn('recording is still running: press STOP first (export would miss the animation)'); return; }
        _exporting = true;
        log('export started');
        waitForTextures().then(mergeMRTextures).then(mergeOpacityTextures).then(() => {
            _downloadGLBSync();
        }).catch((e) => {
            _exporting = false;
            err('export failed:', e.message, e.stack);
        });
    }

    function _downloadGLBSync() {
        try {
            function pad(o) { return o % 4 ? o + (4 - o % 4) : o; }

            const allNodes = window.allmodel;
            const nodeMap = new Map();
            const nodes = [];

            allNodes.forEach((obj, idx) => {
                nodeMap.set(obj, idx);
                const name = obj._name || (obj.stateset && obj.stateset._name) || (`mesh_${idx}`);
                const world = computeWorldMatrix(obj);
                nodes.push({ name, matrix: world, mesh: undefined, children: [] });
            });

            const meshes = [], accs = [], bvs = [], mats = [];
            const skippedNodes = {};    // node index -> true for wireframe overlay meshes that are not exported
            let sceneSizeLocal = 0, sceneSizeWorld = 0;   // largest mesh diagonal (mesh units / world units), for key reduction
            const matsChannelInfo = {}; // mi -> { channelName: {url, name} }
            const matsFlat = {};        // mi -> { channelName: {enable, factor, color} } from the material model
            let binChunks = [], off = 0;   // Uint8Array chunks, joined once at the end
            const matHasUV = {};
            const meshHasSkinning = {};
            const morphInfo = {};   // mIdx -> { meshIdx, n } for meshes with morph targets

            function addBV(ta, target) {
                const len = ta.byteLength;
                const al = pad(off), padn = al - off;
                if (padn > 0) { binChunks.push(new Uint8Array(padn)); off += padn; }
                const idx = bvs.length;
                const bv = { buffer: 0, byteOffset: off, byteLength: len };
                if (target) bv.target = target;
                bvs.push(bv);
                const bytes = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
                binChunks.push(bytes);
                off += len;
                return idx;
            }

            allNodes.forEach((obj, mIdx) => {
                if (!obj._primitives) return;
                const mdl = parseobj(obj);
                if (!mdl.vertex || mdl.vertex.length === 0) return;
                const nm = obj._name || (obj.stateset && obj.stateset._name) || (`mesh_${mIdx}`);
                const vc = mdl.vertex.length / 3;

                const twinIdx = wireOverlayTwin(allNodes, mIdx);
                if (twinIdx >= 0) {
                    const twinObj = allNodes[twinIdx];
                    log('mesh ' + nm + ': skipped, it is the wireframe overlay (lines only) of "' +
                        (twinObj._name || (twinObj.stateset && twinObj.stateset._name) || (`mesh_${twinIdx}`)) + '"');
                    skippedNodes[mIdx] = true;
                    return;
                }

                const posArr = new Float32Array(mdl.vertex);
                const posMin = [Infinity, Infinity, Infinity];
                const posMax = [-Infinity, -Infinity, -Infinity];
                for (let pi = 0; pi < posArr.length; pi += 3) {
                    for (let ci = 0; ci < 3; ci++) {
                        const v = posArr[pi + ci];
                        if (v < posMin[ci]) posMin[ci] = v;
                        if (v > posMax[ci]) posMax[ci] = v;
                    }
                }
                const accPos = accs.length;
                accs.push({ bufferView: addBV(posArr, 34962), componentType: 5126,
                            count: vc, type: 'VEC3', min: posMin, max: posMax });
                const dgl = Math.sqrt(Math.pow(posMax[0] - posMin[0], 2) + Math.pow(posMax[1] - posMin[1], 2) + Math.pow(posMax[2] - posMin[2], 2));
                if (isFinite(dgl)) {
                    let wmS = nodes[nodeMap.get(obj)] && nodes[nodeMap.get(obj)].matrix, wsc = 1;
                    if (wmS && wmS.length === 16) {
                        wsc = 0;
                        for (let wc = 0; wc < 3; wc++) wsc = Math.max(wsc, Math.sqrt(wmS[wc * 4] * wmS[wc * 4] + wmS[wc * 4 + 1] * wmS[wc * 4 + 1] + wmS[wc * 4 + 2] * wmS[wc * 4 + 2]));
                    }
                    if (dgl > sceneSizeLocal) sceneSizeLocal = dgl;
                    if (dgl * wsc > sceneSizeWorld) sceneSizeWorld = dgl * wsc;
                }

                let aN = -1, aU = -1, aI = -1, aJ = -1, aW = -1;
                if (mdl.normal.length) {
                    // Some meshes carry normals scaled by their instance transform; glTF needs unit length.
                    mdl.normal = unitNormals(mdl.normal);
                    aN = accs.length;
                    accs.push({ bufferView: addBV(new Float32Array(mdl.normal), 34962),
                                componentType: 5126, count: vc, type: 'VEC3' });
                }
                if (mdl.uv.length) {
                    // glTF uses top-left UV origin; Sketchfab's osgjs uses
                    // bottom-left. Flip V (index 1 of each pair) so the
                    // texture lands right-side up. Keep this export-local:
                    // if we later add an FBX path, FBX may not want it.
                    const uvArr = new Float32Array(mdl.uv);
                    for (let uvi = 1; uvi < uvArr.length; uvi += 2) {
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
                let aC = -1, colArr = mdl.color;
                if (colArr && colArr.length) {
                    const isU8 = (colArr instanceof Uint8Array || colArr instanceof Uint8ClampedArray);
                    const conv = !!CONFIG.VERTEX_COLOR_SRGB;
                    const cStride = (colArr.length === vc * 4) ? 4 : ((colArr.length === vc * 3) ? 3 : 0);
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
                        const cf = new Float32Array(colArr.length);
                        for (let cfi = 0; cfi < cf.length; cfi++) {
                            let cv = isU8 ? colArr[cfi] / 255 : colArr[cfi];
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
                // A mesh can carry several index primitives (a triangle list plus extra
                // lists, strips or fans). Merge every triangle-type primitive into one
                // TRIANGLES list so no faces go missing; other modes (points, lines) are
                // only used when the mesh has no triangle primitive at all.
                let mergedInd = null, mergedMode = 4;
                if (mdl.primitives.length > 0) {
                    let triParts = [], skippedP = 0, modeLog = [];
                    mdl.primitives.forEach((pr) => {
                        let pm = (pr.mode === undefined || pr.mode === null) ? 4 : pr.mode, pi2 = pr.indices, tl = [], t2;
                        modeLog.push(`${pm}x${pi2 ? pi2.length : 0}`);
                        if (!pi2 || !pi2.length) return;
                        // Degenerate triangles (repeated index) are strip joins; drop them so
                        // Blender does not show long zero-area edges between distant vertices.
                        let oobN = 0, degN = 0, tpos = [];
                        function addTri(a, b, c) {
                            if (a !== b && b !== c && a !== c && a < vc && b < vc && c < vc) { tl.push(a, b, c); tpos.push(t2); }
                            else if (a >= vc || b >= vc || c >= vc) oobN++;
                            else degN++;
                        }
                        // An index >= vertex count (WebGL2 primitive restart value 65535 / 4294967295) ends a
                        // strip or fan: restart the winding parity after it instead of treating it as a vertex.
                        let rs = 0;
                        if (pm === 4) {
                            for (t2 = 0; t2 + 2 < pi2.length; t2 += 3) addTri(pi2[t2], pi2[t2 + 1], pi2[t2 + 2]);
                        } else if (pm === 5) {
                            for (t2 = 0; t2 < pi2.length; t2++) {
                                if (pi2[t2] >= vc) { rs = t2 + 1; oobN++; continue; }
                                if (t2 - rs < 2) continue;
                                if ((t2 - rs) % 2 === 0) addTri(pi2[t2 - 2], pi2[t2 - 1], pi2[t2]);
                                else addTri(pi2[t2 - 1], pi2[t2 - 2], pi2[t2]);
                            }
                        } else if (pm === 6) {
                            for (t2 = 0; t2 < pi2.length; t2++) {
                                if (pi2[t2] >= vc) { rs = t2 + 1; oobN++; continue; }
                                if (t2 - rs < 2) continue;
                                addTri(pi2[rs], pi2[t2 - 1], pi2[t2]);
                            }
                        } else { skippedP++; return; }
                        // Diagnostic for stray long thin triangles ("stripes"): flag triangles whose longest edge is
                        // far above the typical edge of this mesh and print where they come from in the index list.
                        if (tl.length) (() => {
                            let vv = mdl.vertex, nT = tl.length / 3, q, lens = [], mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
                            function el(i, j) { const dx = vv[i * 3] - vv[j * 3], dy = vv[i * 3 + 1] - vv[j * 3 + 1], dz = vv[i * 3 + 2] - vv[j * 3 + 2]; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
                            for (q = 0; q < vc; q++) for (let ax = 0; ax < 3; ax++) { const cv = vv[q * 3 + ax]; if (cv < mn[ax]) mn[ax] = cv; if (cv > mx[ax]) mx[ax] = cv; }
                            const size = Math.sqrt(Math.pow(mx[0] - mn[0], 2) + Math.pow(mx[1] - mn[1], 2) + Math.pow(mx[2] - mn[2], 2));
                            const step = Math.max(1, Math.floor(nT / 2000));
                            for (q = 0; q < nT; q += step) lens.push(Math.max(el(tl[q * 3], tl[q * 3 + 1]), el(tl[q * 3 + 1], tl[q * 3 + 2]), el(tl[q * 3], tl[q * 3 + 2])));
                            lens.sort((a, b) => a - b);
                            let med = lens[lens.length >> 1] || 0, lim = Math.max(20 * med, 0.05 * size), hits = 0, shown = 0, drop = {}, nDrop = 0, cand = [];
                            for (q = 0; q < nT; q++) {
                                const a0 = tl[q * 3], b0 = tl[q * 3 + 1], c0 = tl[q * 3 + 2];
                                const L = Math.max(el(a0, b0), el(b0, c0), el(a0, c0));
                                if (!(L > lim)) continue;
                                hits++;
                                // Bridging triangle of a strip join without repeated vertices: very long and almost no width.
                                const ux = vv[b0 * 3] - vv[a0 * 3], uy = vv[b0 * 3 + 1] - vv[a0 * 3 + 1], uz = vv[b0 * 3 + 2] - vv[a0 * 3 + 2];
                                const wx = vv[c0 * 3] - vv[a0 * 3], wy = vv[c0 * 3 + 1] - vv[a0 * 3 + 1], wz = vv[c0 * 3 + 2] - vv[a0 * 3 + 2];
                                const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
                                const height = Math.sqrt(cx * cx + cy * cy + cz * cz) / L;   // 2*area / longest edge
                                if (CONFIG.DROP_STRIP_SLIVERS && (pm === 5 || pm === 6) && height < 2 * med) cand.push(q);
                                if (shown < 3 && CONFIG.DROP_STRIP_SLIVERS && (pm === 5 || pm === 6) && height < 2 * med) {
                                    shown++;
                                    const at = tpos[q], ctx = [];
                                    for (let ci = Math.max(0, at - 5); ci <= Math.min(pi2.length - 1, at + 3); ci++) ctx.push((ci === at ? '*' : '') + pi2[ci]);
                                    log('long triangle:', nm, `mode ${pm}`, 'tri (' + a0 + ',' + b0 + ',' + c0 + ') longest edge ' + L.toFixed(3) +
                                        ' (typical ' + med.toFixed(4) + ', mesh size ' + size.toFixed(3) + ') at index ' + at + ' of ' + pi2.length + ', indices around: ' + ctx.join(' '));
                                }
                            }
                            // A bridging triangle spans a gap: one of its long edges is used by no other triangle
                            // (vertices welded by position). Long thin tubes/rods share every long edge, so they stay.
                            if (cand.length) {
                                let qs = Math.max(size * 1e-6, 1e-9), wmap = {}, wid = new Int32Array(vc), nw = 0, vi;
                                for (vi = 0; vi < vc; vi++) {
                                    const wk = `${Math.round(vv[vi * 3] / qs)},${Math.round(vv[vi * 3 + 1] / qs)},${Math.round(vv[vi * 3 + 2] / qs)}`;
                                    if (wmap[wk] === undefined) wmap[wk] = nw++;
                                    wid[vi] = wmap[wk];
                                }
                                const ek = (i, j) => { const a1 = wid[i], b1 = wid[j]; return a1 < b1 ? `${a1}_${b1}` : `${b1}_${a1}`; };
                                let ecount = {}, ci2, e3;
                                for (ci2 = 0; ci2 < cand.length; ci2++) {
                                    const cq = cand[ci2], cv3 = [tl[cq * 3], tl[cq * 3 + 1], tl[cq * 3 + 2]];
                                    for (e3 = 0; e3 < 3; e3++) if (el(cv3[e3], cv3[(e3 + 1) % 3]) > lim) ecount[ek(cv3[e3], cv3[(e3 + 1) % 3])] = 0;
                                }
                                for (q = 0; q < nT; q++) for (e3 = 0; e3 < 3; e3++) {
                                    const k3 = ek(tl[q * 3 + e3], tl[q * 3 + (e3 + 1) % 3]);
                                    if (ecount[k3] !== undefined) ecount[k3]++;
                                }
                                // A bridge joins real geometry at both ends of its open edge; a free thin card (wire,
                                // grass, hair strip) does not, so it stays.
                                const isCand = {}, onReal = new Uint8Array(nw);
                                for (ci2 = 0; ci2 < cand.length; ci2++) isCand[cand[ci2]] = true;
                                for (q = 0; q < nT; q++) if (!isCand[q]) { onReal[wid[tl[q * 3]]] = 1; onReal[wid[tl[q * 3 + 1]]] = 1; onReal[wid[tl[q * 3 + 2]]] = 1; }
                                for (ci2 = 0; ci2 < cand.length; ci2++) {
                                    let cq2 = cand[ci2], cw = [tl[cq2 * 3], tl[cq2 * 3 + 1], tl[cq2 * 3 + 2]], open = false;
                                    for (e3 = 0; e3 < 3; e3++) {
                                        const ka = ek(cw[e3], cw[(e3 + 1) % 3]);
                                        if (ecount[ka] === 1 && onReal[wid[cw[e3]]] && onReal[wid[cw[(e3 + 1) % 3]]]) open = true;
                                    }
                                    if (open) { drop[cq2] = true; nDrop++; }
                                }
                            }
                            if (nDrop) {
                                const kept = [];
                                for (q = 0; q < nT; q++) if (!drop[q]) kept.push(tl[q * 3], tl[q * 3 + 1], tl[q * 3 + 2]);
                                tl = kept;
                                log(`mesh ${nm}: dropped ${nDrop} bridging sliver triangle(s) from the strip (stripes)`);
                            }
                            if (hits > nDrop) log(`mesh ${nm}: ${hits - nDrop} long thin triangle(s) kept (real geometry, edges shared)`);
                        })();
                        if (oobN) log('indices:', nm, `mode ${pm}`, `${pi2.length} indices ->`, `${tl.length / 3} triangles, restart/out-of-range ${oobN}, degenerate ${degN}, vertices ${vc}`);
                        triParts.push(tl);
                    });
                    if (mdl.primitives.length > 1) log('primitives:', nm, mdl.primitives.length, `(mode x indices: ${modeLog.join(', ')})`);
                    if (triParts.length) {
                        mergedInd = [];
                        triParts.forEach((tl) => { for (let tq = 0; tq < tl.length; tq++) mergedInd.push(tl[tq]); });
                        if (skippedP) warn('mesh', nm, ':', skippedP, 'non-triangle primitive(s) not exported');
                    }
                }
                let noTris = false;
                if (mergedInd && !mergedInd.length) { warn('mesh', nm, ': no valid triangles after merge, exported as points'); mergedInd = null; noTris = true; }
                if (mergedInd) {
                    let mxm = 0;
                    for (let km = 0; km < mergedInd.length; km++) if (mergedInd[km] > mxm) mxm = mergedInd[km];
                    const idxM = mxm < 65535 ? new Uint16Array(mergedInd) : new Uint32Array(mergedInd);
                    aI = accs.length;
                    accs.push({ bufferView: addBV(idxM, 34963),
                                componentType: idxM instanceof Uint32Array ? 5125 : 5123,
                                count: mergedInd.length, type: 'SCALAR' });
                } else if (!noTris && mdl.primitives.length > 0 && mdl.primitives[0].indices && mdl.primitives[0].indices.length > 0) {
                    let ind = mdl.primitives[0].indices, mx = 0;
                    for (let k = 0; k < ind.length; k++) if (ind[k] > mx) mx = ind[k];
                    if (mx >= vc) {
                        warn('mesh', nm, ': indices out of range, exported as points');
                        noTris = true;
                    } else {
                        const idxD = mx < 65535 ? new Uint16Array(ind) : new Uint32Array(ind);
                        aI = accs.length;
                        accs.push({ bufferView: addBV(idxD, 34963),
                                    componentType: idxD instanceof Uint32Array ? 5125 : 5123,
                                    count: ind.length, type: 'SCALAR' });
                    }
                }

                const expected = vc * 4;
                if (mdl.joints && mdl.weights &&
                    mdl.joints.length === expected && mdl.weights.length === expected) {
                    let mj = 0;
                    for (let jj = 0; jj < mdl.joints.length; jj++) if (mdl.joints[jj] > mj) mj = mdl.joints[jj];
                    const jD = mj <= 255 ? new Uint8Array(mdl.joints) : new Uint16Array(mdl.joints);
                    // A joint index used with weight 0 is invalid in glTF (validator
                    // ACCESSOR_JOINTS_USED_ZERO_WEIGHT): point such slots at joint 0.
                    for (let zj = 0; zj < jD.length; zj++) if (!(mdl.weights[zj] > 0)) jD[zj] = 0;
                    aJ = accs.length;
                    accs.push({ bufferView: addBV(jD, 34962),
                                componentType: mj <= 255 ? 5121 : 5123,
                                count: vc, type: 'VEC4' });
                    aW = accs.length;
                    accs.push({ bufferView: addBV(new Float32Array(mdl.weights), 34962),
                                componentType: 5126, count: vc, type: 'VEC4' });
                    meshHasSkinning[mIdx] = mj + 1;
                    log('skinned mesh:', nm, `jointsMax=${mj}`);
                }

                // Morph targets. The viewer blends  (1 - sum w) * base + sum w_k * target_k  with
                // absolute targets, which equals glTF's  base + sum w_k * (target_k - base).
                const morphTargets = [], mAttr = obj._attributes || {};
                function morphEls(a) {
                    const b = a && (a._initialBufferArray || a._bufferArray);
                    return (b && b._elements) || (a && a._elements) || null;
                }
                for (let mk = 0, mN = morphTargetCount(obj); mk < mN; mk++) {
                    const tv = morphEls(mAttr[`Vertex_${mk}`]);
                    if (!tv || tv.length !== mdl.vertex.length) {
                        warn('morph target', mk, 'of', nm, 'skipped (vertex data missing or wrong size)');
                        continue;
                    }
                    const dv = new Float32Array(tv.length), dMin = [Infinity, Infinity, Infinity], dMax = [-Infinity, -Infinity, -Infinity];
                    for (let di = 0; di < tv.length; di++) {
                        const dd = tv[di] - mdl.vertex[di];
                        dv[di] = dd;
                        const dax = di % 3;
                        if (dd < dMin[dax]) dMin[dax] = dd;
                        if (dd > dMax[dax]) dMax[dax] = dd;
                    }
                    const tgt = { POSITION: accs.length };
                    accs.push({ bufferView: addBV(dv, 34962), componentType: 5126, count: vc,
                                type: 'VEC3', min: dMin, max: dMax });
                    let tn = morphEls(mAttr[`Normal_${mk}`]);
                    if (tn && mdl.normal.length && tn.length === mdl.normal.length) {
                        tn = unitNormals(tn);
                        const dn = new Float32Array(tn.length);
                        for (let dni = 0; dni < tn.length; dni++) dn[dni] = tn[dni] - mdl.normal[dni];
                        tgt.NORMAL = accs.length;
                        accs.push({ bufferView: addBV(dn, 34962), componentType: 5126, count: vc, type: 'VEC3' });
                    }
                    morphTargets.push(tgt);
                }
                if (morphTargets.length) log('morph targets:', nm, morphTargets.length);

                const primMode = noTris ? 0 : mergedInd ? 4 : ((mdl.primitives.length > 0 && typeof mdl.primitives[0].mode === 'number') ? mdl.primitives[0].mode : 4);
                const prim = { attributes: { POSITION: accPos }, mode: primMode };
                if (aN >= 0) prim.attributes.NORMAL = aN;
                if (aU >= 0) prim.attributes.TEXCOORD_0 = aU;
                if (aC >= 0) prim.attributes.COLOR_0 = aC;
                if (aJ >= 0) prim.attributes.JOINTS_0 = aJ;
                if (aW >= 0) prim.attributes.WEIGHTS_0 = aW;
                if (aI >= 0) prim.indices = aI;
                if (morphTargets.length) prim.targets = morphTargets;

                let mi = -1;
                for (let q = 0; q < mats.length; q++) if (mats[q].name === nm) { mi = q; break; }
                if (mi === -1) {
                    mi = mats.length;
                    mats.push({ name: nm, pbrMetallicRoughness: {
                        baseColorFactor: [1,1,1,1], metallicFactor: 1, roughnessFactor: 1 } });
                    matsChannelInfo[mi] = getChannelTextureMap(obj);
                    matsFlat[mi] = getMaterialChannels(obj);
                }
                prim.material = mi;

                const mshIdx = meshes.length;
                if (morphTargets.length) morphInfo[mIdx] = { meshIdx: meshes.length, n: morphTargets.length };
                meshes.push({ name: nm, primitives: [prim] });
                const ni = nodeMap.get(obj);
                if (ni !== undefined) nodes[ni].mesh = mshIdx;
            });

            let images = [], textures = [], imageKeys = [], usedSafe = {};
            const textureUrlToIndex  = {};
            const textureNameToIndex = {};
            for (let key in saveimagecache2) {
                if (!saveimagecache2.hasOwnProperty(key)) continue;
                const t = saveimagecache2[key];
                if (!t || !t.dataURL) continue;
                const ext = t.fileExt || '.png';
                if (!objects[(t.name || 'texture') + ext]) { warn(`texture file missing, not referenced: ${t.name || 'texture'}${ext}`); continue; }
                // ASCII-safe file name: no encoding issues in URIs or zip loaders.
                const safeBase = String(t.name || 'texture').replace(/[^A-Za-z0-9._-]+/g, '_') || 'texture';
                let safeName = safeBase + ext, sc = 1;
                while (usedSafe[safeName.toLowerCase()]) safeName = `${safeBase}_${sc++}${ext}`;   // case-insensitive file systems
                usedSafe[safeName.toLowerCase()] = true;
                const path = `textures/${safeName}`;
                const ii = images.length;
                imageKeys.push({ key: (t.name || 'texture') + ext, safe: safeName });
                images.push({ uri: path });
                textures.push({ source: ii });
                const nu = normalizeUrl(key);
                if (nu) textureUrlToIndex[nu] = ii;
                const sn = sanitizeTextureName(t.name);
                if (sn) textureNameToIndex[sn] = ii;
            }

            function findTexIdx(info) {
                if (!info) return undefined;
                const u = normalizeUrl(info.url);
                if (u && textureUrlToIndex[u] !== undefined) return textureUrlToIndex[u];
                const n = sanitizeTextureName(info.name);
                if (n && textureNameToIndex[n] !== undefined) return textureNameToIndex[n];
                return undefined;
            }

            function flatEm(fl) {
                const e = fl && fl.EmitColor;
                const f = (e && typeof e.factor === 'number') ? e.factor : 1;
                return Math.max(0, Math.min(1, f));
            }

            // Channels the viewer shows with a texture that did not make it into the export.
            mats.forEach((m, mi) => {
                const chan = matsChannelInfo[mi] || {};
                (() => {
                    const fl = matsFlat[mi], mp = fl && fl.__map, lost = [], atl = [];
                    if (mp) for (let mk2 in mp) {
                        if (!mp.hasOwnProperty(mk2) || !(mp[mk2] >= 0) || mk2 === 'Inspector' || mk2 === 'Matcap') continue;
                        const inf = chan[mk2];
                        if (!inf || inf.atlas || !(inf.url || inf.name)) { atl.push(mk2); continue; }
                        if (findTexIdx(inf) === undefined) lost.push(mk2);
                    }
                    if (lost.length) warn(`material ${m.name}: channels with a texture in the viewer but not in the export: ${lost.join(', ')}`);
                    if (atl.length) log(`material ${m.name}: colour atlas / no image for ${atl.join(', ')}, using flat material values`);
                })();
            });
            let anyRealTex = false;
            for (let cmi in matsChannelInfo) {
                if (!matsChannelInfo.hasOwnProperty(cmi) || !matsChannelInfo[cmi]) continue;
                for (let ck in matsChannelInfo[cmi]) {
                    const ci = matsChannelInfo[cmi][ck];
                    if (matsChannelInfo[cmi].hasOwnProperty(ck) && ci && (ci.url || ci.name) && !ci.atlas) anyRealTex = true;
                }
            }
            if (!textures.length && mats.length && anyRealTex) warn('no textures were captured at all: reload the page, wait until the model is fully shown, then export (see tools/probe-textures.js if it keeps happening)');

            if (textures.length) {
                mats.forEach((m, mi) => {
                    if (!matHasUV[m.name]) return;
                    const chan = matsChannelInfo[mi] || {};
                    let assigned = false;

                    const albedo = chan.AlbedoPBR || chan.DiffusePBR || chan.BaseColorPBR || chan.DiffuseColor;
                    const ai = findTexIdx(albedo);
                    if (ai !== undefined) {
                        m.pbrMetallicRoughness.baseColorTexture = { index: ai };
                        assigned = true;
                    }

                    const nrm = chan.NormalMap || chan.NormalPBR;
                    const ni = findTexIdx(nrm);
                    if (ni !== undefined) {
                        m.normalTexture = { index: ni };
                        assigned = true;
                    }

                    const ao = chan.AOPBR || chan.OcclusionPBR;
                    const oi = findTexIdx(ao);
                    if (oi !== undefined) {
                        m.occlusionTexture = { index: oi };
                        assigned = true;
                    }

                    const em = chan.EmissivePBR || chan.EmissionPBR || chan.EmitColor;
                    const ei = findTexIdx(em);
                    if (ei !== undefined) {
                        m.emissiveTexture = { index: ei };
                        // glTF multiplies the texture by emissiveFactor (default 0 = no emission).
                        const emF = flatEm(matsFlat[mi]);
                        m.emissiveFactor = [emF, emF, emF];
                        assigned = true;
                    }

                    // Merged MR (see mergeMRTextures): registered in the
                    // pool under name "<sanitized mesh name>_MR".
                    const mrName = `${sanitizeTextureName(m.name)}_MR`;
                    const mrIdx = textureNameToIndex[mrName];
                    if (mrIdx !== undefined) {
                        m.pbrMetallicRoughness.metallicRoughnessTexture = { index: mrIdx };
                        assigned = true;
                    }

                    // Merged opacity (see mergeOpacityTextures): the RGBA texture
                    // replaces the plain base color and the material blends.
                    const alphaIdx = textureNameToIndex[`${_alphaShare[sanitizeTextureName(m.name)] || sanitizeTextureName(m.name)}_Alpha`];
                    if (alphaIdx !== undefined) {
                        m.pbrMetallicRoughness.baseColorTexture = { index: alphaIdx };
                        if (_opacityKind[sanitizeTextureName(m.name)] === 'alphamask') {
                            m.alphaMode = 'MASK'; m.alphaCutoff = 0.5;
                        } else {
                            m.alphaMode = 'BLEND';
                        }
                        assigned = true;
                        log(`material ${m.name}: alphaMode ${m.alphaMode} with merged ${_opacityKind[sanitizeTextureName(m.name)] || 'opacity'} texture`);
                    }

                    if (!assigned) {
                        // No texture of this material was captured. Do not borrow texture 0
                        // (an unrelated image); keep the plain material and say so.
                        warn('material ' + m.name + ': no texture found in the capture pool, exported without textures'
                             + (CONFIG.TEXTURE_WAIT_SECONDS ? '' : ' (texture wait is off)'));
                    }
                });
            }

            // Flat material values for channels without a texture (texture-less models): base
            // color, metalness, roughness, emission. Textured channels keep factor 1 so the
            // texture alone decides, as before.
            mats.forEach((m, mi) => {
                const flat = matsFlat[mi], chan = matsChannelInfo[mi] || {}, pbr = m.pbrMetallicRoughness;
                if (!flat) return;
                const did = [];
                const cmap = flat.__map;
                function texd(n) {
                    // A channel counts as textured only when it has a real image (url or name) that is not
                    // the generated colour atlas; otherwise the flat material value is the best data we have.
                    const real = !!(chan[n] && (chan[n].url || chan[n].name) && !chan[n].atlas);
                    if (cmap && typeof cmap[n] === 'number') return cmap[n] >= 0 && real;
                    return real;
                }
                const chKeys = [];
                for (let chk in chan) if (chan.hasOwnProperty(chk) && (chan[chk].url || chan[chk].name)) chKeys.push(chk);
                const mapKeys = [];
                if (cmap) for (let mpk in cmap) if (cmap.hasOwnProperty(mpk) && cmap[mpk] >= 0) mapKeys.push(`${mpk}=${cmap[mpk]}`);
                log('material ' + m.name + ': texture channels [' + chKeys.join(',') + '] mapping [' + mapKeys.join(',') + ']' +
                    (pbr.baseColorTexture ? ' baseColorTexture set' : ' no baseColorTexture'));
                const alb = flat.AlbedoPBR;
                const alphaOnlyTex = !!_opacityNoColor[sanitizeTextureName(m.name)];
                if (alb && alb.enable && (alb.color || typeof alb.factor === 'number') && (!pbr.baseColorTexture || alphaOnlyTex) && !texd('AlbedoPBR') && !texd('DiffusePBR')) {
                    // No colour value means white scaled by the factor (factor 0 = black base, colour from emission only).
                    const af = (typeof alb.factor === 'number') ? alb.factor : 1, ac = alb.color || [1, 1, 1];
                    const aa = (pbr.baseColorFactor && pbr.baseColorFactor[3] !== undefined) ? pbr.baseColorFactor[3] : 1;
                    pbr.baseColorFactor = [Math.min(1, ac[0] * af), Math.min(1, ac[1] * af), Math.min(1, ac[2] * af), aa];
                    did.push('base color');
                }
                const mt = flat.MetalnessPBR, rg = flat.RoughnessPBR;
                // Merged MR image: a missing map is stored as 255, so the factor carries the flat value.
                const mrE = saveimagecache2[`__merged_mr__:${sanitizeTextureName(m.name)}`], mrTex = !!pbr.metallicRoughnessTexture;
                const mFlat = !texd('MetalnessPBR') && !(mrTex && mrE && mrE.hasM);
                const rFlat = !texd('RoughnessPBR') && !(mrTex && mrE && mrE.hasR);
                if (mrTex && !(mrE && mrE.hasM)) pbr.metallicFactor = 0;   // non-metal unless a flat value follows
                if (mt && mt.enable && typeof mt.factor === 'number' && mFlat) {
                    pbr.metallicFactor = CONFIG.FLAT_MR_FROM_VIEWER ? mt.factor : 0; did.push('metalness');
                }
                if (rg && rg.enable && typeof rg.factor === 'number' && rFlat) {
                    pbr.roughnessFactor = CONFIG.FLAT_MR_FROM_VIEWER ? rg.factor : 0.5; did.push('roughness');
                }
                const op = flat.Opacity || flat.AlphaMask;
                if (op && op.enable && pbr.baseColorTexture && !m.alphaMode && _opacityOneFile[sanitizeTextureName(m.name)]) {
                    const isBlend = !!flat.Opacity && /blend/i.test(String(op.type || ''));
                    m.alphaMode = isBlend ? 'BLEND' : 'MASK';
                    if (!isBlend) m.alphaCutoff = 0.5;
                    did.push(`opacity ${m.alphaMode} (${op.type})`);
                }
                // Opacity given as a plain value (no mask image): use it as base colour alpha.
                const opf = flat.Opacity;
                if (opf && opf.enable && !m.alphaMode && !texd('Opacity') && typeof opf.factor === 'number' && opf.factor < 0.999) {
                    if (!pbr.baseColorFactor) pbr.baseColorFactor = [1, 1, 1, 1];
                    pbr.baseColorFactor[3] = Math.max(0, Math.min(1, opf.factor));
                    m.alphaMode = 'BLEND';
                    did.push(`opacity ${pbr.baseColorFactor[3].toFixed(2)} (${opf.type})`);
                }
                if (mt && mt.enable === false && mFlat) {
                    pbr.metallicFactor = 0; did.push('metalness off');
                }
                const em = flat.EmitColor;
                if (em && em.enable && em.color && !m.emissiveTexture && !texd('EmitColor')) {
                    const ef = (typeof em.factor === 'number') ? em.factor : 1;
                    const ev = [Math.min(1, em.color[0] * ef), Math.min(1, em.color[1] * ef), Math.min(1, em.color[2] * ef)];
                    if (ev[0] > 0 || ev[1] > 0 || ev[2] > 0) { m.emissiveFactor = ev; did.push('emission'); }
                }
                if (did.length) log(`material ${m.name}: flat values from material model (${did.join(', ')})`);
            });

            // Sketchfab can render a model two-sided (Inspector: Single Sided OFF), which glTF
            // expresses per material. We cannot read that setting yet, so it is a manual option.
            if (CONFIG.DOUBLE_SIDED) {
                const singleNames = [];
                mats.forEach((m, mi) => {
                    const cv = matsFlat[mi] ? matsFlat[mi].__cull : undefined;   // 1029 (GL_BACK) = Single Sided ON, 0 = OFF
                    const on = !(cv === undefined || cv === null || cv === 0 || cv === false || /^(none|0|false|off)?$/i.test(String(cv)));
                    if (CONFIG.DOUBLE_SIDED_AUTO && on) { singleNames.push(m.name); return; }
                    m.doubleSided = true;
                });
                log('materials marked doubleSided: ' + (mats.length - singleNames.length) + ' of ' + mats.length +
                    (singleNames.length ? ` (single sided in the viewer: ${singleNames.join(', ')})` : ''));
            }

            // ---- animation clips (multi-clip aware) ----
            const mlA = document.getElementsByClassName('model-name__label')[0];
            const animBase = mlA ? mlA.textContent.trim().replace(/\.+$/, '') : 'model';
            let clipSets = [];
            if (window.clips && window.clips.length > 1) {
                window.clips.forEach((c) => {
                    if (c && c.frames && c.frames.length > 1) {
                        clipSets.push({ name: c.name, frames: c.frames });
                    }
                });
            }
            if (clipSets.length > 1) {
                log(`export: multi-clip mode, clips=${clipSets.length}`);
            } else {
                // single-clip path: same data source and behaviour as before
                clipSets = (window.recordedFrames.length > 1)
                    ? [{ name: `${animBase}_anim`, frames: window.recordedFrames }] : [];
            }
            const hasFrames = clipSets.length > 0;
            const liveSnap = hasFrames ? null : snapshotFrame().meshes;
            const gltfSkins = [];
            let animations;

            // One sampler + channel. With REDUCE_KEYS, keys that interpolation already reproduces are left
            // out and the channel gets its own, shorter time accessor. timeAccFn creates the full time
            // accessor only when it is used, so no unused data is written.
            const keyStats = { before: 0, after: 0 };
            function lazyTimeAcc(times) {
                let idx = -1;
                return () => {
                    if (idx < 0) {
                        idx = accs.length;
                        accs.push({ bufferView: addBV(new Float32Array(times)), componentType: 5126, count: times.length,
                                    type: 'SCALAR', min: [times[0]], max: [times[times.length - 1]] });
                    }
                    return idx;
                };
            }
            function emitSampler(tr, times, timeAccFn, data, n, type, nodeIdx, path, transTol) {
                let outArr = data, count = times.length, tAcc = -1, q, c;
                if (CONFIG.REDUCE_KEYS && count > 2) {
                    let tol;
                    if (path === 'rotation') tol = 1e-4;
                    else if (path === 'scale') {
                        let mxa = 0;
                        for (q = 0; q < data.length; q++) if (Math.abs(data[q]) > mxa) mxa = Math.abs(data[q]);
                        tol = 1e-4 * mxa;
                    } else tol = transTol;
                    const keep = reduceKeys(times, data, n, tol, path === 'rotation', 32);
                    keyStats.before += count; keyStats.after += keep.length;
                    if (keep.length < count) {
                        const nt = [], nd = [];
                        for (q = 0; q < keep.length; q++) {
                            nt.push(times[keep[q]]);
                            for (c = 0; c < n; c++) nd.push(data[keep[q] * n + c]);
                        }
                        outArr = nd; count = keep.length;
                        tAcc = accs.length;
                        accs.push({ bufferView: addBV(new Float32Array(nt)), componentType: 5126, count,
                                    type: 'SCALAR', min: [nt[0]], max: [nt[count - 1]] });
                    }
                }
                if (tAcc < 0) tAcc = timeAccFn();
                const aO = accs.length;
                accs.push({ bufferView: addBV(new Float32Array(outArr)), componentType: 5126, count, type });
                tr.samplers.push({ input: tAcc, interpolation: 'LINEAR', output: aO });
                tr.channels.push({ sampler: tr.samplers.length - 1, target: { node: nodeIdx, path } });
            }

            // One time accessor + sampler/channel lists per clip.
            const tracks = clipSets.map((cs) => {
                // Start every clip at exactly t = 0 (the single-clip recorder's first frame
                // lands ~16 ms after the start). Store float32-rounded values so the
                // accessor min/max match the buffer exactly.
                const tFirst = cs.frames[0].time;
                const times = cs.frames.map((f) => Math.fround(f.time - tFirst));
                // The time accessor is created on first use, so a clip without motion adds no unused data.
                let tAcc = -1;
                const trk = { name: cs.name, frames: cs.frames, times, samplers: [], channels: [] };
                Object.defineProperty(trk, 'timeAcc', {
                    enumerable: true,
                    get: () => {
                        if (tAcc < 0) {
                            const tV = addBV(new Float32Array(times));
                            tAcc = accs.length;
                            accs.push({ bufferView: tV, componentType: 5126, count: times.length,
                                        type: 'SCALAR', min: [times[0]], max: [times[times.length - 1]] });
                        }
                        return tAcc;
                    }
                });
                return trk;
            });

            function expandMat3x4(pal, boneIdx) {
                const b = boneIdx * 12;
                return [
                    pal[b + 0], pal[b + 4], pal[b + 8], 0,
                    pal[b + 1], pal[b + 5], pal[b + 9], 0,
                    pal[b + 2], pal[b + 6], pal[b + 10], 0,
                    pal[b + 3], pal[b + 7], pal[b + 11], 1
                ];
            }

            let staticWarned = false;
            allNodes.forEach((obj, mIdx) => {
                if (!meshHasSkinning[mIdx]) return;

                const meshNodeIdx = nodeMap.get(obj);
                if (meshNodeIdx === undefined) return;

                let jointCount = meshHasSkinning[mIdx];
                let paletteRef = null;
                if (hasFrames) {
                    const refFrames = tracks[0].frames;
                    for (let fi = 0; fi < refFrames.length; fi++) {
                        const fm = refFrames[fi].meshes[mIdx];
                        if (fm && fm.palette) {
                            const fromPal = (fm.palette.length / 12) | 0;
                            if (fromPal > jointCount) jointCount = fromPal;
                            paletteRef = fm;
                            break;
                        }
                    }
                }

                const W_mesh = computeWorldMatrix(obj);

                const skelRootIdx = nodes.length;
                nodes.push({ name: `skel_root_${mIdx}`, matrix: W_mesh, children: [] });

                const jointNodeIndices = [];
                for (let ji = 0; ji < jointCount; ji++) {
                    const jIdx = nodes.length;
                    nodes.push({ name: `joint_${mIdx}_${ji}`, children: [] });
                    nodes[skelRootIdx].children.push(jIdx);
                    jointNodeIndices.push(jIdx);
                }

                const ibmFlat = new Float32Array(jointCount * 16);
                for (let pi2 = 0; pi2 < jointCount; pi2++) {
                    ibmFlat[pi2 * 16 + 0]  = 1;
                    ibmFlat[pi2 * 16 + 5]  = 1;
                    ibmFlat[pi2 * 16 + 10] = 1;
                    ibmFlat[pi2 * 16 + 15] = 1;
                }
                const ibmV = addBV(ibmFlat);
                const ibmA = accs.length;
                accs.push({ bufferView: ibmV, componentType: 5126,
                            count: jointCount, type: 'MAT4' });

                const skinIdx = gltfSkins.length;
                gltfSkins.push({
                    inverseBindMatrices: ibmA,
                    joints: jointNodeIndices,
                    skeleton: skelRootIdx
                });

                nodes[meshNodeIdx].skin = skinIdx;
                delete nodes[meshNodeIdx].matrix;

                let decErr = { max: 0, joint: -1, frame: -1, bad: 0 }, holdJoints = 0, ibmFixed = 0;
                // Joints whose matrix has shear get a helper parent node: helper = T*U*S, joint = V^T (exact).
                const helperOf = {};
                function makeHelper(jx) {
                    if (helperOf[jx] !== undefined) return helperOf[jx];
                    const jNode = jointNodeIndices[jx], hIdx = nodes.length;
                    nodes.push({ name: `joint_${mIdx}_${jx}_shear`, children: [jNode] });
                    const kids = nodes[skelRootIdx].children, kp = kids.indexOf(jNode);
                    if (kp >= 0) kids[kp] = hIdx; else kids.push(hIdx);
                    helperOf[jx] = hIdx;
                    return hIdx;
                }
                // Preferred fix for shear: a constant right rotation Q (the SVD's V) goes into the inverse bind
                // matrix (IBM = Q^T) and the joint itself is P*Q = T*U*S, a plain TRS node. Blender can import that
                // exactly (its bones cannot hold a scaled helper node). Only used when Q is constant over all frames.
                const ibmQ = {};
                function q4FromV(V) { return [V[0][0], V[0][1], V[0][2], 0, V[1][0], V[1][1], V[1][2], 0, V[2][0], V[2][1], V[2][2], 0, 0, 0, 0, 1]; }
                function setIbmQ(jx, Q) {
                    ibmQ[jx] = Q;
                    let o = jx * 16, r, c;
                    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) ibmFlat[o + c * 4 + r] = Q[r * 4 + c];   // transpose (inverse of a rotation)
                }
                function setShearRest(jx, mat) {
                    const hx = makeHelper(jx), sd = svdDecompose(mat, null), jNode = jointNodeIndices[jx];
                    nodes[hx].translation = sd.translation; nodes[hx].rotation = sd.rotU; nodes[hx].scale = sd.scale;
                    nodes[jNode].rotation = sd.rotV;
                    delete nodes[jNode].translation; delete nodes[jNode].scale;
                }
                const shearJ = {};
                if (hasFrames && paletteRef) {
                    for (let sjn = 0; sjn < jointCount; sjn++) {
                        for (let stk = 0; stk < tracks.length && !shearJ[sjn]; stk++) {
                            const sfr = tracks[stk].frames;
                            for (let sfi = 0; sfi < sfr.length; sfi++) {
                                const sfm = sfr[sfi].meshes[mIdx], spal = sfm && sfm.palette;
                                if (!spal || spal.length < (sjn + 1) * 12) continue;
                                const serr = trsError(expandMat3x4(spal, sjn));
                                if (serr > decErr.max) { decErr.max = serr; decErr.joint = sjn; decErr.frame = sfi; }
                                if (serr > 1e-3) { shearJ[sjn] = true; decErr.bad++; break; }
                            }
                        }
                        if (!shearJ[sjn]) continue;
                        // Constant right rotation? Take V from the first non-uniform frame, then check every frame.
                        let qCand = null, qOk = true, qMax = 0;
                        for (let qt = 0; qt < tracks.length && !qCand; qt++) {
                            const qfr = tracks[qt].frames;
                            for (let qf = 0; qf < qfr.length; qf++) {
                                const qfm = qfr[qf].meshes[mIdx], qpal = qfm && qfm.palette;
                                if (!qpal || qpal.length < (sjn + 1) * 12) continue;
                                const qsd = svdDecompose(expandMat3x4(qpal, sjn), null);
                                if (!qsd.uniform) { qCand = q4FromV(qsd.V); break; }
                            }
                        }
                        if (!qCand) continue;
                        for (let qt2 = 0; qt2 < tracks.length && qOk; qt2++) {
                            const qfr2 = tracks[qt2].frames;
                            for (let qf2 = 0; qf2 < qfr2.length; qf2++) {
                                const qfm2 = qfr2[qf2].meshes[mIdx], qpal2 = qfm2 && qfm2.palette;
                                if (!qpal2 || qpal2.length < (sjn + 1) * 12) continue;
                                const qe = trsError(mulMat4(expandMat3x4(qpal2, sjn), qCand));
                                if (qe > qMax) qMax = qe;
                                if (qe > 1e-3) { qOk = false; break; }
                            }
                        }
                        if (qOk) { setIbmQ(sjn, qCand); shearJ[sjn] = false; ibmFixed++; }
                    }
                }
                if (hasFrames && paletteRef) {
                    let animatedCount = 0;
                    const animatedJoints = {};
                    // Does this joint's TRS vary across the clip's own frames? (compared to the clip's FIRST frame,
                    // so slow drift is caught)
                    const jointClipMoves = (jx, cx) => {
                        let frC = tracks[cx].frames, prev = null;
                        for (let fj = 0; fj < frC.length; fj++) {
                            const fmeshJ = frC[fj].meshes[mIdx];
                            const palJ = fmeshJ && fmeshJ.palette;
                            const mJ = (palJ && palJ.length >= (jx + 1) * 12)
                                   ? expandMat3x4(palJ, jx) : identityMat4();
                            if (prev !== null) {
                                for (let vv = 0; vv < 16; vv++) {
                                    if (Math.abs(mJ[vv] - prev[vv]) > 1e-5 * Math.max(1, Math.abs(prev[vv]))) return true;
                                }
                            } else prev = mJ;
                        }
                        return false;
                    };
                    // Rest pose palette, chosen as in the rest pose code below (without its log lines).
                    const smE = window.staticPoseSnapshot && window.staticPoseSnapshot.meshes[mIdx];
                    const restPalE = (CONFIG.REST_POSE_SOURCE === 'static' && smE && smE.palette &&
                                    smE.palette.length >= paletteRef.palette.length) ? smE.palette : paletteRef.palette;
                    // A joint that does not move in a clip but is held away from the rest pose needs a constant
                    // pose in that clip. Without it, a glTF player shows the rest pose for that joint.
                    const jointDiffersFromRest = (jx, cx) => {
                        const f0 = tracks[cx].frames[0].meshes[mIdx], p0 = f0 && f0.palette;
                        if (!p0 || p0.length < (jx + 1) * 12 || restPalE.length < (jx + 1) * 12) return false;
                        const a = expandMat3x4(p0, jx), b = expandMat3x4(restPalE, jx);
                        for (let dv = 0; dv < 16; dv++) {
                            if (Math.abs(a[dv] - b[dv]) > 1e-5 * Math.max(1, Math.abs(b[dv]))) return true;
                        }
                        return false;
                    };
                    // Still clip: no joint of this skeleton moves in it. Keep still clips: every joint gets a pose
                    // (2 equal keys). Otherwise the clip gets no skeleton channels.
                    let stillClip = [], nStill = 0;
                    for (let sc = 0; sc < tracks.length; sc++) {
                        let scMoves = false;
                        for (let sjx = 0; sjx < jointCount && !scMoves; sjx++) scMoves = jointClipMoves(sjx, sc);
                        stillClip[sc] = !scMoves;
                        if (!scMoves) nStill++;
                    }
                    if (nStill && CONFIG.KEEP_STILL_CLIPS) log(`skin ${skinIdx}: keeping ${nStill} still clip(s) as pose clips`);
                    let holdPoses = 0;
                    for (let jn = 0; jn < jointCount; jn++) {
                        // Per-clip motion test: clips where this joint varies get its keys. A clip where it does
                        // not vary gets a constant pose only when that pose is not the rest pose.
                        const clipHasMotion = [], clipNeeds = [];
                        let anyMotion = false, anyNeed = false;
                        for (let cj = 0; cj < tracks.length; cj++) {
                            clipHasMotion[cj] = jointClipMoves(jn, cj);
                            if (clipHasMotion[cj]) { anyMotion = true; tracks[cj].moving = true; }
                            clipNeeds[cj] = clipHasMotion[cj] ||
                                (stillClip[cj] ? !!CONFIG.KEEP_STILL_CLIPS : jointDiffersFromRest(jn, cj));
                            if (clipNeeds[cj]) anyNeed = true;
                        }
                        if (!anyNeed) continue;
                        if (anyMotion) animatedCount++;
                        const nIdx = jointNodeIndices[jn];
                        animatedJoints[nIdx] = true;

                        for (let ci = 0; ci < tracks.length; ci++) {
                            if (!clipNeeds[ci]) continue;
                            const poseOnly = !clipHasMotion[ci];   // one pose from the clip's first frame
                            if (poseOnly && !stillClip[ci]) holdPoses++;
                            const tr = tracks[ci];
                            const useN = poseOnly ? 1 : tr.frames.length;
                            let T = [], R = [], S = [], RV = [];
                            let prevQ = null, prevQV = null, prevV = null;   // hemisphere fix resets per clip, per joint
                            const tgtTRS = shearJ[jn] ? makeHelper(jn) : nIdx;   // sheared joint: T/R/S go on the helper
                            let svdSeq = null;
                            if (shearJ[jn]) {
                                const smats = [];
                                for (let sfx = 0; sfx < useN; sfx++) {
                                    const sfmx = tr.frames[sfx].meshes[mIdx], spx = sfmx && sfmx.palette;
                                    smats.push((spx && spx.length >= (jn + 1) * 12) ? expandMat3x4(spx, jn) : identityMat4());
                                }
                                svdSeq = svdSequence(smats);
                            }
                            for (let fi3 = 0; fi3 < useN; fi3++) {
                                const fmesh = tr.frames[fi3].meshes[mIdx];
                                const pal = fmesh && fmesh.palette;
                                let mPal = (pal && pal.length >= (jn + 1) * 12)
                                         ? expandMat3x4(pal, jn) : identityMat4();
                                if (ibmQ[jn]) mPal = mulMat4(mPal, ibmQ[jn]);
                                if (shearJ[jn]) {
                                    const sd3 = svdSeq[fi3];
                                    const qU = _quatCont(sd3.rotU, prevQ), qV = _quatCont(sd3.rotV, prevQV);
                                    prevQ = qU; prevQV = qV;
                                    T.push(sd3.translation[0], sd3.translation[1], sd3.translation[2]);
                                    R.push(qU[0], qU[1], qU[2], qU[3]);
                                    S.push(sd3.scale[0], sd3.scale[1], sd3.scale[2]);
                                    RV.push(qV[0], qV[1], qV[2], qV[3]);
                                    continue;
                                }
                                const d = decomposeMat4(mPal);
                                if (prevQ) {
                                    const dot = d.rotation[0]*prevQ[0] + d.rotation[1]*prevQ[1]
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

                            // Show/hide by scale (scale jumps between ~0 and visible from one sample to the next): the
                            // viewer switches instantly, LINEAR would blend both shapes between the two samples. Hold the old
                            // value until just before the next sample so the switch stays near-instant.
                            let jTimes = tr.times, jTimeFn = ((t0) => () => t0.timeAcc)(tr);
                            if (poseOnly) {
                                // two equal keys, at the start and the end of the clip, so the clip keeps its length
                                T = T.concat(T); R = R.concat(R); S = S.concat(S); if (RV.length) RV = RV.concat(RV);
                                jTimes = [tr.times[0], tr.times[tr.times.length - 1]];
                                jTimeFn = lazyTimeAcc(jTimes);
                            }
                            (() => {
                                if (poseOnly) return;
                                let nF = jTimes.length, mags = [], mxs = 0, hi, hk;
                                for (hi = 0; hi < nF; hi++) {
                                    const mg = Math.max(Math.abs(S[hi * 3]), Math.abs(S[hi * 3 + 1]), Math.abs(S[hi * 3 + 2]));
                                    mags.push(mg); if (mg > mxs) mxs = mg;
                                }
                                if (!(mxs > 0)) return;
                                const lo = 1e-4 * mxs, vis = 0.1 * mxs, cuts = [];
                                for (hi = 0; hi + 1 < nF; hi++) {
                                    const a0 = mags[hi], a1 = mags[hi + 1];
                                    if ((a0 <= lo && a1 >= vis) || (a1 <= lo && a0 >= vis)) cuts.push(hi);
                                }
                                if (!cuts.length) return;
                                let nt = [], nT = [], nR = [], nS = [], nRV = [], ci3 = 0;
                                function pushF(src, t) {
                                    nt.push(t);
                                    for (hk = 0; hk < 3; hk++) { nT.push(T[src * 3 + hk]); nS.push(S[src * 3 + hk]); }
                                    for (hk = 0; hk < 4; hk++) { nR.push(R[src * 4 + hk]); if (RV.length) nRV.push(RV[src * 4 + hk]); }
                                }
                                for (hi = 0; hi < nF; hi++) {
                                    pushF(hi, jTimes[hi]);
                                    if (ci3 < cuts.length && cuts[ci3] === hi) {
                                        const gap = jTimes[hi + 1] - jTimes[hi];
                                        if (gap > 2e-4) pushF(hi, Math.fround(jTimes[hi + 1] - Math.min(0.001, gap * 0.5)));
                                        ci3++;
                                    }
                                }
                                T = nT; R = nR; S = nS; if (RV.length) RV = nRV;
                                jTimes = nt;
                                jTimeFn = lazyTimeAcc(nt);
                                holdJoints++;
                            })();

                            const tolJ = 1e-5 * (sceneSizeLocal || 1);
                            emitSampler(tr, jTimes, jTimeFn, T, 3, 'VEC3', tgtTRS, 'translation', tolJ);
                            emitSampler(tr, jTimes, jTimeFn, R, 4, 'VEC4', tgtTRS, 'rotation', tolJ);
                            emitSampler(tr, jTimes, jTimeFn, S, 3, 'VEC3', tgtTRS, 'scale', tolJ);
                            if (shearJ[jn]) emitSampler(tr, jTimes, jTimeFn, RV, 4, 'VEC4', nIdx, 'rotation', tolJ);
                        }
                    }

                    // Give every joint its rest-pose TRS as the node default.
                    // Animation channels override this where present. Without
                    // it, a joint that has animation would collapse to identity
                    // (origin) when no animation is playing.
                    // Rest pose source: the first frame of the first clip, or the viewer's
                    // Static Pose snapshot (REST_POSE_SOURCE). Static falls back to the clip
                    // frame when no usable snapshot exists (e.g. single-clip RECORD).
                    let restPal = paletteRef.palette;
                    const sm = window.staticPoseSnapshot && window.staticPoseSnapshot.meshes[mIdx];
                    const staticOk = !!(sm && sm.palette && sm.palette.length >= paletteRef.palette.length);
                    if (staticOk) {
                        let diffJ = 0;
                        for (let dj = 0; dj < jointCount; dj++) {
                            for (let dk = 0; dk < 12; dk++) {
                                const di = dj * 12 + dk;
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
                    let restSkipped = 0;
                    for (let sj = 0; sj < jointCount; sj++) {
                        const jnIdx = jointNodeIndices[sj];
                        if ((sj + 1) * 12 > restPal.length || jnIdx === undefined) {
                            restSkipped++;   // palette shorter than the joint list: leave node default
                            continue;
                        }
                        let pal0 = expandMat3x4(restPal, sj);
                        if (ibmQ[sj]) pal0 = mulMat4(pal0, ibmQ[sj]);
                        else if (!shearJ[sj] && !animatedJoints[jnIdx] && trsError(pal0) > 1e-3) {
                            setIbmQ(sj, q4FromV(svdDecompose(pal0, null).V)); ibmFixed++;   // static joint: P*Q is exact TRS
                            pal0 = mulMat4(pal0, ibmQ[sj]);
                        }
                        if (shearJ[sj]) { setShearRest(sj, pal0); continue; }
                        const d0 = decomposeMat4(pal0);
                        nodes[jnIdx].translation = d0.translation;
                        nodes[jnIdx].rotation = d0.rotation;
                        nodes[jnIdx].scale = d0.scale;
                    }

                    if (restSkipped) warn('skin', skinIdx, ': rest pose skipped for', restSkipped, 'joint(s), palette too short');
                    log('skin', skinIdx, 'for mesh', meshes[nodes[meshNodeIdx].mesh].name,
                        '→', jointCount, 'joints,', animatedCount, 'animated,',
                        tracks.length, 'clip(s)');
                    if (holdPoses) log(`skin ${skinIdx}: ${holdPoses} joint pose(s) held in clips where the joint does not move but is away from the rest pose`);
                    if (holdJoints) log(`skin ${skinIdx}: ${holdJoints} joint channel set(s) with show/hide-by-scale switches kept instant (hold keys)`);
                    if (ibmFixed) log(`skin ${skinIdx}: ${ibmFixed} sheared joint(s) stored exactly via the inverse bind matrix (plain TRS joints)`);
                    let nHelp = 0; for (let hk in helperOf) if (helperOf.hasOwnProperty(hk)) nHelp++;
                    if (nHelp) log('skin ' + skinIdx + ': ' + nHelp + ' joint(s) with shear (max ' + (decErr.max * 100).toFixed(1) +
                        '% TRS error at joint ' + decErr.joint + ') stored exactly as helper node + joint (U*S*Vt)');
                } else {
                    const live = liveSnap && liveSnap[mIdx];
                    if (live && live.palette) {
                        for (let sj2 = 0; sj2 < jointCount; sj2++) {
                            if ((sj2 + 1) * 12 > live.palette.length) break;
                            let lm = expandMat3x4(live.palette, sj2);
                            if (trsError(lm) > 1e-3) { setIbmQ(sj2, q4FromV(svdDecompose(lm, null).V)); lm = mulMat4(lm, ibmQ[sj2]); ibmFixed++; }
                            const dl = decomposeMat4(lm);
                            const jn2 = jointNodeIndices[sj2];
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
                let T = [], R = [], S = [], prevQ = null;
                for (let fi4 = 0; fi4 < tr.frames.length; fi4++) {
                    const d4 = decomposeMat4(matAt(fi4));
                    if (prevQ) {
                        const dot4 = d4.rotation[0]*prevQ[0] + d4.rotation[1]*prevQ[1]
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
                const tolN = 1e-5 * (sceneSizeWorld || 1);
                const trFn = () => tr.timeAcc;
                emitSampler(tr, tr.times, trFn, T, 3, 'VEC3', nIdx, 'translation', tolN);
                emitSampler(tr, tr.times, trFn, R, 4, 'VEC4', nIdx, 'rotation', tolN);
                emitSampler(tr, tr.times, trFn, S, 3, 'VEC3', nIdx, 'scale', tolN);
            }

            if (hasFrames) {
                allNodes.forEach((obj, mIdx) => {
                    const nodeIdx = nodeMap.get(obj);
                    if (nodeIdx === undefined || nodes[nodeIdx].mesh === undefined) return;

                    // node motion: the recorded world matrix changes within a clip
                    if (!meshHasSkinning[mIdx]) {
                        let moves = [], anyMove = false;
                        tracks.forEach((trk, ti) => {
                            let f0 = trk.frames[0].meshes[mIdx], w0 = f0 && f0.world, moved = false;
                            for (let fm2 = 1; w0 && fm2 < trk.frames.length && !moved; fm2++) {
                                const fw = trk.frames[fm2].meshes[mIdx], wn = fw && fw.world;
                                if (!wn) continue;
                                for (let wv = 0; wv < 16; wv++) {
                                    if (Math.abs(wn[wv] - w0[wv]) > 1e-5 * Math.max(1, Math.abs(w0[wv]))) { moved = true; break; }
                                }
                            }
                            moves[ti] = moved;
                            if (moved) anyMove = true;
                        });
                        if (anyMove) {
                            const r0m = tracks[0].frames[0].meshes[mIdx];
                            const rest0 = (r0m && r0m.world) ? r0m.world : computeWorldMatrix(obj);
                            const dRest = decomposeMat4(rest0);
                            delete nodes[nodeIdx].matrix;
                            nodes[nodeIdx].translation = dRest.translation;
                            nodes[nodeIdx].rotation = dRest.rotation;
                            nodes[nodeIdx].scale = dRest.scale;
                            tracks.forEach((trk, ti) => {
                                if (moves[ti]) trk.moving = true;
                            });
                            let nodeHolds = 0;
                            tracks.forEach((trk, ti) => {
                                if (!moves[ti]) {
                                    // Still in this clip: hold its pose if that is not the rest pose (and the clip moves).
                                    let h0 = trk.frames[0].meshes[mIdx], hw = h0 && h0.world, away = false;
                                    for (let hv = 0; hw && hv < 16 && !away; hv++) {
                                        if (Math.abs(hw[hv] - rest0[hv]) > 1e-5 * Math.max(1, Math.abs(rest0[hv]))) away = true;
                                    }
                                    if (!away || !(trk.moving || CONFIG.KEEP_STILL_CLIPS)) return;
                                    nodeHolds++;
                                }
                                emitNodeTRS(trk, nodeIdx, (f) => {
                                    const fx = trk.frames[f].meshes[mIdx];
                                    return (fx && fx.world) || rest0;
                                });
                            });
                            log('node animation: ' + nodes[nodeIdx].name + ' moves in ' +
                                moves.filter((x) => x).length + ' clip(s)' +
                                (nodeHolds ? `, pose held in ${nodeHolds} clip(s)` : ''));
                        }
                    }

                    // morph weights
                    const mi2 = morphInfo[mIdx];
                    if (mi2) {
                        const wRest = tracks[0].frames[0].meshes[mIdx];
                        const wr = (wRest && wRest.weights) || null;
                        if (wr) {
                            const restW = [];
                            for (let rw = 0; rw < mi2.n; rw++) restW.push(wr[rw] || 0);
                            meshes[mi2.meshIdx].weights = restW;
                        }
                        tracks.forEach((trk) => {
                            let base = trk.frames[0].meshes[mIdx], bw = base && base.weights, varies = false;
                            if (!bw) return;
                            let restOff = false;   // constant in this clip, but not the rest weights
                            if (wr) for (let rk = 0; rk < mi2.n && !restOff; rk++) {
                                if (Math.abs((bw[rk] || 0) - (wr[rk] || 0)) > 1e-4) restOff = true;
                            }
                            for (let fw2 = 1; fw2 < trk.frames.length && !varies; fw2++) {
                                const ww = trk.frames[fw2].meshes[mIdx];
                                const wv2 = ww && ww.weights;
                                if (!wv2) continue;
                                for (let kk = 0; kk < mi2.n; kk++) {
                                    if (Math.abs((wv2[kk] || 0) - (bw[kk] || 0)) > 1e-4) { varies = true; break; }
                                }
                            }
                            if (varies) trk.moving = true;
                            else if (!restOff || !(trk.moving || CONFIG.KEEP_STILL_CLIPS)) return;
                            const out = new Float32Array(trk.frames.length * mi2.n);
                            for (let fw3 = 0; fw3 < trk.frames.length; fw3++) {
                                const wm = trk.frames[fw3].meshes[mIdx], wa = (wm && wm.weights) || bw;
                                for (let kw = 0; kw < mi2.n; kw++) out[fw3 * mi2.n + kw] = wa[kw] || 0;
                            }
                            const aWt = accs.length;
                            accs.push({ bufferView: addBV(out), componentType: 5126,
                                        count: out.length, type: 'SCALAR' });
                            trk.samplers.push({ input: trk.timeAcc, interpolation: 'LINEAR', output: aWt });
                            trk.channels.push({ sampler: trk.samplers.length - 1,
                                                target: { node: nodeIdx, path: 'weights' } });
                            log(`morph animation: ${nodes[nodeIdx].name} (${mi2.n} target(s))${varies ? '' : ', weights held'}`);
                        });
                    }
                });
            }

            if (tracks.length) {
                const animList = [];
                const noMotion = [];
                tracks.forEach((tr) => {
                    if (tr.channels.length) {
                        animList.push({ name: tr.name, samplers: tr.samplers, channels: tr.channels });
                        log('animation "' + tr.name + '": ' + tr.channels.length + ' channels, '
                            + tr.times.length + ' frames');
                    } else {
                        noMotion.push(tr.name);
                    }
                });
                if (noMotion.length) log(`clips without motion, not exported (${noMotion.length}): ${noMotion.join(', ')}`);
                if (keyStats.before) log('keyframes reduced: ' + keyStats.before + ' -> ' + keyStats.after + ' (' +
                    Math.round(100 * keyStats.after / keyStats.before) + '% kept, translation tolerance ' + (1e-5 * (sceneSizeLocal || 1)).toPrecision(2) + ')');
                if (animList.length) animations = animList;
            }

            // Scene root with YUP
            let sceneRootIdx = nodes.length;
            const rootMat = YUP.slice();
            const expScale = (typeof CONFIG.EXPORT_SCALE === 'number' && CONFIG.EXPORT_SCALE > 0) ? CONFIG.EXPORT_SCALE : 1;
            if (expScale !== 1) {
                [0, 1, 2, 4, 5, 6, 8, 9, 10].forEach((ix) => { rootMat[ix] *= expScale; });
                log('export scale', expScale);
            }
            nodes.push({ name: 'scene_root', matrix: rootMat, children: [] });

            const naturalRoots = [];
            nodes.forEach((n, i) => {
                if (i === sceneRootIdx || skippedNodes[i]) return;
                let hasP = false;
                for (let j = 0; j < nodes.length; j++) {
                    if (nodes[j].children && nodes[j].children.indexOf(i) !== -1) { hasP = true; break; }
                }
                if (!hasP) naturalRoots.push(i);
            });
            naturalRoots.forEach((r) => {
                nodes[sceneRootIdx].children.push(r);
            });
            if (Object.keys(skippedNodes).length) {
                sceneRootIdx = removeNodes(nodes, gltfSkins, animations, skippedNodes, sceneRootIdx);
            }

            nodes.forEach((n, ni) => {
                if (ni === sceneRootIdx || !n.matrix) return;
                let idm = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], same = n.matrix.length === 16;
                for (let im = 0; same && im < 16; im++) if (Math.abs(n.matrix[im] - idm[im]) > 1e-9) same = false;
                if (same) delete n.matrix;   // validator NODE_MATRIX_DEFAULT
            });

            const rootNodes = [sceneRootIdx];
            nodes.forEach((n) => {
                if (n.children && n.children.length === 0) delete n.children;
            });

            const gltf = {
                asset: { version: '2.0' },
                scene: 0,
                scenes: [{ nodes: rootNodes }],
                nodes,
                meshes,
                accessors: accs,
                bufferViews: bvs,
                materials: mats,
                buffers: [{ byteLength: off }]
            };
            // Drop textures no material references (captured env/matcap/leftover images) and remap indices.
            const texUsed = {}, texNew = {}, keptImages = [], keptTextures = [], zipTex = {};
            function markTex(o) { if (o && typeof o.index === 'number') texUsed[o.index] = true; }
            mats.forEach((m) => {
                const pb = m.pbrMetallicRoughness || {};
                markTex(pb.baseColorTexture); markTex(pb.metallicRoughnessTexture);
                markTex(m.normalTexture); markTex(m.occlusionTexture); markTex(m.emissiveTexture);
            });
            for (let ti2 = 0; ti2 < textures.length; ti2++) {
                if (!texUsed[ti2]) continue;
                texNew[ti2] = keptTextures.length;
                keptImages.push({ uri: images[textures[ti2].source].uri });
                keptTextures.push({ source: keptImages.length - 1 });
                zipTex[imageKeys[textures[ti2].source].key] = imageKeys[textures[ti2].source].safe;
            }
            function remapTex(o) { if (o && typeof o.index === 'number') o.index = texNew[o.index]; }
            mats.forEach((m) => {
                const pb = m.pbrMetallicRoughness || {};
                remapTex(pb.baseColorTexture); remapTex(pb.metallicRoughnessTexture);
                remapTex(m.normalTexture); remapTex(m.occlusionTexture); remapTex(m.emissiveTexture);
            });
            if (keptTextures.length !== textures.length) log(`textures: ${keptTextures.length} used, ${textures.length - keptTextures.length} unused dropped`);
            images = keptImages; textures = keptTextures;
            // glTF forbids empty arrays (validator: EMPTY_ENTITY), so texture-less models omit these.
            if (images.length) gltf.images = images;
            if (textures.length) gltf.textures = textures;
            if (gltfSkins.length) gltf.skins = gltfSkins;
            if (animations) gltf.animations = animations;

            log(`built scene: nodes=${nodes.length}`,
                `meshes=${meshes.length}`,
                `skins=${gltfSkins.length}`,
                `animClips=${animations ? animations.length : 0}`,
                `animFrames=${animations ? tracks[0].times.length : 0}`);

            const jsonStr = JSON.stringify(gltf);
            const jsonBytes = new TextEncoder().encode(jsonStr);
            const jAl = pad(jsonBytes.byteLength), jPad = jAl - jsonBytes.byteLength;
            let binAll = new Uint8Array(off), binPos = 0;
            for (let bc = 0; bc < binChunks.length; bc++) {
                binAll.set(binChunks[bc], binPos);
                binPos += binChunks[bc].length;
            }
            const bin = binAll.buffer;
            const bAl = pad(bin.byteLength), bPad = bAl - bin.byteLength;
            const total = 12 + 8 + jAl + 8 + bAl;

            const glb = new ArrayBuffer(total);
            let dv = new DataView(glb), o = 0;
            dv.setUint32(o, 0x46546C67, true); o += 4;
            dv.setUint32(o, 2, true); o += 4;
            dv.setUint32(o, total, true); o += 4;
            dv.setUint32(o, jAl, true); o += 4;
            dv.setUint32(o, 0x4E4F534A, true); o += 4;
            new Uint8Array(glb, o, jsonBytes.length).set(jsonBytes); o += jsonBytes.length;
            for (let k1 = 0; k1 < jPad; k1++) new Uint8Array(glb, o + k1, 1)[0] = 0x20;
            o += jPad;
            dv.setUint32(o, bAl, true); o += 4;
            dv.setUint32(o, 0x004E4942, true); o += 4;
            new Uint8Array(glb, o, bin.byteLength).set(new Uint8Array(bin)); o += bin.byteLength;
            for (let k2 = 0; k2 < bPad; k2++) new Uint8Array(glb, o + k2, 1)[0] = 0;

            const ml2 = document.getElementsByClassName('model-name__label')[0];
            const modelName = (ml2 ? ml2.textContent.trim().replace(/\.+$/, '') : 'model').replace(/[\\\/:*?"<>|]/g, '_') || 'model';

            const zip = new JSZip();
            zip.file(`${modelName}.glb`, new Blob([glb], { type: 'application/octet-stream' }));
            for (let tn in zipTex) {
                if (zipTex.hasOwnProperty(tn) && objects[tn]) {
                    zip.file(`textures/${zipTex[tn]}`, objects[tn], { compression: 'STORE' });   // PNG/JPEG are already compressed
                }
            }
            zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }).then((content) => {
                saveAs(content, `${modelName}.zip`);
                log('export done:', `${modelName}.zip`);
                _exporting = false;
            }).catch((e) => {
                _exporting = false;
                err('zip failed:', e.message);
            });
        } catch (e) {
            _exporting = false;
            err('export failed:', e.message, e.stack);
        }
    }

    // ====================================================================
    // Script interceptor
    // ====================================================================
    (function installInterceptor() {
        const Ev = function (s, t) {
            this.script = s; this.target = t;
            this._cancel = false; this._replace = null; this._stop = false;
        };
        Ev.prototype.preventDefault = function () { this._cancel = true; };
        Ev.prototype.stopPropagation = function () { this._stop = true; };
        Ev.prototype.replacePayload = function (p) { this._replace = p; };

        function dispatch(script, target) {
            if (!script || script.tagName !== 'SCRIPT') return;
            const e = new Ev(script, target);
            if (typeof window.onbeforescriptexecute === 'function') {
                try { window.onbeforescriptexecute(e); } catch (err) { console.error(err); }
            }
            if (e._cancel) { script.textContent = ''; script.remove(); }
            else if (typeof e._replace === 'string') { script.textContent = e._replace; }
        }

        const obs = new MutationObserver((ms) => {
            for (let i = 0; i < ms.length; i++) {
                const m = ms[i];
                const an = m.addedNodes;
                for (let j = 0; j < an.length; j++) {
                    const n = an[j];
                    if (n && n.tagName === 'SCRIPT') dispatch(n, m.target);
                }
            }
        });
        obs.observe(window.document, { childList: true, subtree: true });
    })();

    const RE = {
        renderInto1      : /A\.renderInto\(n,E,R/g,
        renderInto2      : /g\.renderInto=function\(e,i,r/g,
        drawArrays       : /t\.drawArrays\(t\.TRIANGLES,0,6\)/g,
        getResourceImage : /getResourceImage:function\(e,t\){/g,
        drawGeometry     : /(this\._stateCache\.drawGeometry\(this\._graphicContext,t\))/g,
    };

    const patchedSrc = {};

    window.onbeforescriptexecute = (e) => {
        // Only handle the script that triggered the event, and each bundle URL once.
        // (Looping over all siblings re-executed the viewer bundle repeatedly and
        // exhausted WebGL contexts / RAM.)
        [e.script].forEach((node) => {
            if (!node || node.tagName !== 'SCRIPT') return;
            if (node.__ripperOwn) return;
            const src = node.src || '';
            if (src.indexOf('web/dist/') < 0 && src.indexOf('standaloneViewer') < 0) return;
            if (patchedSrc[src]) { warn('bundle already patched, dropping duplicate:', src.split('/').pop()); e.preventDefault(); e.stopPropagation(); return; }
            patchedSrc[src] = true;

            let js = '';
            try {
                const req = new XMLHttpRequest();
                req.open('GET', src, false);
                req.send('');
                if (req.status >= 200 && req.status < 300) js = req.responseText || '';
                else err('bundle fetch status', req.status, src.split('/').pop());
            } catch (fe) { err('bundle fetch failed:', fe.message, src.split('/').pop()); }
            if (!js) { delete patchedSrc[src]; return; }   // leave the original script running

            e.preventDefault();
            e.stopPropagation();

            let ret, applied = [];
            for (let rk in RE) if (RE.hasOwnProperty(rk)) RE[rk].lastIndex = 0;

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

            const s = document.createElement('script');
            s.__ripperOwn = true;
            s.type = 'text/javascript';
            s.text = js;
            (document.head || document.getElementsByTagName('head')[0]).appendChild(s);
        });
    };

    (function kickoff() {
        const isViewerFrame = (window.self !== window.top) || (location.pathname.indexOf('/embed') !== -1);
        if (!isViewerFrame) return;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => { setTimeout(addbtnfunc, 500); });
        } else {
            setTimeout(addbtnfunc, 500);
        }
    })();
})();
