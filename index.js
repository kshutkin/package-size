#!/usr/bin/env node
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat, rm } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { cli } from 'cleye';
import { exec } from 'node:child_process';
import { promisify } from 'util';
import { gzip, constants } from 'zlib';
import kleur from 'kleur';
import terminalColumns from 'terminal-columns';
import '@niceties/draftlog-appender';
import { createLogger } from '@niceties/logger';

const startTime = Date.now();

const execAsync = promisify(exec);
const gzipAsync = promisify(gzip);

const __dirname = dirname(fileURLToPath(import.meta.url));

const cleanup = [];

const { packageName, version } = await getCliArgs();

const logger = createLogger('pkgsz');

logger(' ', 2 /*info*/);

const dirName = await createDirs();

await installPackage();

const filesInNMPromise = filesInDir(join(dirName, 'node_modules'));

const { exports, version: packageVersion } = await resolvePackageJson();

if (version && version !== packageVersion) {
    logger(`The requested version of the package is ${version}, but the version specified in the installed package.json is ${packageVersion}`, 3 /*warn*/);
}

await buildPackage(exports);

const [pathsInDist, pathsInNm] = await Promise.all([filesInDir(join(dirName, 'dist')), filesInNMPromise]);

const [size, gzSize, installSize] = await Promise.all([
    dirSize(pathsInDist),
    dirGzSize(pathsInDist),
    dirSize(pathsInNm),
]);

logger.finish(`Package: ${kleur.green(packageName)}@${kleur.blue(packageVersion)}`);

console.log();

console.log(terminalColumns([
    ['Size minified', ...formatSize(size)],
    ['Gzipped size', ...formatSize(gzSize)],
    ['Install size', ...formatSize(installSize)],
    ['Number of files', String(pathsInNm.length), '']
], [
    {
        width: 'content-width',
        paddingRight: 4
    },
    {
        width: 'content-width',
        paddingRight: 4
    },
    {
        width: 'content-width'
    }
]));

exit(0);

// high level functions

async function buildPackage(exports) {
    return wrapWithLogger(async () => {
        if (exports.length) {
            logger(`Found subpath exports: ${kleur.green(exports.join(', '))}`, 2 /*info*/);
            logger(' ', 2 /*info*/);
            logger(kleur.yellow('Note: Building default export'), 2 /*info*/);
            logger(' ', 2 /*info*/);
        }

        const indexFile = `export * as _ from '${packageName}';`;

        await writeFile(join(dirName, 'src', 'index.js'), indexFile);

        await execEx(join(__dirname, 'node_modules/.bin/pkgbld --formats=es --compress=es --includeExternals'), { cwd: dirName });
    }, 'Building package');
}

async function resolvePackageJson() {
    try {
        return wrapWithLogger(async () => {
            const url = `console.log(import.meta.resolve(\\"${packageName}/package.json\\"));`;
            const fileUrl = await execEx(`node --input-type=module -e "${url}"`, { cwd: dirName });
            const path = fileURLToPath(fileUrl);
            const pkg = JSON.parse((await readFile(path)).toString());
            const exports = [];
            if ('exports' in pkg && typeof pkg.exports === 'object' && pkg.exports !== null) {
                exports.push(...Object.keys(pkg.exports).filter(exp => exp.startsWith('.')));
            }
            /** @type {string} */
            const version = typeof pkg.version === 'string' ? pkg.version : String(pkg.version);
            return { exports, version };
        }, 'Resolving package.json', false);
    } catch (e) {
        return { exports: [], version: '' };
    }
}

function installPackage() {
    const pkg = {
        main: 'dist/index.js',
        dependencies: {
            [packageName]: version ?? '*'
        }
    };

    return wrapWithLogger(async () => {
        await writeFile(join(dirName, 'package.json'), JSON.stringify(pkg, null, 2));

        await execEx('npm i', { cwd: dirName });
    }, 'Installing package');
}

function createDirs() {
    return wrapWithLogger(async () => {
        const dirName = await mkdtemp(join(tmpdir(), 'pkgsz-'));

        cleanup.push(() => rm(dirName, { recursive: true, force: true }));

        await mkdir(join(dirName, 'src'), { recursive: true });

        return dirName;
    }, 'Creating temporary directories');
}

async function getCliArgs() {
    const version = await getMyVersion();

    const argv = cli({
        name: 'pkgsz',

        version,

        parameters: [
            '<package name>',
            '[version]'
        ],

        flags: {
            registry: {
                type: String,
                alias: 'r',
                description: 'The npm registry to use when installing the package'
            }
        },

        help: {
            description: 'Measure the size of a package and its dependencies.',

            examples: [
                'npx pkgsz lodash',
                'npx pkgsz lodash 4.17.21'
            ],
        }
    });
    return {
        version: argv._.version,
        packageName: argv._.packageName
    };
}

async function getMyVersion() {
    const pkg = await readPackage(resolve(__dirname));

    return pkg.version ?? '<unknown>';
}

// low level functions

/**
* @param {string} dir
* @returns {object | undefined}
*/
async function readPackage(dir) {
    const packageFileName = resolve(dir, 'package.json');
    try {
        const pkgFile = await readFile(packageFileName);
        return JSON.parse(pkgFile.toString());
    } catch (e) { /**/ }
}

/**
 * @param {string[]} paths
 */
async function dirSize(paths) {
    return (await Promise.all(paths.map(async path => {

        const { size } = await stat(path);

        return size;
    }))).reduce((i, size) => i + size, 0);
}

/**
 * @param {string[]} paths
 */
async function dirGzSize(paths) {
    return (await Promise.all(paths.map(async path => {
        const fileContent = await readFile(path);
        const { length } = await gzipAsync(fileContent, { level: constants.Z_BEST_COMPRESSION });

        return length;
    }))).reduce((i, size) => i + size, 0);
}

/**
 * @param {string} dir
 */
async function filesInDir(dir) {
    const dirEntries = await readdir(dir, { recursive: true, withFileTypes: true });
    return dirEntries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
}

/**
 * @param {number} size
 */
function formatSize(size) {
    if (size < 1024) {
        return [`${kleur.cyan(size)} bytes`, ''];
    }

    if (size < 1024 * 1024) {
        return [`${kleur.cyan((size / 1024).toFixed(2))} kilobyte`, `(${size} bytes)`];
    }

    return [`${kleur.cyan((size / 1024 / 1024).toFixed(2))} megabyte`, `(${size} bytes)`];
}

async function execEx(command, options) {
    try {
        const result = await execAsync(command, options);
        if (result.stderr) {
            logger(result.stderr, 0 /*verbose*/);
        }
        return result.stdout.toString();
    } catch (e) {
        throw new Error(e.stderr);
    }
}

/**
 * @param {number} code
 */
async function exit(code) {
    await Promise.all(cleanup.map(fn => fn()));
    process.exit(code);
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} message
 * @returns {Promise<T>}
 */
async function wrapWithLogger(fn, message, fatal = true) {
    try {
        logger.start(message + '...');
        return await fn(logger);
    } catch (error) {
        if (fatal) {
            logger.finish(message + '(failed)', 3 /*error*/, error);
            exit(1);
        } else {
            logger(message + '(failed)', 3 /*error*/, error);
            throw error;
        }
    }
}