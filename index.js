#!/usr/bin/env node
// system imports
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { constants, brotliCompress, gzip } from "node:zlib";
// 3rd party imports
import "@niceties/draftlog-appender";
import {
	blue,
	bold,
	cyan,
	gray,
	green,
	red,
	redBright,
	yellow,
} from "@niceties/ansi";
import { createLogger as createNicetiesLogger } from "@niceties/logger";
import { parseArgsPlus } from "@niceties/node-parseargs-plus";
import { camelCase } from "@niceties/node-parseargs-plus/camel-case";
import { help } from "@niceties/node-parseargs-plus/help";
import { readPackageJson } from "@niceties/node-parseargs-plus/package-info";
import { parameters } from "@niceties/node-parseargs-plus/parameters";

import prompt from "prompts";

// promisified functions
const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const smeBin = fileURLToPath(import.meta.resolve("source-map-explorer/bin/cli.js"));
const pkgbldBin = fileURLToPath(
	new URL("./index.js", import.meta.resolve("pkgbld/package.json")),
);
const pkgprnBin = fileURLToPath(
	new URL("./index.js", import.meta.resolve("pkgprn/package.json")),
);

const ansiRegex = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const resultCaptions = {
	sizeMinified: "minified",
	sizeMinifiedGzipped: "minified + gzip",
	sizeMinifiedBrotli: "minified + brotli",
	nodeModulesSize: "node_modules",
	nodeModulesFiles: "node_modules files",
};

const auditSeverities = ["info", "low", "moderate", "high", "critical"];
const auditColors = {
	info: cyan,
	low: blue,
	moderate: yellow,
	high: red,
	critical: redBright,
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

/**
 * @typedef {{ status: 'complete', provider: 'npm', summary: Record<string, number>,
 * advisoryCount: number, vulnerabilities: Record<string, any> } |
 * { status: 'error', provider: 'npm', error: string }} AuditResult
 */

// globals
const logger = createLogger();

/**
 * @type {Set.<Result>}
 */
const results = new Set();
const compositionMap = new Map();

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

try {
	validateExports(flags.export);
} catch (/** @type {any} */ error) {
	console.error(error.message);
	process.exit(1);
}

logger.log();

const dirName = await createDirs();

const packageJson = createPackageJson();

await installPackage();

const audit = flags.noAudit ? undefined : await auditPackage();

calculateNodeModulesSize();

const { exports, version: packageVersion, deps } = await resolvePackageJson();

if (flags.interactive) {
	const { selectedExports, selectedDependencies } = await wrapWithLogger(
		() => interactiveMode(deps, exports),
		"Selecting exports and dependencies",
	);
	selectedDependencies.push(packageName);
	exportsData = await getExportsData(selectedExports, selectedDependencies);
	await buildPackage(exports, exportsData, selectedDependencies);
} else {
	exportsData = await getExportsData(flags.export);

	await buildPackage(exports, exportsData);
}

try {
	await exploreSourcemaps();
} catch {
	// sourcemap exploration is optional, continue without composition data
}

await prunePackage();

await calculateDistSize();

logger.succeed(`Package: ${green(packageName)}@${blue(packageVersion)}`);

exitAndReport(audit?.status === "error" ? 1 : 0, true);

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
	let selectedExports = exports.length === 1 ? exports : ["."];

	if (exports.length > 1) {
		const { exports: exportsFromPrompt } = await prompt([
			{
				type: "multiselect",
				name: "exports",
				message: "Which subpaths do you want to reexport?",
				min: 1,
				choices: exports.map((exportName) => ({
					title: exportName,
					value: exportName,
					disabled: exportName.includes("*"),
				})),
			},
		]);

		if (!exportsFromPrompt) {
			throw new Error("Cancelled");
		}

		selectedExports = exportsFromPrompt;
	}

	validateExports(selectedExports);

	const { dependencies: selectedDependencies } = await prompt([
		{
			type: "multiselect",
			name: "dependencies",
			message: "Which dependencies do you want to include?",
			choices: deps.map((dependency) => ({
				title: dependency,
				value: dependency,
			})),
		},
	]);

	if (!selectedDependencies) {
		throw new Error("Cancelled");
	}

	logger.start(loggerText);

	return { selectedExports, selectedDependencies };
}

function printResults() {
	if (flags.json) {
		const auditOutput =
			audit?.status === "complete" && flags.audit !== "full"
				? {
					status: audit.status,
					provider: audit.provider,
					summary: audit.summary,
					advisoryCount: audit.advisoryCount,
				}
				: audit;
		const result = {
			metadata: {
				name: packageName,
				version: packageVersion,
			},
			exports,
			includedExports: exportsData.map((data) => ({
				export: data.export,
				defaultExport: data.hasDefaultExport,
			})),
			results: [...results],
			composition: [...compositionMap.entries()],
			...(auditOutput ? { audit: auditOutput } : {}),
		};
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	const options = [{ paddingRight: 4 }, { paddingRight: 4 }, {}];

	console.log();

	console.log(formatColumns([...results].map(formatResult), options));

	if (audit) {
		printAudit(audit);
	}

	if (exportsData.length) {
		console.log();
		if (exportsData.length === 1) {
			console.log(
				`${bold("Exports:")} ${exportsData[0].export} ${exportsData[0].hasDefaultExport ? gray("(default export)") : ""}`,
			);
		} else {
			console.log(bold("Exports:"));
			console.log();
			console.log(
				formatColumns(
					exportsData.map((data) => [
						data.export,
						data.hasDefaultExport
							? green("default export")
							: blue("no default export"),
					]),
					[{ paddingRight: 4 }, { paddingRight: 4 }],
				),
			);
		}
	}

	if (compositionMap.size) {
		console.log();
		console.log(bold("Composition:"));
		console.log();
		const tableData = [];
		const data = [...compositionMap.entries()];
		const firstRow = data.filter((row) => row[0] === packageName);
		const rest = data.filter((row) => row[0] !== packageName);
		const compositionMapSorted = rest.sort((a, b) => b[1] - a[1]);
		if (firstRow.length) {
			const sizes = formatSize(firstRow[0][1]);
			tableData.push([
				green(firstRow[0][0]) + gray(" (self)"),
				sizes[0],
				sizes[1],
			]);
		}
		for (const [pkgName, size] of compositionMapSorted) {
			const sizes = formatSize(size);
			tableData.push([green(pkgName), sizes[0], sizes[1]]);
		}
		console.log(formatColumns(tableData, options));
	}
}

/** @param {AuditResult} audit */
function printAudit(audit) {
	console.log();
	console.log(
		bold("Audit:") +
			(flags.audit === "full" ? "" : ` (${cyan("--audit=full")} for details)`),
	);
	if (audit.status === "error") {
		console.log(yellow(`Unavailable: ${audit.error}`));
		return;
	}
	if (audit.summary.total === 0) {
		console.log(green("No known vulnerabilities found."));
		return;
	}
	const highestSeverity =
		auditSeverities.findLast((severity) => audit.summary[severity] > 0) ?? "info";
	console.log(
		auditColors[highestSeverity](
			`${audit.summary.total} affected packages, ${audit.advisoryCount} unique advisories`,
		),
	);
	console.log(
		auditSeverities
			.map((severity) =>
				(audit.summary[severity] > 0 ? auditColors[severity] : gray)(
					`${audit.summary[severity]} ${severity}`,
				),
			)
			.join(", "),
	);
	if (flags.audit !== "full") return;
	console.log(
		formatColumns(
			Object.entries(audit.vulnerabilities).map(([name, vulnerability]) => [
				name,
				vulnerability.severity,
				vulnerability.isDirect ? "target" : "dependency",
			]),
			[{ paddingRight: 4 }, { paddingRight: 4 }, {}],
		),
	);
	const seen = new Set();
	for (const vulnerability of Object.values(audit.vulnerabilities)) {
		for (const advisory of vulnerability.via) {
			if (typeof advisory === "string" || seen.has(advisory.source)) continue;
			seen.add(advisory.source);
			console.log(`${advisory.name}: ${advisory.title}`);
			console.log(advisory.url);
		}
	}
}

/** @returns {Promise<AuditResult>} */
async function auditPackage() {
	logger.start("Auditing package... ");
	try {
		const registry = flags.auditRegistry ?? flags.registry;
		// npm returns a valid report with exit code 1 when vulnerabilities are found.
		const result = await execFileAsync(
			"npm",
			[
				"audit",
				"--json",
				"--omit=dev",
				"--audit=true",
				"--package-lock=true",
				"--ignore-scripts",
				"--fetch-retries=0",
				"--fetch-timeout=30000",
				...(registry !== undefined ? [`--registry=${registry}`] : []),
			],
			{ cwd: dirName, timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
		).then(
			({ stdout }) => ({ stdout, code: 0 }),
			(error) => {
				if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
					throw new Error("npm audit report exceeded the output limit");
				}
				if (error.killed)
					throw new Error("npm audit timed out or was terminated");
				if (typeof error.code !== "number") {
					throw new Error(
						`Could not run npm audit: ${error.code ?? error.message}`,
					);
				}
				return { stdout: error.stdout, code: error.code };
			},
		);
		let report;
		try {
			report = JSON.parse(result.stdout);
		} catch {
			throw new Error("npm audit returned an invalid JSON report");
		}
		if (report?.error) {
			throw new Error(
				`npm audit failed: ${report.error.summary || report.error.code || "registry error"}`,
			);
		}
		if (result.code !== 0 && result.code !== 1) {
			throw new Error(`npm audit failed with exit code ${result.code}`);
		}
		return parseAuditReport(report);
	} catch (/** @type {any} */ error) {
		return { status: "error", provider: "npm", error: error.message };
	}
}

/**
 * @param {any} report
 * @returns {AuditResult}
 */
function parseAuditReport(report) {
	const invalid = () =>
		new Error("npm audit returned an invalid or unsupported report");
	if (
		report?.auditReportVersion !== 2 ||
		!report.vulnerabilities ||
		typeof report.vulnerabilities !== "object" ||
		Array.isArray(report.vulnerabilities)
	)
		throw invalid();

	/** @type {Record<string, number>} */
	const summary = Object.fromEntries(
		[...auditSeverities, "total"].map((key) => [key, 0]),
	);
	const advisories = new Set();
	for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
		if (
			!vulnerability ||
			vulnerability.name !== name ||
			!auditSeverities.includes(vulnerability.severity) ||
			typeof vulnerability.isDirect !== "boolean" ||
			!Array.isArray(vulnerability.via) ||
			vulnerability.via.length === 0
		)
			throw invalid();
		summary[vulnerability.severity]++;
		summary.total++;
		for (const advisory of vulnerability.via) {
			if (typeof advisory === "string") {
				if (!Object.hasOwn(report.vulnerabilities, advisory)) throw invalid();
				continue;
			}
			if (
				!advisory ||
				!Number.isInteger(advisory.source) ||
				typeof advisory.name !== "string" ||
				typeof advisory.title !== "string" ||
				typeof advisory.url !== "string" ||
				!auditSeverities.includes(advisory.severity)
			)
				throw invalid();
			advisories.add(advisory.source);
		}
	}
	for (const key of Object.keys(summary)) {
		if (report.metadata?.vulnerabilities?.[key] !== summary[key])
			throw invalid();
	}
	return {
		status: "complete",
		provider: "npm",
		summary,
		advisoryCount: advisories.size,
		vulnerabilities: report.vulnerabilities,
	};
}

function calculateDistSize() {
	return wrapWithLogger(async () => {
		const files = await filesInDir(join(dirName, "dist"));
		const dirCompressedResults = await dirCompressedSize(
			files,
			/** @type {CompressionMethod[]} */ (
				[
					"none",
					flags.noGzip ? null : "gzip",
					flags.brotli ? "brotli" : null,
				].filter(Boolean)
			),
		);
		if (
			"none" in dirCompressedResults &&
			typeof dirCompressedResults.none === "number"
		) {
			results.add({
				id: "sizeMinified",
				value: dirCompressedResults.none,
				unit: "bytes",
			});
		}
		if (
			!flags.noGzip &&
			"gzip" in dirCompressedResults &&
			typeof dirCompressedResults.gzip === "number"
		) {
			results.add({
				id: "sizeMinifiedGzipped",
				value: dirCompressedResults.gzip,
				unit: "bytes",
			});
		}
		if (
			flags.brotli &&
			"brotli" in dirCompressedResults &&
			typeof dirCompressedResults.brotli === "number"
		) {
			results.add({
				id: "sizeMinifiedBrotli",
				value: dirCompressedResults.brotli,
				unit: "bytes",
			});
		}
	}, "Calculating sizes / finalizing");
}

async function exploreSourcemaps() {
	return wrapWithLogger(async () => {
		const result = await execEx(
			process.execPath,
			[smeBin, "dist/**/*.mjs", "--json"],
			{ cwd: dirName },
		);
		const json = JSON.parse(result);
		if ("results" in json && Array.isArray(json.results)) {
			for (const results of json.results) {
				for (const [key, result] of Object.entries(results.files)) {
					if (result.size === 0) {
						continue;
					}
					const nodeModulesSegment = "/node_modules/";
					let pkgName = key;
					if (key.startsWith(`..${nodeModulesSegment}`)) {
						const mapped = key.substring(
							key.lastIndexOf(nodeModulesSegment) + nodeModulesSegment.length,
						);
						const parts = mapped.split("/");
						pkgName = parts[0];
						if (parts[0].startsWith("@") && parts.length > 1) {
							pkgName += `/${parts[1]}`;
						}
					} else if (key === "[sourceMappingURL]") {
						continue;
					}
					if (!compositionMap.has(pkgName)) {
						compositionMap.set(pkgName, result.size);
					} else {
						compositionMap.set(
							pkgName,
							compositionMap.get(pkgName) + result.size,
						);
					}
				}
			}
		}
	}, "Exploring sourcemaps", false);
}

async function prunePackage() {
	return wrapWithLogger(async () => {
		await execEx(process.execPath, [pkgprnBin, "--remove-sourcemaps"], {
			cwd: dirName,
		});
	}, "Pruning package");
}

/**
 * @param {string[]} pkgExports
 * @param {{ export: string, import: string, hasDefaultExport: boolean }[]} exportsData
 * @param {string[] | undefined} dependencies
 */
async function buildPackage(pkgExports, exportsData, dependencies = undefined) {
	return wrapWithLogger(async () => {
		if (pkgExports.length) {
			logger.log(`Found subpath exports: ${green(pkgExports.join(", "))}`);
			logger.log();
			logger.log(
				yellow(
					`Note: Building ${exportsData.length === 1 && exportsData[0].import === packageName ? "root package export" : `subpath exports: ${exportsData.map((data) => green(data.export)).join(", ")}`}`,
				),
			);
			logger.log();
		}

		const rootIndex = Math.max(0, exportsData.findIndex((data) => data.export === "."));
		const entries = getCode(exportsData).map((data, index) => ({
			code: data.code,
			name: index === rootIndex ? "." : `./${index}`,
			file: index === rootIndex ? "index.js" : `${index}.mjs`,
		}));

		await Promise.all(
			entries.map((entry) => writeFile(join(dirName, "src", entry.file), entry.code)),
		);

		packageJson.exports = Object.fromEntries(
			entries.map((entry) => [entry.name, `./src/${entry.file}`]),
		);

		packageJson.main = undefined;

		await writeFile(
			join(dirName, "package.json"),
			JSON.stringify(packageJson, null, 2),
		);

		await execBuild([
			"--sourcemaps=es",
			"--no-ts-config",
			"--no-update-package-json",
			"--formats=es",
			"--compress=es",
			"--remove-legal-comments",
			includeExternalsFlag(dependencies),
		]);
	}, "Building package");
}

/** @param {string[] | undefined} dependencies */
function includeExternalsFlag(dependencies) {
	return `--include-externals=${dependencies ? dependencies.join(",") : ""}`;
}

/**
 * @param {{ export: string, import: string, hasDefaultExport: boolean }[]} exportsData
 */
function getCode(exportsData) {
	return exportsData.map((exportData) => {
		const {
			export: exportName,
			import: importName,
			hasDefaultExport,
		} = exportData;
		const result = [];
		if (hasDefaultExport) {
			result.push(`export { default } from '${importName}';`);
		}
		result.push(`export * from '${importName}';`);
		return { exportName, code: result.join("\n") };
	});
}

/**
 * @param {string[]} exports
 * @param {string[]} [dependencies]
 * @returns {Promise<{ export: string, import: string, hasDefaultExport: boolean }[]>}
 */
async function getExportsData(exports, dependencies) {
	return wrapWithLogger(async () => {
		const packageExports = exports
			.map((exportName) =>
				exportName.startsWith("./")
					? exportName.substring(2)
					: exportName === "."
						? exportName
						: undefined,
			)
			.filter(Boolean)
			.map((exportName) => ({
				import: `${packageName}${exportName === "." ? "" : `/${exportName}`}`,
				export: /** @type {string} */ (exportName),
			}));

		const data = [];

		for (const packageExport of packageExports) {
			data.push({
				...packageExport,
				hasDefaultExport: await hasDefaultExport(packageExport.import, dependencies),
			});
		}

		return data;
	}, "Resolving exports");
}

/**
 * @param {string} importName
 * @param {string[]} [dependencies]
 * @returns {Promise<boolean>}
 */
async function hasDefaultExport(importName, dependencies) {
	return wrapWithLogger(async () => {
		try {
			await writeFile(
				join(dirName, "src", "index.js"),
				`import $index from '${importName}';`,
			);

			const errors = await execBuild(
				[
					"--no-ts-config",
					"--no-update-package-json",
					"--formats=es",
					includeExternalsFlag(dependencies),
				],
				false,
			);

			return !errors.includes('"default" is not exported by');
		} catch (e) {
			if (e instanceof Error && e.message.includes('"default" is not exported by')) {
				return false;
			}
			throw e;
		}
	}, "Checking for default export");
}

/**
 * @returns {Promise<{ exports: string[], version: string, deps: string[] }>}
 */
async function resolvePackageJson() {
	try {
		return await wrapWithLogger(
			async () => {
				const pkg = JSON.parse(
					await readFile(join(dirName, "node_modules", packageName, "package.json"), "utf8"),
				);
				const exports = [];
				if (
					pkg &&
					"exports" in pkg &&
					typeof pkg.exports === "object" &&
					pkg.exports !== null
				) {
					exports.push(
						...Object.keys(pkg.exports).filter((exp) => exp.startsWith(".")),
					);
				}
				const version = String(pkg?.version);

				const deps = await resolveDependencies();
				return { exports, version, deps };
			},
			"Resolving package.json",
			false,
		);
	} catch {
		return { exports: [], version: "<unknown>", deps: [] };
	}
}

/** @returns {Promise<string[]>} */
async function resolveDependencies() {
	// npm list still returns dependency JSON when unmet peers cause a nonzero exit.
	const { stdout } = await execFileAsync("npm", ["list", "--all", "--json"], {
		cwd: dirName,
	}).catch((error) => error);
	try {
		return collectDependencyKeys(JSON.parse(stdout));
	} catch {
		return [];
	}
}

/**
 * Recursively collects all keys from any "dependencies" objects in the tree.
 * Replaces jsonata("[$keys(**.dependencies)]").evaluate(obj)
 * @param {Record<string, any>} obj
 * @returns {string[]}
 */
function collectDependencyKeys(obj) {
	/** @type {Set<string>} */
	const keys = new Set();
	(function walk(node) {
		if (node && typeof node === "object" && !Array.isArray(node)) {
			if (node.dependencies && typeof node.dependencies === "object") {
				for (const key of Object.keys(node.dependencies)) {
					keys.add(key);
				}
			}
			for (const value of Object.values(node)) {
				walk(value);
			}
		}
	})(obj);
	return [...keys];
}

function calculateNodeModulesSize() {
	deferred.push(
		(async () => {
			const files = await filesInDir(join(dirName, "node_modules"));
			const size = await dirSize(files);
			results.add({ id: "nodeModulesSize", value: size, unit: "bytes" });
			results.add({
				id: "nodeModulesFiles",
				value: files.length,
				unit: "count",
			});
		})(),
	);
}

/**
 * @returns {Record<string, any>}
 */
function createPackageJson() {
	return {
		main: "dist/index.js",
		dependencies: {
			[packageName]: version ?? "*",
		},
	};
}

function installPackage() {
	return wrapWithLogger(async () => {
		await writeFile(
			join(dirName, "package.json"),
			JSON.stringify(packageJson, null, 2),
		);

		await execEx(
			"npm",
			[
				"i",
				"--no-audit",
				"--no-fund",
				"--no-update-notifier",
				"--no-progress",
				...(flags.noAudit ? [] : ["--package-lock=true"]),
				...(flags.enableScripts ? [] : ["--ignore-scripts"]),
				...(flags.registry ? [`--registry=${flags.registry}`] : []),
			],
			{ cwd: dirName },
		);
	}, "Installing package");
}

function createDirs() {
	return wrapWithLogger(async () => {
		const dirName = await mkdtemp(join(tmpdir(), "pkgsz-"));

		if (!flags.noClean) {
			cleanup.push(() => rm(dirName, { recursive: true, force: true }));
		} else {
			cleanup.push(() => {
				logger.log("Cleanup disabled, directory is left at: ", dirName);
			});
		}

		await mkdir(join(dirName, "src"), { recursive: true });

		return dirName;
	}, "Creating temporary directories");
}

async function getCliArgs() {
	const pkg = await readPackageJson(import.meta.url);

	const argv = parseArgsPlus(
		{
			name: "pkgsz",
			version: pkg.version,
			description: pkg.description,
			parameters: ["<package name>", "[version]"],
			options: {
				registry: {
					type: "string",
					short: "r",
					description:
						"The npm registry to use when installing and auditing the package",
				},
				auditRegistry: {
					type: "string",
					description: "Override the npm registry for auditing only",
				},
				audit: {
					type: "string",
					description: "Audit output: summary or full (default: summary)",
					default: "summary",
				},
				noAudit: {
					type: "boolean",
					description: "Do not audit the package for known vulnerabilities",
					default: false,
				},
				export: {
					type: "string",
					short: "e",
					multiple: true,
					description: "Reexport given subpath from the package",
					default: ["."],
				},
				noGzip: {
					type: "boolean",
					short: "g",
					description: "Do not calculate gzipped size",
					default: false,
				},
				brotli: {
					type: "boolean",
					short: "b",
					description: "Calculate brotli compressed size",
					default: false,
				},
				noClean: {
					type: "boolean",
					short: "c",
					description: "Do not clean the temporary directory",
					default: false,
				},
				enableScripts: {
					type: "boolean",
					short: "s",
					description: "Enable scripts",
					default: false,
				},
				interactive: {
					type: "boolean",
					short: "i",
					description: "Interactive mode",
					default: false,
				},
				json: {
					type: "boolean",
					short: "j",
					description: "Output results as JSON",
					default: false,
				},
			},
			helpSections: {
				examples: {
					title: "Examples",
					text: ["npx pkgsz lodash", "npx pkgsz lodash 4.17.21", "npx pkgsz lodash@4.17.21"],
				},
			},
		},
		[help, parameters, camelCase],
	);

	if (!["summary", "full"].includes(argv.values.audit)) {
		logger.error("--audit must be either summary or full");
		process.exit(1);
	}

	if (argv.values.json && argv.values.interactive) {
		logger.error("Cannot use --json and --interactive flags together");
		process.exit(1);
	}

	let pkgName = argv.parameters.packageName;
	let pkgVersion = argv.parameters.version;

	// Support pkgName@version syntax (e.g., lodash@4.17.21 or @scope/name@1.0.0)
	if (!pkgVersion && pkgName) {
		const atIndex = pkgName.indexOf('@', pkgName.startsWith('@') ? 1 : 0);
		if (atIndex > 0) {
			pkgVersion = pkgName.slice(atIndex + 1);
			pkgName = pkgName.slice(0, atIndex);
		}
	}

	return {
		version: pkgVersion,
		packageName: pkgName,
		flags: argv.values,
	};
}

/** @param {string[]} exports */
function validateExports(exports) {
	/**@type {string[]} */
	const exportsErrors = [];

	if (exports.length === 0) {
		exportsErrors.push("Select at least one export");
	}

	for (const exportName of exports) {
		if (exportName.includes("*")) {
			exportsErrors.push(`Wildcards are not supported: ${exportName}`);
		}
		if (!exportName.startsWith(".")) {
			exportsErrors.push(`Exports must start with a dot: ${exportName}`);
		}
	}

	if (exportsErrors.length) {
		throw new Error(exportsErrors.join("\n"));
	}
}

/**
 * @param {number} code
 * @param {boolean} [report]
 * @returns {Promise<never>}
 */
async function exitAndReport(code, report = code === 0) {
	try {
		await Promise.all(deferred);
		if (report) {
			printResults();
		}
	} finally {
		await Promise.all(cleanup.map((fn) => fn()));
	}
	await Promise.all(
		[process.stdout, process.stderr].map(
			(stream) => new Promise((resolve) => stream.write("", () => resolve(undefined))),
		),
	);
	process.exit(code);
}

// low level functions

/**
 * @param {string[]} paths
 */
async function dirSize(paths) {
	return (
		await Promise.all(
			paths.map(async (path) => {
				const { size } = await stat(path);

				return size;
			}),
		)
	).reduce((i, size) => i + size, 0);
}

/**
 * @param {string[]} paths
 * @param {CompressionMethod[]} methods
 */
async function dirCompressedSize(paths, methods) {
	const methodsSet = new Set(methods);
	if (methodsSet.has("none") && methodsSet.size === 1) {
		return {
			none: await dirSize(paths),
		};
	}
	/** @type {Partial<Record<CompressionMethod, number>>} */
	const results = {};
	for (const method of methodsSet) {
		results[method] = 0;
	}
	await Promise.all(
		paths.map(async (path) => {
			const fileContent = await readFile(path);
			if (methodsSet.has("none")) {
				/** @type {number} */
				(results.none) += fileContent.length;
			}
			if (methodsSet.has("gzip")) {
				const { length } = await gzipAsync(fileContent, {
					level: constants.Z_BEST_COMPRESSION,
				});
				/** @type {number} */
				(results.gzip) += length;
			}
			if (methodsSet.has("brotli")) {
				const { length } = await brotliAsync(fileContent, {
					params: {
						[constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
					},
				});
				/** @type {number} */
				(results.brotli) += length;
			}
		}),
	);
	return results;
}

/**
 * @param {string} dir
 */
async function filesInDir(dir) {
	const dirEntries = await readdir(dir, {
		recursive: true,
		withFileTypes: true,
	});
	return dirEntries
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

/**
 * @param {string} str
 */
function stripAnsi(str) {
	return str.replace(ansiRegex, "");
}

/**
 * @param {string[][]} rows
 * @param {{ paddingRight?: number }[]} columnOptions
 */
function formatColumns(rows, columnOptions) {
	if (rows.length === 0) return "";
	const colCount = Math.max(...rows.map((row) => row.length));
	const colWidths = Array.from({ length: colCount }, (_, colIndex) => {
		let max = 0;
		for (const row of rows) {
			if (colIndex < row.length) {
				const visible = stripAnsi(row[colIndex]).length;
				if (visible > max) max = visible;
			}
		}
		return max;
	});
	return rows
		.map((row) =>
			row
				.map((cell, colIndex) => {
					const padding = columnOptions[colIndex]?.paddingRight ?? 0;
					const visible = stripAnsi(cell).length;
					const targetWidth = colWidths[colIndex] + padding;
					return cell + " ".repeat(Math.max(0, targetWidth - visible));
				})
				.join("")
				.trimEnd(),
		)
		.join("\n");
}

/**
 * @param {Result} result
 */
function formatResult(result) {
	const caption = resultCaptions[result.id];
	if (result.unit === "bytes") {
		return [caption, ...formatSize(result.value)];
	}
	return [caption, String(result.value), ""];
}

/**
 * @param {number} size
 */
function formatSize(size) {
	if (size < 1024) {
		return [`${cyan(size)} bytes`, ""];
	}

	if (size < 1024 * 1024) {
		return [`${cyan((size / 1024).toFixed(2))} KiB`, `(${size} bytes)`];
	}

	return [`${cyan((size / 1024 / 1024).toFixed(2))} MiB`, `(${size} bytes)`];
}

/**
 * @param {string[]} args
 * @param {boolean} [debugPrint]
 */
async function execBuild(args, debugPrint = true) {
	const diagnostics = await execEx(
		process.execPath,
		[pkgbldBin, ...args],
		{ cwd: dirName },
		true,
		debugPrint,
	);
	if (diagnostics.includes("could not be resolved")) {
		throw new Error(diagnostics.trim());
	}
	return diagnostics;
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptions} options
 * @param {boolean} [returnStderr]
 * @param {boolean} [debugPrint]
 */
async function execEx(
	file,
	args,
	options,
	returnStderr = false,
	debugPrint = true,
) {
	try {
		const result = await execFileAsync(file, args, options);
		if (debugPrint && result.stderr) {
			logger.log(result.stderr);
		}
		return result[returnStderr ? "stderr" : "stdout"].toString();
	} catch (/** @type {any} */ e) {
		throw new Error(e.stderr || e.stdout);
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
	/** @type {ReturnType<typeof createNicetiesLogger> | undefined} */
	let nicetiesLogger;
	let quiet = false;
	let currentText = "";
	let started = false;
	return {
		/**
		 * @param {string} message
		 */
		start(message) {
			currentText = message;
			if (quiet) return;
			if (!started) {
				nicetiesLogger = createNicetiesLogger();
				nicetiesLogger.start(message);
				started = true;
			} else {
				nicetiesLogger?.update(message);
			}
		},
		/**
		 * @param {string} message
		 */
		fail(message) {
			currentText = message;
			if (quiet || !nicetiesLogger) {
				console.error(message);
				return;
			}
			nicetiesLogger?.finish(message, 3);
			started = false;
			nicetiesLogger = undefined;
		},
		/**
		 * @param {string} message
		 */
		succeed(message) {
			currentText = message;
			if (quiet) return;
			nicetiesLogger?.finish(message);
			started = false;
			nicetiesLogger = undefined;
		},

		stop() {
			if (started) {
				nicetiesLogger?.finish("");
				started = false;
				nicetiesLogger = undefined;
			}
		},

		get text() {
			return currentText;
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
			if (started) {
				nicetiesLogger?.finish("");
				started = false;
			}
			nicetiesLogger = undefined;
		},
	};
}
