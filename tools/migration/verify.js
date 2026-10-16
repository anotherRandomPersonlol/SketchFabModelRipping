#!/usr/bin/env node
// Checks that a modern-syntax version of the script does the same thing as the ES5 version.
//   node verify.js <es5.js> <modern.js>
// 1. Structure: the modern AST, normalized back (let/const -> var, arrow -> function, template -> '+',
//    shorthand -> a: a), must equal the ES5 AST (positions, raw text and comments ignored).
// 2. Scope: every identifier must resolve to the same declaration in both files (real scoping, not normalized).
// 3. Hazards of block scoping, listed for review: use before declaration (TDZ), uninitialised let in a loop
//    body (no carry-over between iterations), closures in loops that capture a let, let in a switch case,
//    this/arguments inside arrows, writes to const, new on an arrow.
// Exit code 1 on a structural or scope difference, or on a hard hazard.
// Needs: npm i acorn eslint-scope
'use strict';
const fs = require('fs');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');

const [fileA, fileB] = process.argv.slice(2);
const ALLOW_DIFF_FUNCS = new Set(['log', 'warn', 'err']);   // rewritten by hand: (...args) instead of arguments

function parse(file) {
    const src = fs.readFileSync(file, 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', ranges: true, locations: true });
    (function link(node, parent) {
        node.parent = parent;
        for (const k of Object.keys(node)) {
            if (k === 'parent' || k === 'loc' || k === 'range') continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach((c) => { if (c && typeof c.type === 'string') link(c, node); });
            else if (v && typeof v.type === 'string') link(v, node);
        }
    })(ast, null);
    return { src, ast, sm: eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' }) };
}
const A = parse(fileA), B = parse(fileB);
const problems = [], hazards = [];
const where = (n) => 'line ' + n.loc.start.line;

// ==== 1. structural comparison ====
const SKIP = new Set(['start', 'end', 'loc', 'range', 'raw', 'parent']);
const isPlus = (n) => n && n.type === 'BinaryExpression' && n.operator === '+';
const isStr = (n) => n && n.type === 'Literal' && typeof n.value === 'string';
const strLit = (v) => ({ type: 'Literal', value: v });

function norm(n) {
    if (Array.isArray(n)) return n.map(norm);
    if (!n || typeof n !== 'object') return n;
    if ((n.type === 'FunctionDeclaration') && n.id && ALLOW_DIFF_FUNCS.has(n.id.name)) return { type: 'AllowedDiff', name: n.id.name };
    let o;
    switch (n.type) {
        case 'VariableDeclaration':
            o = { type: n.type, kind: 'var', declarations: norm(n.declarations) }; break;
        case 'ArrowFunctionExpression':
            o = { type: 'FunctionExpression', id: null, params: norm(n.params), generator: false, async: false, expression: false,
                  body: n.expression ? { type: 'BlockStatement', body: [{ type: 'ReturnStatement', argument: norm(n.body) }] } : norm(n.body) };
            break;
        case 'TemplateLiteral': {
            if (n.parent && n.parent.type === 'TaggedTemplateExpression') { o = plain(n); break; }
            const parts = [];
            n.quasis.forEach((q, i) => {
                if (q.value.cooked !== '') parts.push(strLit(q.value.cooked));
                if (i < n.expressions.length) parts.push(norm(n.expressions[i]));
            });
            if (parts.length === 0) { o = strLit(''); break; }
            if (!isStr(parts[0]) && (parts.length === 1 || !isStr(parts[1]))) parts.unshift(strLit(''));
            o = parts.reduce((l, r) => ({ type: 'BinaryExpression', operator: '+', left: l, right: r }));
            break;
        }
        case 'Property':
            o = plain(n); o.shorthand = false; o.method = false; break;
        default:
            o = plain(n);
    }
    return fold(o);
}
function plain(n) {
    const o = {};
    for (const k of Object.keys(n)) if (!SKIP.has(k)) o[k] = norm(n[k]);
    if (n.type === 'Literal' && n.regex) o.value = '/' + n.regex.pattern + '/' + n.regex.flags;
    if (n.type === 'ExpressionStatement') delete o.directive;
    return o;
}
// 'a' + 'b' -> 'ab' and (x + 'a') + 'b' -> x + 'ab' (both sides, so constant joins do not count as a difference)
function fold(o) {
    if (isPlus(o) && isStr(o.right)) {
        if (isStr(o.left)) return strLit(o.left.value + o.right.value);
        if (isPlus(o.left) && isStr(o.left.right)) return fold({ type: 'BinaryExpression', operator: '+', left: o.left.left, right: strLit(o.left.right.value + o.right.value) });
    }
    return o;
}
function firstDiff(a, b, path) {
    if (a === b) return null;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return { path, a, b };
    if (Array.isArray(a) !== Array.isArray(b)) return { path, a: 'array?', b: 'array?' };
    if (Array.isArray(a)) {
        if (a.length !== b.length) return { path: path + '.length', a: a.length, b: b.length };
        for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], path + '[' + i + ']'); if (d) return d; }
        return null;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) { const d = firstDiff(a[k], b[k], path + '.' + k); if (d) return d; }
    return null;
}
// compare statement by statement, so one difference does not hide the next ones
(function compareBodies(na, nb, label) {
    const ba = na.body, bb = nb.body;
    if (ba.length !== bb.length) { problems.push(label + ': statement count ' + ba.length + ' vs ' + bb.length); return; }
    for (let i = 0; i < ba.length; i++) {
        const d = firstDiff(norm(ba[i]), norm(bb[i]), '');
        if (!d) continue;
        // descend into the IIFE / function bodies for a precise location
        const ea = ba[i], eb = bb[i];
        const inner = (s) => {
            if (s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression') {
                const c = s.expression.callee;
                if ((c.type === 'FunctionExpression' || c.type === 'ArrowFunctionExpression') && c.body.type === 'BlockStatement') return c.body;
            }
            if (s.type === 'FunctionDeclaration') return s.body;
            return null;
        };
        const ia = inner(ea), ib = inner(eb);
        if (ia && ib) compareBodies(ia, ib, where(eb));
        else problems.push('structure differs at ' + where(eb) + ' (ES5 ' + where(ea) + '): ' + d.path + ' ' + JSON.stringify(d.a).slice(0, 80) + ' vs ' + JSON.stringify(d.b).slice(0, 80));
    }
})(A.ast, B.ast, 'program');

// ==== 2. scope resolution ====
function resolution(P) {
    const declIds = [];
    P.sm.scopes.forEach((s) => s.variables.forEach((v) => { if (v.defs.length) declIds.push(v.defs[0].name.start); }));
    declIds.sort((x, y) => x - y);
    const ord = new Map(declIds.map((p, i) => [p, i]));
    const refs = [];
    P.sm.scopes.forEach((s) => s.references.forEach((r) => {
        const v = r.resolved;
        refs.push({ pos: r.identifier.start, node: r.identifier, name: r.identifier.name,
                    to: v && v.defs.length ? 'decl#' + ord.get(v.defs[0].name.start) : 'global' });
    }));
    return refs.sort((x, y) => x.pos - y.pos);
}
function insideAllowed(node) {
    for (let p = node; p; p = p.parent) if (p.type === 'FunctionDeclaration' && p.id && ALLOW_DIFF_FUNCS.has(p.id.name)) return true;
    return false;
}
const ra = resolution(A).filter((r) => !insideAllowed(r.node)), rb = resolution(B).filter((r) => !insideAllowed(r.node));
if (ra.length !== rb.length) problems.push('reference count ' + ra.length + ' vs ' + rb.length);
for (let i = 0, bad = 0; i < Math.min(ra.length, rb.length) && bad < 20; i++) {
    if (ra[i].name !== rb[i].name || ra[i].to !== rb[i].to) {
        problems.push('scope: "' + rb[i].name + '" at ' + where(rb[i].node) + ' resolves to ' + rb[i].to + ', in ES5 "' + ra[i].name + '" ' + ra[i].to);
        bad++;
    }
}

// ==== 3. block-scoping hazards (modern file) ====
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const isFnNode = (n) => n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration' || n.type === 'ArrowFunctionExpression';
function enclosingLoop(node, stopAt) {   // nearest loop between node and stopAt (exclusive), not crossing functions
    for (let p = node.parent; p && p !== stopAt; p = p.parent) {
        if (LOOPS.has(p.type)) return p;
        if (isFnNode(p)) return null;
    }
    return null;
}
const arrowNodes = new Set();
(function collect(n) {
    if (n.type === 'ArrowFunctionExpression') arrowNodes.add(n);
    for (const k of Object.keys(n)) {
        if (k === 'parent' || k === 'loc' || k === 'range') continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach((c) => { if (c && typeof c.type === 'string') collect(c); });
        else if (v && typeof v.type === 'string') collect(v);
    }
})(B.ast);

B.sm.scopes.forEach((s) => s.variables.forEach((v) => {
    const def = v.defs[0];
    if (!def || def.type !== 'Variable' || def.parent.kind === 'var') return;
    const decl = def.parent, id = def.name;
    // TDZ: a reference before the declaration
    v.references.forEach((r) => {
        if (r.identifier.start < id.start) hazards.push({ hard: false, msg: 'TDZ: "' + v.name + '" used at ' + where(r.identifier) + ' before its ' + decl.kind + ' at ' + where(id) });
    });
    // const written again
    if (decl.kind === 'const') v.references.forEach((r) => {
        if (r.isWrite() && r.identifier !== id) hazards.push({ hard: true, msg: 'write to const "' + v.name + '" at ' + where(r.identifier) });
    });
    // switch case
    if (decl.parent.type === 'SwitchCase') hazards.push({ hard: false, msg: 'let/const in a switch case: "' + v.name + '" at ' + where(id) });
    // loop body: no initializer -> the value no longer carries over to the next iteration
    const loop = enclosingLoop(decl, null);
    const inHead = loop && (loop.init === decl || loop.left === decl);
    if (loop && !inHead && !def.node.init) {
        hazards.push({ hard: false, msg: 'let without initializer in a loop body: "' + v.name + '" at ' + where(id) });
    }
    // closure in the loop that captures it: per-iteration binding instead of one shared variable
    if (loop) v.references.forEach((r) => {
        let fnP = null;
        for (let p = r.identifier.parent; p && p !== loop; p = p.parent) if (isFnNode(p)) { fnP = p; break; }
        if (fnP) hazards.push({ hard: false, msg: 'closure in a loop captures "' + v.name + '" (' + decl.kind + ' at ' + where(id) + ') at ' + where(r.identifier) });
    });
}));
// this / arguments in an arrow (would no longer be the function's own)
arrowNodes.forEach((fn) => {
    (function scan(n) {
        if (n !== fn && (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration')) return;
        if (n.type === 'ThisExpression' || (n.type === 'Identifier' && n.name === 'arguments' && !(n.parent && n.parent.type === 'MemberExpression' && n.parent.property === n && !n.parent.computed)))
            hazards.push({ hard: true, msg: (n.type === 'ThisExpression' ? 'this' : 'arguments') + ' inside an arrow at ' + where(n) });
        for (const k of Object.keys(n)) {
            if (k === 'parent' || k === 'loc' || k === 'range') continue;
            const v = n[k];
            if (Array.isArray(v)) v.forEach((c) => { if (c && typeof c.type === 'string') scan(c); });
            else if (v && typeof v.type === 'string') scan(v);
        }
    })(fn);
});
// new on a name that holds an arrow
B.sm.scopes.forEach((s) => s.references.forEach((r) => {
    const p = r.identifier.parent;
    if (!(p.type === 'NewExpression' && p.callee === r.identifier) || !r.resolved) return;
    const d = r.resolved.defs[0];
    if (d && d.type === 'Variable' && d.node.init && d.node.init.type === 'ArrowFunctionExpression')
        hazards.push({ hard: true, msg: 'new on arrow "' + r.identifier.name + '" at ' + where(r.identifier) });
}));

// ==== report ====
const hard = hazards.filter((h) => h.hard), soft = hazards.filter((h) => !h.hard);
console.log('structure + scope differences: ' + problems.length);
problems.slice(0, 40).forEach((p) => console.log('  ' + p));
console.log('hard hazards: ' + hard.length);
hard.forEach((h) => console.log('  ' + h.msg));
console.log('hazards to review: ' + soft.length);
soft.forEach((h) => console.log('  ' + h.msg));
console.log('references compared: ' + rb.length);
process.exit(problems.length || hard.length ? 1 : 0);
