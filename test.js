import assert from 'node:assert';
import cd from 'node:child_process';
import test, { after, describe } from 'node:test';
import { parseArgs, promisify } from 'node:util';
import tests from './tests.json' with { type: 'json' };
import { writeFile } from 'node:fs/promises';

const exec = promisify(cd.exec);

const args = parseArgs({ options: {
    update: {
        type: 'boolean',
        short: 'u',
        default: false,
    }
}}).values;

for (const [suiteName, suiteTestCases] of Object.entries(tests)) {
    describe(suiteName, () => {
        for (const testCase of suiteTestCases) {
            test(testCase.name, async () => {
                /** @type {{stdout: string, stderr: string} | cd.ExecException | undefined} */
                let result;
                try {
                    result = await exec(`node ./index.js ${testCase.args}`);
                } catch (e) {
                    result = /** @type {cd.ExecException} */(e);
                }
                
                if (args.update) {
                    // @ts-ignore
                    testCase.exitCode = result?.code;
                    // @ts-ignore
                    testCase.stdout = clean(result?.stdout);
                    // @ts-ignore
                    testCase.stderr = result?.stderr;
                    assert.ok(true);
                } else {
                    // @ts-ignore
                    assert.strictEqual(result?.code, testCase.exitCode);
                    // @ts-ignore
                    assert.strictEqual(clean(result?.stdout), testCase.stdout);
                    // @ts-ignore
                    assert.strictEqual(result?.stderr, testCase.stderr);
                }
            });
        }
    });
}

after(async () => {
    // await cleanDir();
    if (args.update) {
        await writeTestCases();
    }
});

// function cleanDir() {
//     return rm(dir, { recursive: true, force: true });
// }

function writeTestCases() {
    return writeFile('./tests.json', JSON.stringify(tests, null, 4));
}

/**
 * @param {string} str 
 */
function clean(str) {
    return str.replace(/\s+/g, ' ').trim();
}