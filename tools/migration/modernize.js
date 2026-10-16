#!/usr/bin/env node
// One-time converter: ES5 userscript -> modern syntax, keeping the formatting.
//   node modernize.js <in.js> <out.js> [--let] [--arrow] [--template] [--shorthand]
// Only keywords, function headers and string concatenations are rewritten; every other character stays.
// Needs: npm i acorn eslint-scope
'use strict';
const fs = require('fs');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const [inFile, outFile, ...flags] = process.argv.slice(2);
const want = (f) => flags.length === 0 || flags.includes('--' + f);
const src = fs.readFileSync(inFile, 'utf8');
const comments = [];
const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', ranges: true, locations: true, onComment: comments });
const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });

// ---- parent links ----
(function link(node, parent) {
    node.parent = parent;
    for (const k of Object.keys(node)) {
        if (k === 'parent' || k === 'loc' || k === 'range') continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach((c) => { if (c && typeof c.type === 'string') link(c, node); });
        else if (v && typeof v.type === 'string') link(v, node);
    }
})(ast, null);

function walk(node, fn) {
    fn(node);
    for (const k of Object.keys(node)) {
        if (k === 'parent' || k === 'loc' || k === 'range') continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach((c) => { if (c && typeof c.type === 'string') walk(c, fn); });
        else if (v && typeof v.type === 'string') walk(v, fn);
    }
}
const hasComment = (s, e) => comments.some((c) => c.start >= s && c.end <= e);
const isFn = (n) => n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration' || n.type === 'ArrowFunctionExpression';

// ---- edits: {start, end, render()} ; nested edits are rendered by their parent edit ----
const edits = [];
function applyEdits(s, e) {
    const inside = edits.filter((x) => x.start >= s && x.end <= e && !(x.start === s && x.end === e && x.self))
        .sort((a, b) => a.start - b.start || b.end - a.end);
    let out = '', pos = s;
    for (const x of inside) {
        if (x.start < pos) {
            if (x.end <= pos) continue;   // contained in an edit already taken
            throw new Error('overlapping edits at ' + x.start);
        }
        out += src.slice(pos, x.start) + x.render();
        pos = x.end;
    }
    return out + src.slice(pos, e);
}
const stats = { const: 0, let: 0, arrow: 0, concise: 0, arrowSkipped: 0, template: 0, templateSkipped: 0, shorthand: 0 };

// ==== var -> let / const ====
if (want('let')) {
    walk(ast, (n) => {
        if (n.type !== 'VariableDeclaration' || n.kind !== 'var') return;
        const p = n.parent;
        let kind = 'const';
        if ((p.type === 'ForStatement' && p.init === n) || ((p.type === 'ForInStatement' || p.type === 'ForOfStatement') && p.left === n)) kind = 'let';
        else {
            for (const d of n.declarations) {
                const v = sm.getDeclaredVariables(d)[0];
                const ok = d.init && v && v.defs.length === 1 && v.references.every((r) => !r.isWrite() || r.identifier === d.id);
                if (!ok) { kind = 'let'; break; }
            }
        }
        stats[kind]++;
        edits.push({ start: n.start, end: n.start + 3, render: () => kind });
    });
}

// ==== function expressions -> arrow functions ====
function usesThisOrArguments(fn) {
    let found = false;
    (function scan(node) {
        if (found) return;
        if (node !== fn && (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration')) return;
        if (node.type === 'ThisExpression' || node.type === 'Super' || node.type === 'MetaProperty' ||
            (node.type === 'Identifier' && node.name === 'arguments')) { found = true; return; }
        for (const k of Object.keys(node)) {
            if (k === 'parent' || k === 'loc' || k === 'range') continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach((c) => { if (c && typeof c.type === 'string') scan(c); });
            else if (v && typeof v.type === 'string') scan(v);
        }
    })(fn);
    return found;
}
function parenthesized(n) {
    let i = n.start - 1; while (i >= 0 && /\s/.test(src[i])) i--;
    let j = n.end; while (j < src.length && /\s/.test(src[j])) j++;
    return src[i] === '(' && src[j] === ')';
}
if (want('arrow')) {
    walk(ast, (n) => {
        if (n.type !== 'FunctionExpression') return;
        const p = n.parent;
        const okParent =
            ((p.type === 'CallExpression' || p.type === 'NewExpression') && p.arguments.includes(n)) ||
            (p.type === 'CallExpression' && p.callee === n && parenthesized(n)) ||
            (p.type === 'VariableDeclarator' && p.init === n) ||
            (p.type === 'AssignmentExpression' && p.right === n && !(p.left.type === 'MemberExpression' && /prototype/.test(src.slice(p.left.start, p.left.end)))) ||
            (p.type === 'Property' && p.value === n && p.kind === 'init' && !p.method) ||
            (p.type === 'ReturnStatement') || (p.type === 'ArrayExpression') ||
            (p.type === 'ConditionalExpression' && p.test !== n);
        const header = src.slice(n.start, n.body.start);
        if (n.id || n.generator || n.async || !okParent || usesThisOrArguments(n) || !/^function\s*\([^)]*\)\s*$/.test(header)) {
            stats.arrowSkipped++;
            return;
        }
        const params = n.params.length ? src.slice(n.params[0].start, n.params[n.params.length - 1].end) : '';
        edits.push({ start: n.start, end: n.body.start, render: () => '(' + params + ') => ' });
        stats.arrow++;
        const b = n.body;
        if (b.body.length === 1 && b.body[0].type === 'ReturnStatement' && b.body[0].argument &&
            b.loc.start.line === b.loc.end.line && !hasComment(b.start, b.end)) {
            const a = b.body[0].argument;
            const wrap = a.type === 'ObjectExpression' || a.type === 'SequenceExpression';
            edits.push({ start: b.start, end: a.start, render: () => (wrap ? '(' : '') });
            edits.push({ start: a.end, end: b.end, render: () => (wrap ? ')' : '') });
            stats.concise++;
        }
    });
}

// ==== string concatenation -> template literals (single-line chains only) ====
const isPlus = (n) => n && n.type === 'BinaryExpression' && n.operator === '+';
const isStr = (n) => n.type === 'Literal' && typeof n.value === 'string';
function tplRaw(lit) {
    const raw = src.slice(lit.start + 1, lit.end - 1);
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '\\') { out += c + raw[i + 1]; i++; }
        else if (c === '`') out += '\\`';
        else if (c === '$' && raw[i + 1] === '{') out += '\\$';
        else out += c;
    }
    return out;
}
if (want('template')) {
    walk(ast, (n) => {
        if (!isPlus(n) || (isPlus(n.parent) && n.parent.left === n)) return;   // maximal chains only
        const ops = [], bins = [];
        let m = n;
        while (isPlus(m)) { ops.unshift(m.right); bins.unshift(m); m = m.left; }
        ops.unshift(m); bins.unshift(null);                                    // bins[k] covers ops[0..k]
        const i = ops.findIndex(isStr);
        if (i < 0) return;
        const skip = n.loc.start.line !== n.loc.end.line || hasComment(n.start, n.end) ||
            ops.slice(1).some((o) => isPlus(o)) || !ops.some((o) => o.type !== 'Literal');
        if (skip) { stats.templateSkipped++; return; }
        edits.push({ start: n.start, end: n.end, self: true, render: () => {
            let t = '`';
            if (i > 0) { const pre = i === 1 ? ops[0] : bins[i - 1]; t += '${' + applyEdits(pre.start, pre.end) + '}'; }
            for (let k = i; k < ops.length; k++) t += isStr(ops[k]) ? tplRaw(ops[k]) : '${' + applyEdits(ops[k].start, ops[k].end) + '}';
            return t + '`';
        } });
        stats.template++;
    });
}

// ==== { a: a } -> { a } ====
if (want('shorthand')) {
    walk(ast, (n) => {
        if (n.type === 'Property' && n.kind === 'init' && !n.computed && n.key.type === 'Identifier' &&
            n.value.type === 'Identifier' && n.key.name === n.value.name && !hasComment(n.start, n.end)) {
            edits.push({ start: n.start, end: n.end, render: () => n.key.name });
            stats.shorthand++;
        }
    });
}

fs.writeFileSync(outFile, applyEdits(0, src.length));
console.log(JSON.stringify(stats));
