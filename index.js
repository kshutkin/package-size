#!/usr/bin/env node
// system imports
import { exec } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
// 3rd party imports
import ora from 'ora';
import { cli } from 'cleye';
import kleur from 'kleur';
import terminalColumns from 'terminal-columns';
import { readPackageUp } from 'read-package-up';
import prompt from 'prompts';
import jsonata from 'jsonata';

// promisified functions
const execAsync = promisify(exec);
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

const resultCaptions = {
    'sizeMinified': 'minified',
    'sizeMinifiedGzipped': 'minified + gzip',
    'sizeMinifiedBrotli': 'minified + brotli',
    'nodeModulesSize': 'node_modules',
    'nodeModulesFiles': 'node_modules files',
};

// types
/** @typedef {'bytes' | 'count'} Unit */
/**
 * @typedef {Object} Result
 * @property {keyof resultCaptions} id
 * @property {number} value
 * @property {Unit} unit
 */

/**
 * @typedef {('brotli' | 'gzip' | 'none')} CompressionMethod
 */

// globals
const __dirname = dirname(fileURLToPath(import.meta.url));

const logger = createLogger();

/**
 * @type {Set.<Result>}
 */
const results = new Set;
const compositionMap = new Map;

/**
 * @type {{ export: string, import: string, hasDefaultExport: boolean }[]}
 */
let exportsData = [];

/**
 * @type {(() => Promise<void> | void)[]}
 */
const cleanup = [];
/**
 * @type {Promise<void>[]}
 */
const deferred = [];

const { packageName, version, flags } = await getCliArgs();

if (flags.json) {
    logger.makeQuiet();
}

validateExports(flags.export);

logger.log();

const dirName = await createDirs();

const packageJson = createPackageJson();

await installPackage();

calculateNodeModulesSize();

const { exports, version: packageVersion, deps } = await resolvePackageJson();

if (flags.interactive) {
    const { selectedExports, selectedDependencies } = await interactiveMode(deps, exports);
    selectedDependencies.push(packageName);
    exportsData = await getExportsData(selectedExports);
    await buildPackage(exports, exportsData, selectedDependencies);
} else {
    exportsData = await getExportsData(flags.export);

    await buildPackage(exports, exportsData);
}

await exploreSourcemaps();

await prunePackage();

await calculateDistSize();

logger.succeed(`Package: ${kleur.green(packageName)}@${kleur.blue(packageVersion)}`);

exitAndReport(0);

// high level functions

/**
 * @param {string[]} deps
 * @param {string[]} exports
 * @returns {Promise<{ selectedExports: string[], selectedDependencies: string[] }>}
 */
async function interactiveMode(deps, exports) {
    const loggerText = logger.text;
    logger.stop();

    /** @type {string[]} */
    let selectedExports = ['.'];

    if (exports.length > 1) {
        const { exports: exportsFromPrompt } = await prompt([
            {
                type: 'multiselect',
                name: 'exports',
                message: 'Which subpaths do you want to reexport?',
                choices: exports.map(exportName => ({ title: exportName, value: exportName, disabled: exportName.includes('*') }))
            }
        ]);

        if (!exportsFromPrompt) {
            throw new Error('Cancelled');
        }

        selectedExports = exportsFromPrompt;
    }

    const { dependencies: selectedDependencies } = await prompt([
        {
            type: 'multiselect',
            name: 'dependencies',
            message: 'Which dependencies do you want to include?',
            choices: deps.map(dependency => ({ title: dependency, value: dependency }))
        }
    ]);

    if (!selectedDependencies) {
        throw new Error('Cancelled');
    }

    logger.start(loggerText);

    return { selectedExports, selectedDependencies };
}

function printResults() {

    if (flags.json) {
        const result = {
            metadata: {
                name: packageName,
                version: packageVersion,
            },
            exports,
            includedExports: exportsData.map(data => ({
                export: data.export,
                defaultExport: data.hasDefaultExport
            })),
            results: [...results],
            composition: [...compositionMap.entries()]
        };
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    const options = [
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
    ];

    console.log();

    // @ts-ignore
    console.log(terminalColumns([...results].map(formatResult), options));

    if (exportsData.length) {
        console.log();
        if (exportsData.length === 1) {
            console.log(`Exports:${(` ${exportsData[0].export} ${exportsData[0].hasDefaultExport ? kleur.grey('(default export)') : ''}`)}`);
        } else {
            console.log(kleur.underline('Exports:'));
            console.log();
            // @ts-ignore
            console.log(terminalColumns(exportsData.map(data => [data.export, data.hasDefaultExport ? kleur.green('default export') : kleur.blue('no default export')]), [{ width: 'content-width', paddingRight: 4 }, { width: 'content-width', paddingRight: 4 }]));
        }
    }

    if (compositionMap.size) {
        console.log();
        console.log(kleur.underline('Composition:'));
        console.log();
        const tableData = [];
        const data = [...compositionMap.entries()];
        const firstRow = data.filter(row => row[0] === packageName);
        const rest = data.filter(row => row[0] !== packageName);
        const compositionMapSorted = rest.sort((a, b) => b[1] - a[1]);
        if (firstRow.length) {
            const sizes = formatSize(firstRow[0][1]);
            tableData.push([kleur.green(firstRow[0][0]) + kleur.gray(' (self)'), sizes[0], sizes[1]]);
        }
        for (const [pkgName, size] of compositionMapSorted) {
            const sizes = formatSize(size);
            tableData.push([kleur.green(pkgName), sizes[0], sizes[1]]);
        }
        // @ts-ignore
        console.log(terminalColumns(tableData, options));
    }
}

function calculateDistSize() {
    return wrapWithLogger(async () => {
        const files = await filesInDir(join(dirName, 'dist'));
        const dirCompressedResults = await dirCompressedSize(files, /** @type {CompressionMethod[]} */(['none', flags.noGzip ? null : 'gzip', flags.brotli ? 'brotli' : null].filter(Boolean)));
        if ('none' in dirCompressedResults && typeof dirCompressedResults.none === 'number') {
            results.add({ id: 'sizeMinified', value: dirCompressedResults.none, unit: 'bytes' });
        }
        if (!flags.noGzip && 'gzip' in dirCompressedResults && typeof dirCompressedResults.gzip === 'number') {
            results.add({ id: 'sizeMinifiedGzipped', value: dirCompressedResults.gzip, unit: 'bytes' });
        }
        if (flags.brotli && 'brotli' in dirCompressedResults && typeof dirCompressedResults.brotli === 'number') {
            results.add({ id: 'sizeMinifiedBrotli', value: dirCompressedResults.brotli, unit: 'bytes' });
        }
    }, 'Calculating sizes / finalizing');
}

async function exploreSourcemaps() {
    return wrapWithLogger(async () => {
        const result = await execEx('npx source-map-explorer dist/**/*.mjs --json', { cwd: dirName });
        const json = JSON.parse(result);
        if ('results' in json && Array.isArray(json.results)) {
            for (const results of json.results) {
                for (const [key, result] of Object.entries(results.files)) {
                    if (result.size === 0) {
                        continue;
                    }
                    const nodeModulesPrefix = '../node_modules/';
                    let pkgName = key;
                    if (key.startsWith(nodeModulesPrefix)) {
                        const mapped = key.substring(nodeModulesPrefix.length);
                        const parts = mapped.split('/');
                        pkgName = parts[0];
                        if (parts[0].startsWith('@') && parts.length > 1) {
                            pkgName += `/${parts[1]}`;
                        }                    
                    } else if (key === '[sourceMappingURL]') {
                        continue;
                    }
                    if (!compositionMap.has(pkgName)) {
                        compositionMap.set(pkgName, result.size);
                    } else {
                        compositionMap.set(pkgName, compositionMap.get(pkgName) + result.size);
                    }
                }
            }
        }
    }, 'Exploring sourcemaps');
}

async function prunePackage() {
    return wrapWithLogger(async () => {
        await execEx('npx pkgbld prune --removeSourcemaps', { cwd: dirName });
    }, 'Pruning package');
}

/**
 * @param {string[]} pkgExports
 * @param {{ export: string, import: string, hasDefaultExport: boolean }[]} exportsData
 * @param {string[] | undefined} dependencies
 */
async function buildPackage(pkgExports, exportsData, dependencies = undefined) {
    return wrapWithLogger(async () => {
        if (pkgExports.length) {
            logger.log(`Found subpath exports: ${kleur.green(pkgExports.join(', '))}`);
            logger.log();
            logger.log(kleur.yellow(`Note: Building ${(exportsData.length === 1 && exportsData[0].import === packageName) ? 'root package export' : `subpath exports: ${exportsData.map(data => kleur.green(data.export)).join(', ')}`}`));
            logger.log();
        }

        await Promise.all(getCode(exportsData)
            .map((data, index) => writeFile(join(dirName, 'src', data.exportName === '.' ? 'index.js' : `${String(index)}.mjs`), data.code)));
        
        packageJson.exports = exportsData.map(data => data.export).reduce((acc, exportName, currentIndex) => {
            acc[`./${exportName === '.' ? '' : String(currentIndex)}`] = `./src/${exportName === '.' ? 'index.js' : `${String(currentIndex)}.mjs`}`;
            return acc;
        }, /** @type {Record<string, string>} */({}));

        packageJson.main = undefined;

        await writeFile(join(dirName, 'package.json'), JSON.stringify(packageJson, null, 2));

        const command = getCliString();

        await execEx(command, { cwd: dirName }, true);
    }, 'Building package');

    function getCliString() {
        return `npx pkgbld --sourcemaps=es --no-ts-config --no-update-package-json --no-clean --formats=es --compress=es --remove-legal-comments --includeExternals${dependencies ? `=${dependencies.join(',')}` : ''}`;
    }
}

/**
 * @param {{ export: string, import: string, hasDefaultExport: boolean }[]} exportsData
 */
function getCode(exportsData) {
    return exportsData.map(exportData => {
        const { export: exportName, import: importName, hasDefaultExport } = exportData;
        const result = [];
        if (hasDefaultExport) {
            result.push(`export { default } from '${importName}';`);
        }
        result.push(`export * from '${importName}';`);
        return { exportName, code: result.join('\n') };
    });
}

/**
 * @param {string[]} exports
 * @returns {Promise<{ export: string, import: string, hasDefaultExport: boolean }[]>}
 */
async function getExportsData(exports) {
    return wrapWithLogger(async () => {
        const packageExports = exports
            .map(exportName => exportName.startsWith('./') ? exportName.substring(2) : (exportName === '.' ? exportName : undefined))
            .filter(Boolean)
            .map(exportName => ({ import: `${packageName}${exportName === '.' ? '' : `/${exportName}`}`, export: /** @type {string} */(exportName) }));

        const data = [];

        for (const packageExport of packageExports) {
            data.push({ ...packageExport, hasDefaultExport: await hasDefaultExport(packageExport.import) });
        }

        return data;

    }, 'Resolving exports');
}

/**
 * @param {string} importName
 * @returns {Promise<boolean>}
 */
async function hasDefaultExport(importName) {
    return wrapWithLogger(async () => {
        try {
            await writeFile(join(dirName, 'src', 'index.js'), `import $index from '${importName}';`);

            const errors = await execEx('npx pkgbld --no-ts-config --no-update-package-json --formats=es --includeExternals', { cwd: dirName }, true, false);

            return !errors.includes('"default" is not exported by');
        } catch (e) {
            logger.log(e);
            return false;
        }        
    }, 'Checking for default export');
}

/**
 * @returns {Promise<{ exports: string[], version: string, deps: string[] }>}
 */
async function resolvePackageJson() {
    try {
        return await wrapWithLogger(async () => {
            const url = `console.log(import.meta.resolve(\\"${packageName}\\"));`;
            const fileUrl = await execEx(`node --input-type=module -e "${url}"`, { cwd: dirName });
            const path = fileURLToPath(fileUrl);
            const packageUp = await readPackageUp({ cwd: path });
            const pkg = packageUp?.packageJson;
            if (!packageUp?.path.replaceAll('\\', '/').includes(packageName)) {
                throw new Error(`Cannot find package.json for ${packageName}`);
            }
            const exports = [];
            if (pkg && 'exports' in pkg && typeof pkg.exports === 'object' && pkg.exports !== null) {
                exports.push(...Object.keys(pkg.exports).filter(exp => exp.startsWith('.')));
            }
            const version = String(pkg?.version);

            const dependenciesJson = await execEx('npm list --all --json', { cwd: dirName });
            const dependenciesFullParsed = JSON.parse(dependenciesJson);
            /** @type {string[]} */
            const deps = await jsonata('[$keys(**.dependencies)]').evaluate(dependenciesFullParsed);
            return { exports, version, deps };
        }, 'Resolving package.json', false);
    } catch (e) {
        return { exports: [], version: '<unknown>', deps: [] };
    }
}

function calculateNodeModulesSize() {
    deferred.push((async () => {
        const files = await filesInDir(join(dirName, 'node_modules'));
        const size = await dirSize(files);
        results.add({ id: 'nodeModulesSize', value: size, unit: 'bytes' });
        results.add({ id: 'nodeModulesFiles', value: files.length, unit: 'count' });
    })());
}

/**
 * @returns {Record<string, any>}
 */
function createPackageJson() {
    return {
        main: 'dist/index.js',
        dependencies: {
            [packageName]: version ?? '*'
        }
    };
}

function installPackage() {
    return wrapWithLogger(async () => {
        await writeFile(join(dirName, 'package.json'), JSON.stringify(packageJson, null, 2));

        await execEx(`npm i --no-audit --no-fund --no-update-notifier --no-progress ${flags.enableScripts ? '' : '--ignore-scripts'} ${flags.registry ? (`--registry=${flags.registry}`) : ''}`, { cwd: dirName });
    }, 'Installing package');
}

function createDirs() {
    return wrapWithLogger(async () => {
        const dirName = await mkdtemp(join(tmpdir(), 'pkgsz-'));

        if (!flags.noClean) {
            cleanup.push(() => rm(dirName, { recursive: true, force: true }));
        } else {
            cleanup.push(() => { logger.log('Cleanup disabled, directory is left at: ', dirName); });
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
            },
            json: {
                type: Boolean,
                alias: 'j',
                description: 'Output results as JSON',
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

    if (argv.flags.json && argv.flags.interactive) {
        logger.error('Cannot use --json and --interactive flags together');
        // exiting here because of problems with the logger (ora) already initialized
        process.exit(1);
    }

    return {
        version: argv._.version,
        packageName: argv._.packageName,
        flags: argv.flags
    };
}

/** @param {string[]} exports */
function validateExports(exports) {
    /**@type {string[]} */
    const exportsErrors = [];

    for (const exportName of exports) {
        if (exportName.includes('*')) {
            exportsErrors.push(`Wildcards are not supported: ${exportName}`);
        }
        if (!exportName.startsWith('.')) {
            exportsErrors.push(`Exports must start with a dot: ${exportName}`);
        }
    }

    if (exportsErrors.length) {
        console.error(exportsErrors.join('\n'));
        process.exit(1);
    }
}

/**
 * @returns {Promise<string>}
 */
async function getMyVersion() {
    const pkg = await readPackage(resolve(__dirname));

    return (pkg && 'version' in pkg && typeof pkg.version === 'string') ? pkg.version : '<unknown>';
}

/**
 * @param {number} code
 * @returns {Promise<never>}
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
            /** @type {number} */
            (results.none) += fileContent.length;
        }
        if (methodsSet.has('gzip')) {
            const { length } = await gzipAsync(fileContent, { level: constants.Z_BEST_COMPRESSION });
            /** @type {number} */
            (results.gzip) += length;
        }
        if (methodsSet.has('brotli')) {
            const { length } = await brotliAsync(fileContent, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } });
            /** @type {number} */
            (results.brotli) += length;
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
 * @param {Result} result
 */
function formatResult(result) {
    const caption = resultCaptions[result.id];
    if (result.unit === 'bytes') {
        return [caption, ...formatSize(result.value)];
    }
    return [caption, String(result.value), ''];
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
 * @param {boolean} [returnStderr]
 * @param {boolean} [debugPrint]
 */
async function execEx(command, options, returnStderr = false, debugPrint = true) {
    try {
        const result = await execAsync(command, options);
        if (debugPrint && result.stderr) {
            logger.log(result.stderr);
        }
        return result[returnStderr ? 'stderr' : 'stdout'].toString();
    } catch (/** @type {any} */ e) {
        throw new Error(e.stderr);
    }
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} message
 * @param {boolean} [fatal]
 * @returns {Promise<T>}
 */
async function wrapWithLogger(fn, message, fatal = true) {
    try {
        logger.start(`${message}... `);
        return await fn();
    } catch (/** @type {any} */ error) {
        const text = `${message} (failed)`;
        if (fatal) {
            logger.fail(`${text}\n${error.message}`);
            return await exitAndReport(1);
        }
        logger.error(text, error);
        throw error;
    }
}

function createLogger() {
    /** @type {import('ora').Ora | undefined} */
    let logger = ora();
    let quiet = false;
    return {
        /**
         * @param {string} message
         */
        start(message) {
            logger?.start(message);
        },
        /**
         * @param {string} message
         */
        fail(message) {
            logger?.fail(message);
        },
        /**
         * @param {string} message
         */
        succeed(message) {
            logger?.succeed(message);
        },

        stop() {
            logger?.stop();
        },

        get text() {
            return logger?.text ?? '';
        },

        /**
         * @param {...unknown} message
         */
        log(...message) {
            if (!quiet) {
                console.log(...message);
            }
        },

        /**
         * @param {...unknown} message
         */
        warn(...message) {
            if (!quiet) {
                console.warn(...message);
            }
        },

        /**
         * @param {...unknown} message
         */
        error(...message) {
            if (!quiet) {
                console.error(...message);
            }
        },

        makeQuiet() {
            quiet = true;
            logger?.stop();
            logger = undefined;
        }
    };
}