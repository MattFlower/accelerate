import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: node gen-dropped-schema.mjs [--check]');
}

const schema = JSON.parse(readFileSync(new URL('./findings.schema.json', import.meta.url), 'utf8'));
const properties = {
  file: { type: 'string' },
  line: { type: 'integer' },
  title: { type: 'string' },
  why_dropped: { type: 'string' },
  evidence: { type: 'string' },
};

schema.required.push('dropped');
schema.properties.dropped = {
  type: 'array',
  items: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
};

const output = Buffer.from(JSON.stringify(schema, null, 2) + '\n');
const path = new URL('./findings-dropped.schema.json', import.meta.url);
if (args[0] === '--check') {
  if (readFileSync(path).equals(output)) {
    console.log('findings-dropped.schema.json matches byte for byte');
  } else {
    console.error('findings-dropped.schema.json differs from the generated schema');
    process.exitCode = 1;
  }
} else {
  writeFileSync(path, output);
}
