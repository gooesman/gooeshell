import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';

// All fixture files live inside this checkout. Never use a real SSH identity or server.
const output = path.resolve('test-output');
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(path.join(output, 'ci-'));
const ready = path.join(directory, 'sftp.ready');
const server = spawn(process.env.GOOESHELL_TEST_PYTHON || 'python', [
  '../gooeshell-files/tests-support/sftp_fixture.py',
  '--root', path.join(directory, 'sftp'), '--ready', ready, '--lifetime', '600',
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(createWriteStream(path.join(directory, 'fixture.log')));
server.stderr.pipe(createWriteStream(path.join(directory, 'fixture-error.log')));
let serverError;
server.once('error', error => { serverError = error; });
const stopped = new Promise(resolve => server.once('close', resolve));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
try {
  const deadline = Date.now() + 20_000;
  while (true) {
    if (serverError) throw serverError;
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('SSH fixture stopped before becoming ready');
    if (await fs.stat(ready).then(() => true, () => false)) break;
    if (Date.now() >= deadline) throw new Error('SSH fixture did not become ready within 20 seconds');
    await pause(100);
  }
  const tests = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], {
    env: { ...process.env, GOOESHELL_SFTP_TEST_READY: ready },
    windowsHide: true, shell: process.platform === 'win32', stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => {
    tests.once('error', reject);
    tests.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (code !== 0) throw new Error(`Application tests failed with exit code ${code}`);
} finally {
  await fs.writeFile(`${ready}.stop`, '');
  await Promise.race([stopped, pause(3000)]);
  if (server.exitCode === null && server.signalCode === null) server.kill();
  if (serverError) console.error(serverError.message);
}
