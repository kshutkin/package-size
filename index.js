#!/usr/bin/env node
// system imports
import { exec } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { constants, gzip, brotliCompress } from 'node:zlib';
// 3rd party imports
import ora from 'ora';
import { cli } from 'cleye';
import kleur from 'kleur';
import terminalColumns from 'terminal-columns';
import { readPackageUp } from 'read-package-up';
import prompt from 'prompts';

// promisified functions
const execAsync = promisify(exec);
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

// types
/**
 * @typedef {Object} Result
 * @property {string} caption
 * @property {string} sizeShort
 * @property {string} sizeBytes
 */

/**
 * @typedef {('brotli' | 'gzip' | 'none')} CompressionMethod
 */

// globals
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @type {Set.<Result>}
 */
const results = new Set;
const cleanup = [];
const deferred = [];

const { packageName, version, flags } = await getCliArgs();

const logger = ora();

console.log();

const dirName = await createDirs();

await installPackage();

calculateNodeModulesSize();

const { exports, version: packageVersion, deps } = await resolvePackageJson();

if (version && version !== packageVersion) {
    console.warn(`Installed version is ${packageVersion}`);
}

if (flags.interactive) {
    const { selectedExports, selectedDependencies } = await interactiveMode(deps, exports);
    selectedDependencies.push(packageName);
    await buildPackage(exports, selectedExports, selectedDependencies);
} else {
    await buildPackage(exports, flags.export);
}

await calculateDistSize();

logger.succeed(`Package: ${kleur.green(packageName)}@${kleur.blue(packageVersion)}`);

exitAndReport(0);

// high level functions

async function interactiveMode(deps, exports) {
    const loggerText = logger.text;
    logger.stop();

    const { exports: selectedExports } = await prompt([
        {
            type: 'multiselect',
            name: 'exports',
            message: 'Which subpaths do you want to reexport?',
            choices: exports.map(exportName => ({ title: exportName, value: exportName }))
        }
    ]);

    const { dependencies: selectedDependencies } = await prompt([
        {
            type: 'multiselect',
            name: 'dependencies',
            message: 'Which dependencies do you want to include?',
            choices: deps.map(dependency => ({ title: dependency, value: dependency }))
        }
    ]);

    console.log(selectedExports, selectedDependencies);

    logger.start(loggerText);

    return { selectedExports, selectedDependencies };
}

function printResults() {
    console.log();

    // @ts-ignore
    console.log(terminalColumns([...results].map(result => [result.caption, result.sizeShort, result.sizeBytes]), [
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
}

function calculateDistSize() {
    return wrapWithLogger(async () => {
        const files = await filesInDir(join(dirName, 'dist'));
        const dirCompressedResults = await dirCompressedSize(files, /** @type {CompressionMethod[]} */(['none', flags.noGzip ? null : 'gzip', flags.brotli ? 'brotli' : null].filter(Boolean)));
        {
            const textSize = formatSize(dirCompressedResults.none);
            results.add({ caption: 'minified size', sizeShort: textSize[0], sizeBytes: textSize[1] });
        }
        if (!flags.noGzip) {
            const textGzSize = formatSize(dirCompressedResults.gzip);
            results.add({ caption: 'gzipped size', sizeShort: textGzSize[0], sizeBytes: textGzSize[1] });
        }
        if (flags.brotli) {
            const textBrotliSize = formatSize(dirCompressedResults.brotli);
            results.add({ caption: 'brotli compressed size', sizeShort: textBrotliSize[0], sizeBytes: textBrotliSize[1] });
        }
    }, 'Calculating sizes / finalizing');
}

/**
 * @param {string[]} pkgExports
 * @param {string[]} includeExports
 * @param {string[]} dependencies
 */
async function buildPackage(pkgExports, includeExports, dependencies = undefined) {
    const exports = includeExports.map(exportName => exportName.startsWith('./') ? exportName.substring(2) : (exportName === '.' ? exportName : undefined)).filter(Boolean);
    return wrapWithLogger(async () => {
        if (pkgExports.length) {
            console.log(`Found subpath exports: ${kleur.green(pkgExports.join(', '))}`);
            console.log();
            console.log(kleur.yellow(`Note: Building ${(exports.length === 1 && exports[0] === '.') ? 'default package export' : `subpath exports: ${exports.map(exportName => kleur.green(`./${exportName}`)).join(', ')}`}`));
            console.log();
        }

        await writeFile(join(dirName, 'src', 'index.js'), getCode(false));

        const command = getCliString();

        const result = await execEx(command, { cwd: dirName }, true);

        if (result.includes('Generated an empty chunk: "index".')) {
            await writeFile(join(dirName, 'src', 'index.js'), getCode(true));

            await execEx(command, { cwd: dirName });
        }
    }, 'Building package');

    /**
     * @param {boolean} workaround 
     */
    function getCode(workaround) {
        return exports.map(exportName => `export *${workaround ? ' as _' : ''} from '${packageName}${exportName === '.' ? '' : `/${exportName}`}';`).join('\n');
    }

    function getCliString() {
        return `npx pkgbld --no-ts-config --no-update-package-json --no-clean --formats=es --compress=es --includeExternals${dependencies ? `=${dependencies.join(',')}` : ''}`;
    }
}

async function resolvePackageJson() {
    try {
        return await wrapWithLogger(async () => {
            const url = `console.log(import.meta.resolve(\\"${packageName}\\"));`;
            const fileUrl = await execEx(`node --input-type=module -e "${url}"`, { cwd: dirName });
            const path = fileURLToPath(fileUrl);
            const packageUp = await readPackageUp({ cwd: path });
            const pkg = packageUp.packageJson;
            if (!packageUp.path.replaceAll('\\', '/').includes(packageName)) {
                throw new Error(`Cannot find package.json for ${packageName}`);
            }
            const exports = [];
            if ('exports' in pkg && typeof pkg.exports === 'object' && pkg.exports !== null) {
                exports.push(...Object.keys(pkg.exports).filter(exp => exp.startsWith('.')));
            }
            /** @type {string} */
            const version = typeof pkg.version === 'string' ? pkg.version : String(pkg.version);
            const dependencies = Object.keys(pkg.dependencies ?? {});
            const peerDependencies = Object.keys(pkg.peerDependencies ?? {});
            const deps = new Set([...dependencies, ...peerDependencies]);
            return { exports, version, deps: [...deps] };
        }, 'Resolving package.json', false);
    } catch (e) {
        return { exports: [], version: '<unknown>', deps: [] };
    }
}

function calculateNodeModulesSize() {
    deferred.push((async () => {
        const files = await filesInDir(join(dirName, 'node_modules'));
        const size = await dirSize(files);
        const text = formatSize(size);
        results.add({ caption: 'node_modules size', sizeShort: text[0], sizeBytes: text[1] });
        results.add({ caption: 'node_modules files', sizeShort: String(files.length), sizeBytes: '' });
    })());
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

        await execEx(`npm i --no-audit --no-fund --no-update-notifier --no-progress ${flags.enableScripts ? '' : '--ignore-scripts'} ${flags.registry ? (`--registry=${flags.registry}`) : ''}`, { cwd: dirName });
    }, 'Installing package');
}

function createDirs() {
    return wrapWithLogger(async () => {
        const dirName = await mkdtemp(join(tmpdir(), 'pkgsz-'));

        if (!flags.noClean) {
            cleanup.push(() => rm(dirName, { recursive: true, force: true }));
        } else {
            cleanup.push(() => { console.log('Cleanup disabled, directory is left at: ', dirName); });
        }

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
            },
            export: {
                type: [String],
                alias: 'e',
                description: 'Reexport given subpath from the package',
                default: ['.']
            },
            noGzip: {
                type: Boolean,
                alias: 'g',
                description: 'Do not calculate gzipped size',
                default: false
            },
            brotli: {
                type: Boolean,
                alias: 'b',
                description: 'Calculate brotli compressed size',
                default: false
            },
            noClean: {
                type: Boolean,
                alias: 'c',
                description: 'Do not clean the temporary directory',
                default: false
            },
            enableScripts: {
                type: Boolean,
                alias: 's',
                description: 'Enable scripts',
                default: false
            },
            interactive: {
                type: Boolean,
                alias: 'i',
                description: 'Interactive mode',
                default: false
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
        packageName: argv._.packageName,
        flags: argv.flags
    };
}

/**
 * @returns {Promise<string>}
 */
async function getMyVersion() {
    const pkg = await readPackage(resolve(__dirname));

    return pkg.version ?? '<unknown>';
}

/**
 * @param {number} code
 */
async function exitAndReport(code) {
    await Promise.all(deferred);
    printResults();
    await Promise.all(cleanup.map(fn => fn()));
    process.exit(code);
}

// low level functions

/**
* @param {string} dir
* @returns {Promise<object | undefined>}
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
 * @param {CompressionMethod[]} methods
 */
async function dirCompressedSize(paths, methods) {
    const methodsSet = new Set(methods);
    if (methodsSet.has('none') && methodsSet.size === 1) {
        return {
            'none': await dirSize(paths)
        };
    }
    /** @type {Partial<Record<CompressionMethod, number>>} */
    const results = {};
    for (const method of methodsSet) {
        results[method] = 0;
    }
    await Promise.all(paths.map(async path => {
        const fileContent = await readFile(path);
        if (methodsSet.has('none')) {
            results.none += fileContent.length;
        }
        if (methodsSet.has('gzip')) {
            const { length } = await gzipAsync(fileContent, { level: constants.Z_BEST_COMPRESSION });
            results.gzip += length;
        }
        if (methodsSet.has('brotli')) {
            const { length } = await brotliAsync(fileContent, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } });
            results.brotli += length;
        }
    }));
    return results;
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
        return [`${kleur.cyan((size / 1024).toFixed(2))} KiB`, `(${size} bytes)`];
    }

    return [`${kleur.cyan((size / 1024 / 1024).toFixed(2))} MiB`, `(${size} bytes)`];
}

/**
 * @param {string} command 
 * @param {import('node:child_process').ExecOptions} options 
 */
async function execEx(command, options, returnStderr = false) {
    try {
        const result = await execAsync(command, options);
        if (result.stderr) {
            console.debug(result.stderr);
        }
        return result[returnStderr ? 'stderr' : 'stdout'].toString();
    } catch (e) {
        throw new Error(e.stderr);
    }
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} message
 * @returns {Promise<T>}
 */
async function wrapWithLogger(fn, message, fatal = true) {
    try {
        logger.start(`${message}...`);
        return await fn();
    } catch (error) {
        const text = `${message} (failed)`;
        if (fatal) {
            logger.fail(`${text}\n${error.message}`);
            await exitAndReport(1);
        } else {
            console.error(text, error);
            throw error;
        }
    }
}