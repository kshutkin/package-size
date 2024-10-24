import assert from 'node:assert';
import cd from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(cd.exec);

describe('pkgsz', () => {
    it('simple', async () => {
        const { stdout } = await exec('node index.js @tstpkgs/with-legal-single-line-comment');
        assert.equal(stdout, '');
    });
});