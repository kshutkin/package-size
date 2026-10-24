import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

async function promptEnvironment(fixture, answers) {
    const preload = join(fixture.root, 'prompt-answers.mjs');
    await writeFile(preload,
        `import prompt from ${JSON.stringify(import.meta.resolve('prompts'))}; prompt.inject(${JSON.stringify(answers)});`);
    return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` };
}

test('registry values cannot execute shell commands', async t => {
    const fixture = await createFixture(t, {
        name: '@pkgsz-test/registry-argument', type: 'module', main: './index.js',
    }, { 'index.js': 'export const foo = 123;' });
    const marker = join(fixture.root, 'shell-command-ran');
    try {
        await fixture.run(['-jg', '--registry', `https://registry.npmjs.org; touch "${marker}"`]);
    } catch (error) {
        assert.equal(error.code, 1);
    }
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

for (const noClean of [false, true]) {
    test(`large JSON reports are complete when piped (noClean=${noClean})`, async t => {
        const exports = {
            '.': './index.js',
            ...Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [
                `./subpath-${index}`, './index.js',
            ])),
        };
        const fixture = await createFixture(t, {
            name: '@pkgsz-test/large-json', type: 'module', exports,
        }, { 'index.js': 'export const foo = 123;' });
        const { stdout, stderr } = await fixture.run(noClean ? ['-jgc'] : ['-jg']);
        assert.equal(stderr, '');
        assert.ok(stdout.length > 65536);
        const result = JSON.parse(stdout);
        assert.deepEqual(result.exports, Object.keys(exports));
        assert.ok(result.results.some(({ id, value }) => id === 'sizeMinified' && value > 0));
    });
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

test('reads metadata for a scoped package without a root export', async t => {
    const fixture = await createFixture(t, {
        name: '@pkgsz-test/subpath-only',
        type: 'module',
        exports: { './only': './only.js' },
    }, { 'only.js': 'export const foo = 123;' });
    const { stdout, stderr } = await fixture.run(['-jg', '-e', './only']);
    const result = JSON.parse(stdout);
    assert.equal(stderr, '');
    assert.deepEqual(result.metadata, { name: '@pkgsz-test/subpath-only', version: '1.2.3' });
    assert.deepEqual(result.exports, ['./only']);
    assert.deepEqual(result.includedExports, [{ export: 'only', defaultExport: false }]);
    assert.ok(result.results.some(({ id, value }) => id === 'sizeMinified' && value > 0));
});

test('interactive mode selects the sole subpath when the root is not exported', async t => {
    const fixture = await createFixture(t, {
        name: '@pkgsz-test/interactive-subpath-only',
        type: 'module',
        exports: { './only': './only.js' },
    }, { 'only.js': 'export const foo = 123;' });
    const { stdout, stderr } = await fixture.run(['-icg'], await promptEnvironment(fixture, [[]]));
    assert.equal(stderr, '');
    assert.match(stdout, /Exports: only/);
    assert.match(stdout, /@pkgsz-test\/interactive-subpath-only@1\.2\.3/);
    const dir = await fixture.buildDir();
    assert.deepEqual(await readdir(join(dir, 'dist')), ['index.mjs']);
    assert.match(await readFile(join(dir, 'dist', 'index.mjs'), 'utf8'), /foo/);
});

test('interactive export probes keep excluded native dependencies external', async t => {
    const native = await createFixture(t, {
        name: '@pkgsz-test/native-dependency', main: './index.cjs',
    }, {
        'index.cjs': 'module.exports = require("./binding.node");',
        'binding.node': Buffer.from([0, 1, 2, 3, 255]),
    });
    const fixture = await createFixture(t, {
        name: '@pkgsz-test/excluded-native',
        type: 'module',
        main: './index.js',
        dependencies: { '@pkgsz-test/native-dependency': `file:${native.tarball}` },
    }, {
        'index.js': 'export { default } from "@pkgsz-test/native-dependency";',
    });
    const { stdout, stderr } = await fixture.run(['-icg'], await promptEnvironment(fixture, [[]]));
    assert.equal(stderr, '');
    assert.match(stdout, /Exports: \. \(default export\)/);
    const dir = await fixture.buildDir();
    const content = await readFile(join(dir, 'dist', 'index.mjs'), 'utf8');
    assert.match(content, /export\{default\}from["']@pkgsz-test\/native-dependency["']/);
});

for (const [stage, answers] of [['exports', []], ['dependencies', [['.']]]]) {
    for (const noClean of [false, true]) {
        test(`cancelling interactive ${stage} respects cleanup (noClean=${noClean})`, async t => {
            const fixture = await createFixture(t, {
                name: '@pkgsz-test/cancel-interactive',
                type: 'module',
                exports: { '.': './index.js', './other': './other.js' },
            }, {
                'index.js': 'export const foo = 123;',
                'other.js': 'export const other = 456;',
            });
            await assert.rejects(fixture.run(noClean ? ['-icg'] : ['-ig'],
                await promptEnvironment(fixture, answers)), error => {
                assert.equal(error.code, 1);
                assert.match(error.stdout + error.stderr, /Selecting exports and dependencies \(failed\)\nCancelled/);
                assert.doesNotMatch(error.stdout + error.stderr, /at interactiveMode/);
                return true;
            });
            const dirs = (await readdir(fixture.root, { withFileTypes: true }))
                .filter(entry => entry.isDirectory() && entry.name.startsWith('pkgsz-'));
            assert.equal(dirs.length, noClean ? 1 : 0);
        });
    }
}

for (const name of ['nested-manifest', '@pkgsz-test/nested-manifest']) {
    test(`reads the owning manifest instead of the nested type marker for ${name}`, async t => {
        const fixture = await createFixture(t, {
            name,
            exports: { '.': './dist/esm/index.js', './other': './dist/esm/other.js' },
        }, {
            'dist/esm/package.json': '{"type":"module"}',
            'dist/esm/index.js': 'export const foo = 123;',
            'dist/esm/other.js': 'export const bar = 456;',
        });
        const { stdout, stderr } = await fixture.run(['-jg']);
        const result = JSON.parse(stdout);
        assert.equal(stderr, '');
        assert.deepEqual(result.metadata, { name, version: '1.2.3' });
        assert.deepEqual(result.exports, ['.', './other']);
        assert.deepEqual(result.includedExports, [{ export: '.', defaultExport: false }]);
    });
}

for (const dependency of ['nested-dependency', '@pkgsz-test/nested-dependency']) {
    test(`composition attributes nested ${dependency} bytes to the owning package`, async t => {
        const name = '@pkgsz-test/nested-composition';
        const fixture = await createFixture(t, {
            name,
            type: 'module',
            main: './index.js',
            dependencies: { [dependency]: '1.2.3' },
            bundleDependencies: [dependency],
        }, {
            'index.js': `export { child } from ${JSON.stringify(dependency)};`,
            [`node_modules/${dependency}/package.json`]: JSON.stringify({
                name: dependency, version: '1.2.3', type: 'module', main: './index.js',
            }),
            [`node_modules/${dependency}/index.js`]: 'export const child = "this code belongs to the nested dependency";',
        });
        const { stdout, stderr } = await fixture.run(['-jg']);
        assert.equal(stderr, '');
        const composition = new Map(JSON.parse(stdout).composition);
        assert.ok(composition.get(dependency) > 0, `${dependency} must have its own composition entry`);
        assert.equal(composition.has(name), false, 'a pure reexport must not own dependency bytes');
    });
}
