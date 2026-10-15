'use strict';

// 一次性 AST 改写工具：把 better-sqlite3 的 prepare().get/all/run() 改为 mysql 异步接口。
const fs = require('fs');
const path = require('path');
const j = require('jscodeshift').withParser('babel');

const root = path.join(__dirname, '..', 'src');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js') && entry.name !== 'db.js') files.push(full);
  }
}
walk(root);

function markAsync(callPath) {
  let p = callPath;
  while (p) {
    if (j.FunctionExpression.check(p.node) || j.ArrowFunctionExpression.check(p.node) || j.FunctionDeclaration.check(p.node)) {
      p.node.async = true;
      return true;
    }
    p = p.parent;
  }
  return false;
}

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = j(source);
  let changed = false;
  ast.find(j.CallExpression).forEach((p) => {
    const call = p.node;
    if (!j.MemberExpression.check(call.callee) || !['get', 'all', 'run'].includes(call.callee.property.name)) return;
    const prepare = call.callee.object;
    if (!j.CallExpression.check(prepare) || !j.MemberExpression.check(prepare.callee)
      || prepare.callee.property.name !== 'prepare' || prepare.callee.object.name !== 'db') return;
    if (!markAsync(p)) throw new Error(`无法定位异步函数: ${file}`);
    const target = call.callee.property.name === 'get' ? 'one' : call.callee.property.name === 'all' ? 'many' : 'execute';
    const replacement = j.awaitExpression(j.callExpression(
      j.memberExpression(j.identifier('db'), j.identifier(target)),
      [prepare.arguments[0], j.arrayExpression(call.arguments)],
    ));
    j(p).replaceWith(replacement);
    changed = true;
  });
  if (changed) fs.writeFileSync(file, ast.toSource({ quote: 'single' }));
}
