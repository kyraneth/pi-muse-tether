#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
process.umask(0o002);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const remote = process.env.CORE_GIT_REMOTE;
if (!remote || !/^(ssh:\/\/git@|git@)/.test(remote)) throw new Error('Set CORE_GIT_REMOTE to your authorized Git SSH repository URL');
const manifestPath = join(root, 'package.json');
const before = readFileSync(manifestPath);
if (JSON.parse(before).dependencies['pi-tether-core'] !== '0.1.0') throw new Error('Expected exact registry dependency pi-tether-core 0.1.0');
const parent = join(root, 'internal', 'build'); mkdirSync(parent, { recursive: true });
const work = mkdtempSync(join(parent, 'core-main-'));
const source = join(work, 'source');
// Retain source and packed bytes as development evidence; never delete prior runs.
execFileSync('git', ['clone', '--quiet', '--single-branch', '--branch', 'main', remote, source], { stdio: 'inherit' });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
const core = JSON.parse(readFileSync(join(source, 'package.json')));
if (core.name !== 'pi-tether-core' || core.version !== '0.1.0') throw new Error('Core main must pack pi-tether-core 0.1.0');
const pack = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: source, encoding: 'utf8' }))[0];
const tarball = join(work, pack.filename);
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
execFileSync('npm', ['install', '--ignore-scripts', '--no-save', '--package-lock=false', tarball], { cwd: root, stdio: 'inherit' });
if (!before.equals(readFileSync(manifestPath))) throw new Error('Development install changed package.json');
const receipt = { commit, sha256, package: core.name, version: core.version, tarball: pack.filename };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
