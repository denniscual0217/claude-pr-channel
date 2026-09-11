import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loaded before any test module. Bun resolves a spawned binary from the PATH it holds
// when the process starts, so the shim has to be first on PATH here, not inside a test.
// The shim aborts with exit 99 unless FAKE_GH_STATE is set, so a suite that forgets to
// configure it fails loudly instead of reaching the real gh on this machine.
const fakeGhDir = join(dirname(fileURLToPath(import.meta.url)), 'fake-gh');
process.env['PATH'] = `${fakeGhDir}:${process.env['PATH'] ?? ''}`;
process.env['FAKE_GH_BUN'] = process.execPath;
delete process.env['FAKE_GH_STATE'];
delete process.env['FAKE_GH_LOG'];
