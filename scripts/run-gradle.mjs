import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const androidDir = path.join(rootDir, 'android');
const gradleExecutable = process.platform === 'win32'
  ? path.join(androidDir, 'gradlew.bat')
  : path.join(androidDir, 'gradlew');

const gradleTasks = process.argv.slice(2);
if (!gradleTasks.length) {
  console.error('Usage: node ./scripts/run-gradle.mjs <gradleTask>');
  process.exit(1);
}

const child = spawn(gradleExecutable, gradleTasks, {
  cwd: androidDir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('exit', code => {
  process.exit(code ?? 1);
});

child.on('error', error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});