import assert from 'node:assert';
import cd from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(cd.exec);

describe('pkgsz', () => {
    it('simple', async () => {
        const { stdout } = await exec('node index.js @tstpkgs/with-legal-single-line-comment -j');
        assert.equal(clean(stdout), clean(`{
            "metadata": {
                "name": "@tstpkgs/with-legal-single-line-comment",
                "version": "0.0.2"
            },
            "exports": [],
            "includedExports": [
                {
                    "export": ".",
                    "defaultExport": false
                }
            ],
            "results": [
                {
                "id": "nodeModulesSize",
                    "value": 1930,
                    "unit": "bytes"
                },
                {
                "id": "nodeModulesFiles",
                    "value": 5,
                    "unit": "count"
                },
                {
                "id": "sizeMinified",
                    "value": 51,
                    "unit": "bytes"
                },
                {
                    "id": "sizeMinifiedGzipped",
                    "value": 71,
                    "unit": "bytes"
                }
            ],
            "composition": [
                [
                    "@tstpkgs/with-legal-single-line-comment",
                    50
                ],
                [
                    "[EOLs]",
                    2
                ]
            ]
        }`));
    });
});

/**
 * @param {string} str 
 */
function clean(str) {
    return str.replace(/\s+/g, ' ').trim();
}