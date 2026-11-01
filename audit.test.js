import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('./index.js', import.meta.url));
const target = '@pkgsz-audit/target';
const dependency = '@pkgsz-audit/dependency';
const zeroCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
const cleanReport = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: zeroCounts },
};

function advisory(name, id = 12345) {
    return {
        id, name, title: `Test vulnerability in ${name}`, severity: 'high',
        url: `https://example.com/advisories/${id}`, vulnerable_versions: '<=1.0.0',
        cwe: ['CWE-400'], cvss: { score: 7.5, vectorString: null },
    };
}

async function registry(t, packages, { advisories = {}, unavailable = false } = {}) {
    const requests = [];
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const body = (req.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString();
        const path = decodeURIComponent(req.url);
        requests.push({ method: req.method, path, body });
        res.setHeader('content-type', 'application/json');
        if (path.startsWith('/-/npm/v1/security/')) {
            res.statusCode = unavailable ? 404 : 200;
            res.end(JSON.stringify(unavailable ? { error: 'Audit endpoint unavailable' } : advisories));
            return;
        }
        const pkg = packages.find(pkg => path === `/${pkg.manifest.name}` || path === pkg.tarballPath);
        if (!pkg) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Unknown package' }));
        } else if (path === pkg.tarballPath) {
            res.setHeader('content-type', 'application/octet-stream');
            res.end(pkg.tarball);
        } else {
            const manifest = { ...pkg.manifest, dist: { tarball: `${url}${pkg.tarballPath}` } };
            res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': manifest } }));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    return { url, requests, auditRequests: () => requests.filter(req => req.path.startsWith('/-/npm/v1/security/')) };
}

async function fixture(t, { withDependency = false } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'pkgsz-audit-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packages = [];
    for (const name of withDependency ? [dependency, target] : [target]) {
        const dir = join(root, name.split('/')[1]);
        const manifest = {
            name, version: '1.0.0', type: 'module', main: './index.js',
            ...(name === target && withDependency ? { dependencies: { [dependency]: '1.0.0' } } : {}),
        };
        await mkdir(dir);
        await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
        await writeFile(join(dir, 'index.js'), 'export const value = 42;');
        const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: dir });
        // npm 11 returns an array; npm 12 returns an object keyed by package name.
        const [packed] = Object.values(JSON.parse(stdout));
        const tarballFile = join(root, packed.filename);
        packages.push({ manifest, tarball: await readFile(tarballFile), tarballFile, tarballPath: `/tarballs/${name.split('/')[1]}.tgz` });
    }
    const install = await registry(t, packages);
    return {
        root, packages, install,
        async run(args = ['-jg'], env = {}) {
            try {
                const result = await run(process.execPath, [cli, target, `file:${packages.at(-1).tarballFile}`, ...args], {
                    timeout: 30000, maxBuffer: 32 * 1024 * 1024,
                    env: {
                        ...process.env, CI: 'true', NO_COLOR: 'true',
                        TMPDIR: root, TMP: root, TEMP: root,
                        npm_config_cache: join(root, 'cache'),
                        npm_config_registry: install.url,
                        ...env,
                    },
                });
                return { ...result, code: 0 };
            } catch (error) {
                if (error.killed || typeof error.code !== 'number') throw error;
                return error;
            }
        },
        async buildDirs() {
            return (await readdir(root, { withFileTypes: true }))
                .filter(entry => entry.isDirectory() && entry.name.startsWith('pkgsz-'))
                .map(entry => entry.name);
        },
    };
}

test('audits by default using npm configuration and forces a lockfile', async t => {
    const f = await fixture(t);
    const { code, stdout, stderr } = await f.run(['-jgc'], {
        npm_config_package_lock: 'false', npm_config_audit: 'false',
    });
    assert.equal(code, 0, stderr + stdout);
    assert.equal(stderr, '');
    const result = JSON.parse(stdout);
    assert.deepEqual(result.audit, {
        status: 'complete', provider: 'npm', summary: zeroCounts,
        advisoryCount: 0,
    });
    const requests = f.install.auditRequests();
    assert.equal(requests.length, 1);
    assert.ok(JSON.parse(requests[0].body)[target].includes('1.0.0'));
    const [build] = await f.buildDirs();
    const lock = JSON.parse(await readFile(join(f.root, build, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages[`node_modules/${target}`].version, '1.0.0');
});

test('--registry applies to installation and auditing', async t => {
    const f = await fixture(t, { withDependency: true });
    const custom = await registry(t, f.packages);
    const result = await f.run(['-jg', '--registry', custom.url]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(custom.auditRequests().length, 1);
    assert.ok(custom.requests.some(req => req.path === `/${dependency}`));
    assert.equal(f.install.requests.length, 0);
});

test('--audit-registry overrides --registry without changing installation', async t => {
    const f = await fixture(t, { withDependency: true });
    const audit = await registry(t, f.packages);
    const result = await f.run(['-jg', '--registry', f.install.url, '--audit-registry', audit.url]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.ok(f.install.requests.some(req => req.path === `/${dependency}`));
    assert.equal(f.install.auditRequests().length, 0);
    assert.equal(audit.auditRequests().length, 1);
    const submitted = JSON.parse(audit.auditRequests()[0].body);
    assert.ok(submitted[target]);
    assert.ok(submitted[dependency]);
});

test('--audit-registry overrides npm configuration without --registry', async t => {
    const f = await fixture(t);
    const audit = await registry(t, f.packages);
    const result = await f.run(['-jg', '--audit-registry', audit.url]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(f.install.auditRequests().length, 0);
    assert.equal(audit.auditRequests().length, 1);
});

test('--no-audit skips requests and omits the JSON audit field', async t => {
    const f = await fixture(t);
    const audit = await registry(t, f.packages, { unavailable: true });
    const result = await f.run(['-jg', '--no-audit', '--audit=full', '--audit-registry', audit.url]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(Object.hasOwn(JSON.parse(result.stdout), 'audit'), false);
    assert.equal(f.install.auditRequests().length, 0);
    assert.equal(audit.requests.length, 0);
    assert.deepEqual(await f.buildDirs(), []);
});

for (const transitive of [false, true]) {
    test(`reports ${transitive ? 'transitive' : 'direct'} vulnerabilities without failing`, async t => {
        const f = await fixture(t, { withDependency: transitive });
        const name = transitive ? dependency : target;
        const audit = await registry(t, f.packages, { advisories: { [name]: [advisory(name), advisory(name, 23456)] } });
        const args = ['-jg', '--audit=full', '--audit-registry', audit.url];
        const result = await f.run(args);
        assert.equal(result.code, 0, result.stderr + result.stdout);
        assert.equal(result.stderr, '');
        const report = JSON.parse(result.stdout);
        assert.equal(report.audit.status, 'complete');
        assert.equal(report.audit.advisoryCount, 2);
        assert.equal(report.audit.summary.total, Object.keys(report.audit.vulnerabilities).length);
        assert.equal(report.audit.vulnerabilities[name].isDirect, !transitive);
        assert.equal(report.audit.vulnerabilities[name].severity, 'high');
        if (transitive) {
            assert.deepEqual(report.audit.vulnerabilities[target].via, [dependency]);
            assert.equal(report.audit.summary.total, 2);
        }
        assert.ok(report.results.some(({ id, value }) => id === 'sizeMinified' && value > 0));
        assert.deepEqual(await f.buildDirs(), []);
        const summaryJson = await f.run(['-jg', '--audit-registry', audit.url]);
        assert.equal(summaryJson.code, 0, summaryJson.stderr + summaryJson.stdout);
        const summary = JSON.parse(summaryJson.stdout).audit;
        assert.deepEqual(summary.summary, report.audit.summary);
        assert.equal(summary.advisoryCount, 2);
        assert.equal(Object.hasOwn(summary, 'vulnerabilities'), false);
        assert.doesNotMatch(summaryJson.stdout, /Test vulnerability|example\.com\/advisories/);

        const text = await f.run(['-g', '--audit=full', '--audit-registry', audit.url]);
        assert.equal(text.code, 0, text.stderr + text.stdout);
        assert.match(text.stdout, /Audit:/);
        assert.doesNotMatch(text.stdout, /--audit=full for details/);
        assert.match(text.stdout, /2 unique advisories/);
        assert.match(text.stdout, /https:\/\/example.com\/advisories\/12345/);
        assert.match(text.stdout, transitive ? /high\s+dependency/ : /high\s+target/);
        for (const mode of [[], ['--audit=summary']]) {
            const text = await f.run(['-g', ...mode, '--audit-registry', audit.url]);
            assert.equal(text.code, 0, text.stderr + text.stdout);
            assert.match(text.stdout, /Audit: \(--audit=full for details\)/);
            assert.match(text.stdout, /2 unique advisories/);
            assert.match(text.stdout, /high/);
            assert.doesNotMatch(text.stdout, /Test vulnerability|example\.com\/advisories|high\s+(target|dependency)/);
            assert.doesNotMatch(text.stdout, /\x1b\[/);
        }
    });
}

test('text output reports a clean audit', async t => {
    const f = await fixture(t);
    const result = await f.run(['-g']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Audit: \(--audit=full for details\)\s+No known vulnerabilities found\./);
});

for (const noClean of [false, true]) {
    test(`audit endpoint failures preserve sizes and cleanup policy (noClean=${noClean})`, async t => {
        const f = await fixture(t);
        const audit = await registry(t, f.packages, { unavailable: true });
        const args = [noClean ? '-jgc' : '-jg', '--audit-registry', audit.url];
        const result = await f.run(args);
        assert.equal(result.code, 1);
        assert.equal(result.stderr, '');
        const report = JSON.parse(result.stdout);
        assert.equal(report.audit.status, 'error');
        assert.match(report.audit.error, /npm audit failed/);
        assert.ok(report.results.some(({ id, value }) => id === 'sizeMinified' && value > 0));
        assert.ok(audit.auditRequests().length > 0);
        assert.equal(f.install.auditRequests().length, 0, 'must not fall back to the install registry');
        assert.equal((await f.buildDirs()).length, noClean ? 1 : 0);
        if (!noClean) {
            const text = await f.run(['-g', '--audit-registry', audit.url]);
            assert.equal(text.code, 1);
            assert.match(text.stdout, /minified/);
            assert.match(text.stdout, /Audit: \(--audit=full for details\)\s+Unavailable: npm audit failed/);
        }
    });
}

async function mockAudit(f, response) {
    const preload = join(f.root, 'mock-audit.mjs');
    await writeFile(preload, `
        import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { promisify } from 'node:util';
        const original = childProcess.execFile;
        const run = promisify(original);
        const response = ${JSON.stringify(response)};
        function execFile(...args) { return original(...args); }
        execFile[promisify.custom] = async (file, args, options) => {
            if (file !== 'npm' || args[0] !== 'audit') return run(file, args, options);
            if (response.code !== 0) throw Object.assign(new Error('Test subprocess failure'), response);
            return { stdout: response.stdout, stderr: '' };
        };
        childProcess.execFile = execFile;
        syncBuiltinESMExports();
    `);
    return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` };
}

for (const [name, response, expected] of [
    ['invalid JSON', { code: 0, stdout: 'not JSON' }, /invalid JSON report/],
    ['invalid schema', { code: 0, stdout: '{}' }, /invalid or unsupported report/],
    ['unknown version', { code: 0, stdout: JSON.stringify({ ...cleanReport, auditReportVersion: 3 }) }, /unsupported report/],
    ['inconsistent counts', { code: 0, stdout: JSON.stringify({ ...cleanReport, metadata: { vulnerabilities: { ...zeroCounts, high: 1, total: 1 } } }) }, /unsupported report/],
    ['timeout', { code: null, killed: true, stdout: JSON.stringify(cleanReport) }, /timed out or was terminated/],
    ['signal', { code: null, signal: 'SIGTERM', stdout: JSON.stringify(cleanReport) }, /Could not run npm audit/],
    ['buffer overflow', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, /exceeded the output limit/],
    ['unexpected exit', { code: 2, stdout: JSON.stringify(cleanReport) }, /exit code 2/],
]) {
    test(`${name} is reported as an audit failure, not a clean audit`, async t => {
        const f = await fixture(t);
        const result = await f.run(['-jg'], await mockAudit(f, response));
        assert.equal(result.code, 1);
        assert.equal(result.stderr, '');
        const report = JSON.parse(result.stdout);
        assert.equal(report.audit.status, 'error');
        assert.match(report.audit.error, expected);
        assert.ok(report.results.some(({ id, value }) => id === 'sizeMinified' && value > 0));
        assert.deepEqual(await f.buildDirs(), []);
    });
}

test('large audit JSON reports remain complete when piped', async t => {
    const f = await fixture(t);
    const detail = {
        source: 12345, name: target, severity: 'high',
        title: 'x'.repeat(2 * 1024 * 1024), url: 'https://example.com/advisories/12345',
    };
    const report = {
        auditReportVersion: 2,
        vulnerabilities: { [target]: { name: target, severity: 'high', isDirect: true, via: [detail] } },
        metadata: { vulnerabilities: { ...zeroCounts, high: 1, total: 1 } },
    };
    const result = await f.run(['-jg', '--audit=full'], await mockAudit(f, { code: 1, stdout: JSON.stringify(report) }));
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.length > 2 * 1024 * 1024);
    const output = JSON.parse(result.stdout);
    assert.equal(output.audit.vulnerabilities[target].via[0].title, detail.title);
    assert.equal(output.audit.advisoryCount, 1);
});

async function colorEnvironment(f, env = {}) {
    const preload = join(f.root, 'color-support.mjs');
    // Simulate a color-capable terminal while keeping stdout piped for assertions.
    await writeFile(preload, 'process.stdout.hasColors = () => true;');
    return { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` };
}

test('audit summary colors reflect severity and zero counts', async t => {
    const f = await fixture(t);
    const severities = ['info', 'low', 'moderate', 'high', 'critical'];
    const vulnerabilities = Object.fromEntries(severities.map((severity, index) => {
        const name = `@pkgsz-audit/${severity}`;
        return [name, {
            name, severity, isDirect: false,
            via: [{ source: index + 1, name, severity, title: 'Hidden advisory', url: 'https://example.com/advisory' }],
        }];
    }));
    const report = {
        auditReportVersion: 2, vulnerabilities,
        metadata: { vulnerabilities: { info: 1, low: 1, moderate: 1, high: 1, critical: 1, total: 5 } },
    };
    const env = await mockAudit(f, { code: 1, stdout: JSON.stringify(report) });
    const text = await f.run(['-g'], await colorEnvironment(f, env));
    assert.equal(text.code, 0, text.stderr + text.stdout);
    for (const heading of ['Audit:', 'Exports:', 'Composition:']) {
        assert.ok(text.stdout.includes(`\x1b[1m${heading}\x1b[22m`), `${heading} must be bold`);
    }
    assert.ok(text.stdout.includes('\x1b[36m--audit=full\x1b[39m'));
    assert.doesNotMatch(text.stdout, /\x1b\[(?:\d+;)*(?:4|21|24)(?:;\d+)*m/);
    for (const [severity, color] of [['info', 36], ['low', 34], ['moderate', 33], ['high', 31], ['critical', 91]]) {
        assert.ok(text.stdout.includes(`\x1b[${color}m1 ${severity}\x1b[39m`), `${severity} must have its severity color`);
    }
    assert.doesNotMatch(text.stdout, /Hidden advisory|example\.com\/advisory|@pkgsz-audit\/critical/);

    const high = await registry(t, f.packages, { advisories: { [target]: [advisory(target)] } });
    const zeros = await f.run(['-g', '--audit-registry', high.url], await colorEnvironment(f));
    assert.equal(zeros.code, 0, zeros.stderr + zeros.stdout);
    assert.ok(zeros.stdout.includes('\x1b[90m0 low\x1b[39m'));
    assert.ok(zeros.stdout.includes('\x1b[31m1 high\x1b[39m'));

    const json = await f.run(['-jg'], await colorEnvironment(f, env));
    assert.equal(json.code, 0, json.stderr + json.stdout);
    assert.doesNotMatch(json.stdout, /\x1b\[/);
    assert.equal(Object.hasOwn(JSON.parse(json.stdout).audit, 'vulnerabilities'), false);
});

test('clean audit summary is green on color-capable terminals', async t => {
    const f = await fixture(t);
    const result = await f.run(['-g'], await colorEnvironment(f));
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.ok(result.stdout.includes('\x1b[32mNo known vulnerabilities found.\x1b[39m'));
});

test('invalid audit mode is rejected before installation', async () => {
    await assert.rejects(run(process.execPath, [cli, target, '--audit=verbose', '-jg']), error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.equal(error.stderr.trim(), '--audit must be either summary or full');
        return true;
    });
});

test('audit registry arguments cannot execute shell commands', async t => {
    const f = await fixture(t);
    const marker = join(f.root, 'shell-command-ran');
    // Keep a valid URL authority so npm cannot discard the registry as invalid config.
    const result = await f.run(['-jg', '--audit-registry', `${f.install.url}/; touch "${marker}"`]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).audit.status, 'error');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
