import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('./index.js', import.meta.url));
const name = '@pkgsz-verification/target';
const empty = { verified: 0, invalid: [] };

async function fixture(t, { signature = 'valid', attestation = false } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'pkgsz-verification-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, 'fixture');
    await mkdir(dir);
    const manifest = { name, version: '1.0.0', type: 'module', main: './index.js' };
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(dir, 'index.js'), 'export const value = 42;');
    const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: dir });
    const [packed] = Object.values(JSON.parse(stdout));
    const tarball = await readFile(join(root, packed.filename));
    const digest = createHash('sha512').update(tarball).digest();
    const integrity = `sha512-${digest.toString('base64')}`;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const keyid = `SHA256:${createHash('sha256').update(key).digest('base64')}`;
    // A real ECDSA signature, with a different signed message for the invalid case.
    const sig = sign('sha256', Buffer.from(`${name}@1.0.0:${signature === 'invalid' ? 'wrong-integrity' : integrity}`), privateKey).toString('base64');
    const requests = [];
    const server = createServer((req, res) => {
        const path = decodeURIComponent(req.url);
        requests.push(path);
        res.setHeader('content-type', 'application/json');
        if (path === '/-/npm/v1/keys') {
            res.end(JSON.stringify({ keys: [{ keyid, key, expires: null, keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256' }] }));
        } else if (path.startsWith('/-/npm/v1/security/')) {
            req.resume();
            res.end('{}');
        } else if (path === '/target.tgz') {
            res.setHeader('content-type', 'application/octet-stream');
            res.end(tarball);
        } else if (path === `/${name}`) {
            const dist = {
                tarball: `${url}/target.tgz`, integrity,
                ...(signature === 'missing' ? {} : { signatures: [{ keyid, sig }] }),
                ...(attestation ? { attestations: { url: `${url}/attestations` } } : {}),
            };
            res.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { ...manifest, dist } } }));
        } else if (path === '/attestations') {
            // Correct subject/digest, but an untrusted bundle: npm must actually
            // run the Sigstore verifier, rather than trust the metadata URL.
            const statement = { subject: [{ name: `pkg:npm/%40pkgsz-verification/target@1.0.0`, digest: { sha512: digest.toString('hex') } }] };
            res.end(JSON.stringify({ attestations: [{
                predicateType: 'https://slsa.dev/provenance/v1',
                bundle: {
                    mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.2',
                    dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'), signatures: [{ sig }] },
                    verificationMaterial: { tlogEntries: [], x509CertificateChain: { certificates: [] } },
                },
            }] }));
        } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return {
        root, url, requests,
        async run(args = ['-jg'], env = {}, { audit = false } = {}) {
            try {
                const result = await run(process.execPath, [cli, name, '1.0.0', '--registry', url, ...(audit ? [] : ['--no-audit']), ...args], {
                    timeout: 90000, maxBuffer: 32 * 1024 * 1024,
                    env: { ...process.env, CI: 'true', NO_COLOR: 'true', TMPDIR: root, TMP: root, TEMP: root, ...env },
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
        async mock(response) {
            const preload = join(root, 'mock-verification.mjs');
            await writeFile(preload, `
                import childProcess from 'node:child_process';
                import { syncBuiltinESMExports } from 'node:module';
                import { promisify } from 'node:util';
                const original = childProcess.execFile;
                const run = promisify(original);
                const response = ${JSON.stringify(response)};
                function execFile(...args) { return original(...args); }
                execFile[promisify.custom] = async (file, args, options) => {
                    if (file !== 'npm' || args[0] !== 'audit' || args[1] !== 'signatures') return run(file, args, options);
                    if (!args.includes('--json=false') || !args.includes('--color=false') || args.some(arg => arg.includes('audit-only.invalid'))) throw new Error('Wrong verification options');
                    if (response.code !== 0) throw Object.assign(new Error('Test verification failure'), response);
                    return { stdout: response.stdout, stderr: '' };
                };
                childProcess.execFile = execFile;
                syncBuiltinESMExports();
            `);
            return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` };
        },
    };
}

test('verifies real ECDSA registry signatures by default, independently of --no-audit', async t => {
    const f = await fixture(t);
    const result = await f.run(['-jgc', '--audit-registry=https://audit-only.invalid'], { npm_config_json: 'true', npm_config_color: 'always', npm_config_package_lock: 'false' });
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.verification, { status: 'complete', provider: 'npm', signatures: { verified: 1, invalid: [] }, attestations: empty });
    assert.equal(Object.hasOwn(output, 'audit'), false);
    assert.ok(f.requests.includes('/-/npm/v1/keys'));
    const [build] = await f.buildDirs();
    assert.ok(await readFile(join(f.root, build, 'package-lock.json')));
});

for (const kind of ['signature', 'attestation']) {
    test(`reports a cryptographically invalid ${kind}, preserves sizes and cleans up`, async t => {
        const f = await fixture(t, kind === 'signature' ? { signature: 'invalid' } : { attestation: true });
        const result = await f.run();
        assert.equal(result.code, 1, result.stderr + result.stdout);
        assert.equal(result.stderr, '');
        const output = JSON.parse(result.stdout);
        assert.equal(output.verification.status, 'complete');
        assert.deepEqual(output.verification[kind === 'signature' ? 'signatures' : 'attestations'].invalid, [`${name}@1.0.0`]);
        assert.ok(output.results.some(({ id, value }) => id === 'sizeMinified' && value > 0));
        assert.deepEqual(await f.buildDirs(), []);
        if (kind === 'attestation') assert.ok(f.requests.includes('/attestations'));
    });
}

test('missing signatures are neither verified nor invalid', async t => {
    const f = await fixture(t, { signature: 'missing' });
    const result = await f.run();
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).verification, { status: 'complete', provider: 'npm', signatures: empty, attestations: empty });
});

test('--no-verify skips verification requests and omits its JSON field', async t => {
    const f = await fixture(t, { signature: 'invalid' });
    const result = await f.run(['-jg', '--no-verify']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(Object.hasOwn(JSON.parse(result.stdout), 'verification'), false);
    assert.equal(f.requests.includes('/-/npm/v1/keys'), false);
    assert.deepEqual(await f.buildDirs(), []);
});

test('verification and vulnerability auditing are both enabled by default', async t => {
    const f = await fixture(t);
    const result = await f.run(['-jg'], {}, { audit: true });
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.audit.status, 'complete');
    assert.equal(output.verification.status, 'complete');
    assert.equal(output.verification.signatures.verified, 1);
    assert.ok(f.requests.some(path => path.startsWith('/-/npm/v1/security/')));
    assert.ok(f.requests.includes('/-/npm/v1/keys'));
});

const verified = 'audited 2 packages in 1s\n\n2 packages have verified registry signatures\n\n1 package has a verified attestation\n(use --json --include-attestations to view attestation details)\n';
const invalid = `audited 3 packages in 1s\n\n1 package has a verified registry signature\n\n1 package has an invalid registry signature:\n\n${name}@1.0.0 (https://registry.npmjs.org/)\n\n1 package has an invalid attestation:\n\n@scope/dependency@2.0.0 (https://registry.npmjs.org/)\n\nSomeone might have tampered with these packages since they were published on the registry!\n`;

test('reports verified attestations and signature counts in JSON and terminal output', async t => {
    const f = await fixture(t);
    const env = await f.mock({ code: 0, stdout: verified });
    const result = await f.run(['-jg'], env);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).verification, { status: 'complete', provider: 'npm', signatures: { verified: 2, invalid: [] }, attestations: { verified: 1, invalid: [] } });
    const text = await f.run(['-g'], env);
    assert.equal(text.code, 0, text.stderr + text.stdout);
    assert.match(text.stdout, /Signatures and attestations:/);
    assert.match(text.stdout, /Registry signatures\s+2 verified\s+0 invalid/);
    assert.match(text.stdout, /Attestations\s+1 verified\s+0 invalid/);
});

test('lists invalid signatures and attestations separately in terminal output', async t => {
    const f = await fixture(t);
    const result = await f.run(['-gc'], await f.mock({ code: 1, stdout: invalid }));
    assert.equal(result.code, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /Registry signatures\s+1 verified\s+1 invalid/);
    assert.match(result.stdout, /Attestations\s+0 verified\s+1 invalid/);
    assert.match(result.stdout, /@pkgsz-verification\/target@1.0.0: invalid registry signature/);
    assert.match(result.stdout, /@scope\/dependency@2.0.0: invalid attestation/);
    assert.equal((await f.buildDirs()).length, 1);
});

for (const [label, response] of [
    ['unrecognized output', { code: 0, stdout: 'Something changed' }],
    ['incomplete report', { code: 0, stdout: 'audited 1 package in 0s\n' }],
    ['truncated invalid packages', { code: 1, stdout: 'audited 1 package in 0s\n\n1 package has an invalid attestation:\n' }],
    ['unexpected exit', { code: 2, stdout: verified }],
    ['inconsistent exit', { code: 0, stdout: invalid }],
    ['timeout', { code: null, killed: true, stdout: verified }],
    ['unavailable npm', { code: 'ENOENT' }],
    ['buffer overflow', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }],
    ['npm verification failure', { code: 1, stdout: '', stderr: 'npm error code EATTESTATIONSUBJECT\nnpm error subject digest mismatch' }],
]) {
    test(`${label} is a verification error, not a verified result`, async t => {
        const f = await fixture(t);
        const result = await f.run(['-jg'], await f.mock(response));
        assert.equal(result.code, 1, result.stderr + result.stdout);
        const output = JSON.parse(result.stdout);
        assert.equal(output.verification.status, 'error');
        assert.ok(output.verification.error);
        if (label === 'npm verification failure') assert.match(output.verification.error, /EATTESTATIONSUBJECT.*\n.*subject digest mismatch/);
        assert.equal(Object.hasOwn(output.verification, 'signatures'), false);
        assert.ok(output.results.some(({ id, value }) => id === 'sizeMinified' && value > 0));
        assert.deepEqual(await f.buildDirs(), []);
    });
}

test('verification errors remain visible in terminal output', async t => {
    const f = await fixture(t);
    const result = await f.run(['-g'], await f.mock({ code: 0, stdout: '{}' }));
    assert.equal(result.code, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /Signatures and attestations:\s+Unavailable:/);
});
