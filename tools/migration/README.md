# Migration tools (ES5 to modern syntax)

Two one-time tools for version 1.3.0. They are not part of the userscript.

- `modernize.js` changes the syntax and keeps every other character: `var` to `let`/`const`, function expressions to arrow functions, single-line string concatenation to template literals, `{ a: a }` to `{ a }`.
- `verify.js` compares the ES5 file and the modern file. See below.

## Use

```
cd tools/migration
npm install
git show 15c7c0e:src/Sketchfab-ripper.user.js > es5.user.js
node verify.js es5.user.js ../../src/Sketchfab-ripper.user.js
```

Commit `15c7c0e` is the last ES5 version (v1.2.1 with the `_exporting` declaration moved up).

## What verify.js checks

1. **Structure.** The modern syntax tree, converted back (`let`/`const` to `var`, arrow to function, template literal to `+`, shorthand to `a: a`), must be equal to the ES5 syntax tree. Positions, raw text and comments are not compared. `log`, `warn` and `err` were changed by hand (`...args` instead of `arguments`) and are left out.
2. **Scope.** Every name must point to the same declaration in both files. This test uses the real block scoping of the modern file, not the converted-back tree.
3. **Block-scoping hazards.** The tool lists these for review:
   - use before the declaration (TDZ), also through a function that a statement calls before the declaration runs
   - `let` without a value in a loop body (the value no longer carries over to the next pass)
   - a closure in a loop that captures a `let` (one binding per pass instead of one shared variable)
   - `let` in a `switch` case
   - `this` or `arguments` in an arrow function, a write to a `const`, `new` on an arrow function (these three stop the check)

## Result for 1.3.0

- Structure and scope: no differences in 7541 compared references.
- Hard hazards: none.
- 23 hazards, all reviewed and safe:
  - `j` (overlay test) is set in its `for` header before any read, and `rough` (metal/rough merge) is set in all three branches.
  - The 21 closures in the hold-key block are in a function that runs at once, in the same loop pass.
- The keyframe reduction, node removal and overlay tests gave the same output with the ES5 file and the modern file.

The checks were tested with deliberate errors: a wrong template (`${a}${b}` for `a + b`), a lost parenthesis, a variable that leaks from a block, a value carried over a loop pass, `this` in an arrow, use before the declaration, a call before the declaration, a write to a `const`, and a closure in a loop. The tool found all of them.
