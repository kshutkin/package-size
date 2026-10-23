import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('./index.js', import.meta.url));

async function createFixture(t, packageJson, files) {
    const root = await mkdtemp(join(tmpdir(), 'pkgsz-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = join(root, 'fixture');
    for (const [file, content] of Object.entries({
        ...files,
        'package.json': JSON.stringify({ version: '1.2.3', ...packageJson }),
    })) {
        const path = join(fixture, file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
    }
    const { stdout } = await execFileAsync('npm', [
        'pack', '--ignore-scripts', '--json', '--pack-destination', root,
    ], { cwd: fixture });
    const tarball = join(root, JSON.parse(stdout)[0].filename);
    return {
        root,
        tarball,
        async run(args = [], env = {}) {
            return execFileAsync(process.execPath, [
                cli, packageJson.name, `file:${tarball}`, ...args,
            ], { env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, ...env } });
        },
        async buildDir() {
            const dirs = (await readdir(root, { withFileTypes: true }))
                .filter(entry => entry.isDirectory() && entry.name.startsWith('pkgsz-'))
                .map(entry => entry.name);
            assert.equal(dirs.length, 1);
            return join(root, dirs[0]);
        },
    };
}

for (const type of ['module', 'commonjs']) {
    test(`subpath-only ${type} build excludes the default-export probe`, async t => {
        const fixture = await createFixture(t, {
            name: `@pkgsz-test/subpath-${type}`,
            type,
            exports: { '.': './index.js', './only': './only.js' },
        }, {
            'index.js': type === 'module' ? 'export const root = 1;' : 'exports.root = 1;',
            'only.js': 'console.log("subpath side effect");\n' + (type === 'module'
                ? 'export const foo = 123; export default 456;'
                : 'exports.foo = 123;'),
        });
        const { stdout, stderr } = await fixture.run(['-jbc', '-e', './only']);
        assert.equal(stderr, '');
        const result = JSON.parse(stdout);
        const dir = await fixture.buildDir();
        assert.deepEqual(await readdir(join(dir, 'src')), ['index.js']);
        assert.deepEqual(await readdir(join(dir, 'dist')), ['index.mjs']);
        const content = await readFile(join(dir, 'dist', 'index.mjs'));
        assert.match(content.toString(), /subpath side effect/);
        assert.deepEqual(result.includedExports, [{ export: 'only', defaultExport: true }]);
        const sizes = Object.fromEntries(result.results.map(({ id, value }) => [id, value]));
        assert.equal(sizes.sizeMinified, content.length);
        assert.equal(sizes.sizeMinifiedGzipped, gzipSync(content, {
            level: constants.Z_BEST_COMPRESSION,
        }).length);
        assert.equal(sizes.sizeMinifiedBrotli, brotliCompressSync(content, {
            params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
        }).length);
    });
}

for (const [name, exports, files, args] of [
    ['missing-legacy-subpath', undefined, { 'index.js': 'export const foo = 123;' }, ['-e', './missing']],
    ['missing-declared-subpath', { '.': './index.js' }, { 'index.js': 'export const foo = 123;' }, ['-e', './missing']],
    ['unresolved-transitive-import', undefined, { 'index.js': 'export { foo } from "@pkgsz-test/missing";' }, []],
    ['missing-package-entry', undefined, {}, []],
]) {
    test(`rejects ${name} instead of reporting an external stub size`, async t => {
        const fixture = await createFixture(t, {
            name: `@pkgsz-test/${name}`,
            type: 'module',
            main: './index.js',
            exports,
        }, files);
        await assert.rejects(fixture.run(['-jg', ...args]), error => {
            assert.equal(error.code, 1);
            assert.equal(error.stdout, '');
            assert.match(error.stderr, /could not be resolved/);
            return true;
        });
    });
}

for (const [name, args, retained] of [
    ['JSON', ['-jg'], false],
    ['text', ['-g'], false],
    ['JSON with cleanup disabled', ['-jgc'], true],
]) {
    test(`installation failure in ${name} mode reports the cause and respects cleanup`, async t => {
        const fixture = await createFixture(t, {
            name: '@pkgsz-test/install-failure', type: 'module', main: './index.js',
        }, { 'index.js': 'export const foo = 123;' });
        await rm(fixture.tarball);
        await assert.rejects(fixture.run(args), error => {
            assert.equal(error.code, 1);
            assert.match(error.stdout + error.stderr, /ENOENT/);
            assert.doesNotMatch(error.stdout + error.stderr, /ReferenceError/);
            if (args.includes('-jg') || args.includes('-jgc')) assert.equal(error.stdout, '');
            return true;
        });
        const dirs = (await readdir(fixture.root, { withFileTypes: true }))
            .filter(entry => entry.isDirectory() && entry.name.startsWith('pkgsz-'));
        assert.equal(dirs.length, retained ? 1 : 0);
    });
}

test('directory creation failure in JSON mode does not access uninitialized results', async t => {
    const fixture = await createFixture(t, {
        name: '@pkgsz-test/directory-failure', type: 'module', main: './index.js',
    }, { 'index.js': 'export const foo = 123;' });
    await assert.rejects(fixture.run(['-jg'], { TMPDIR: join(fixture.root, 'missing') }), error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /Creating temporary directories \(failed\)/);
        assert.match(error.stderr, /ENOENT/);
        assert.doesNotMatch(error.stderr, /ReferenceError/);
        return true;
    });
});
