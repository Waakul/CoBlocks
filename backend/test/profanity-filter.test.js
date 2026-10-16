import assert from 'node:assert/strict';
import test from 'node:test';

import { Filter } from '../utils/profanity-filter.js';

test('profanity filtering normalizes leetspeak without empty matches', async () => {
    const result = await new Filter().checkContent('phuck');

    assert.equal(result.isBad, true);
    assert.deepEqual(result.badWordsList, ['fuck']);
    assert.equal(result.censoredContent, '****');
});
