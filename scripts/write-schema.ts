import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configJsonSchema } from '../src/config-schema.js';

// The committed artifact a configuration UI reads without running Bun. A test asserts the
// file matches this output byte for byte, so forgetting `bun run schema` fails the suite.
const path = join(import.meta.dir, '..', 'schema', 'config.schema.json');
writeFileSync(path, `${JSON.stringify(configJsonSchema(), null, 2)}\n`, 'utf8');
process.stderr.write(`wrote ${path}\n`);
