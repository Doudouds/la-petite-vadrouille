import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const checks = [
  {
    label: 'Node.js',
    command: 'node',
    args: ['--version']
  },
  {
    label: 'npm',
    command: 'npm',
    args: ['--version']
  },
  {
    label: 'Java',
    command: 'java',
    args: ['--version']
  },
  {
    label: 'Android Debug Bridge',
    command: 'adb',
    args: ['version']
  }
];

function runCommand(check) {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', [check.command, ...check.args].join(' ')], { encoding: 'utf8' })
    : spawnSync(check.command, check.args, { encoding: 'utf8' });
  if (result.error) {
    return `${check.label}: missing`;
  }
  const line = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] || 'available';
  return `${check.label}: ${line}`;
}

function fileStatus(label, relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  return `${label}: ${existsSync(absolutePath) ? 'present' : 'missing'} (${relativePath})`;
}

const report = [
  ...checks.map(runCommand),
  `ANDROID_HOME: ${process.env.ANDROID_HOME || 'unset'}`,
  `ANDROID_SDK_ROOT: ${process.env.ANDROID_SDK_ROOT || 'unset'}`,
  fileStatus('Mobile web staging', 'mobile-web'),
  fileStatus('Android project', 'android'),
  fileStatus('Privacy policy page', 'privacy.html'),
  fileStatus('Play Store docs', 'play-store/README.md'),
  fileStatus('Release keystore props', 'android/keystore.properties')
];

console.log(report.join('\n'));