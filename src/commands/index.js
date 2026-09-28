// Collects every command and button/modal handler from the modules in this folder.
const modules = [
  require('./music'),
  require('./voice'),
  require('./verify'),
  require('./moderation'),
  require('./roles'),
  require('./tickets'),
  require('./setup'),
  require('./help'),
  require('./diagnostics'),
];

const commands = new Map();       // name -> { data, execute }
const components = new Map();     // exact customId -> handler
const prefixComponents = [];      // [prefix, handler] for ids like role:<id>

for (const m of modules) {
  for (const c of m.commands || []) {
    if (commands.has(c.data.name)) throw new Error(`Duplicate command /${c.data.name}`);
    commands.set(c.data.name, c);
  }
  for (const [id, fn] of Object.entries(m.components || {})) components.set(id, fn);
  for (const [prefix, fn] of Object.entries(m.prefixComponents || {})) prefixComponents.push([prefix, fn]);
}

function findComponent(customId) {
  if (components.has(customId)) return (i) => components.get(customId)(i);
  for (const [prefix, fn] of prefixComponents) {
    if (customId.startsWith(prefix)) return (i) => fn(i, customId.slice(prefix.length));
  }
  return null;
}

module.exports = { commands, findComponent };
