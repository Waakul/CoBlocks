import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('../../extension/injectors/bridge.js', import.meta.url), 'utf8');
const themeBridge = bridge.slice(0, bridge.indexOf('/* exported injectCoBlocksPageScript */'));

function setup() {
    let initial;
    let changed;
    const dataset = {};
    vm.runInNewContext(themeBridge, {
        document: { documentElement: { dataset } },
        chrome: { storage: {
            local: { get(_keys, callback) { initial = callback; } },
            onChanged: { addListener(callback) { changed = callback; } },
        } },
    });
    return { dataset, initial: data => initial(data), change: (data, area = 'local') => changed(data, area) };
}

test('editor theme is off by default even with a saved dark popup theme', () => {
    const page = setup();
    page.initial({ theme: 'dark' });
    assert.equal(page.dataset.coblocksTheme, undefined);
    page.change({ theme: { newValue: 'light' } });
    assert.equal(page.dataset.coblocksTheme, undefined);
});

test('opting in follows the saved theme and updates without a reload', () => {
    const page = setup();
    page.initial({ theme: 'dark', editorFollowsTheme: true });
    assert.equal(page.dataset.coblocksTheme, 'dark');
    page.change({ theme: { newValue: 'light' } });
    assert.equal(page.dataset.coblocksTheme, 'light');
    page.change({ editorFollowsTheme: { newValue: false } });
    assert.equal(page.dataset.coblocksTheme, undefined);
    page.change({ theme: { newValue: 'dark' } });
    assert.equal(page.dataset.coblocksTheme, undefined);
    page.change({ editorFollowsTheme: { newValue: true } });
    assert.equal(page.dataset.coblocksTheme, 'dark');
});

test('late initial preferences cannot overwrite a newer toggle change', () => {
    const page = setup();
    page.change({ editorFollowsTheme: { newValue: true }, theme: { newValue: 'dark' } });
    page.initial({ editorFollowsTheme: false, theme: 'light' });
    assert.equal(page.dataset.coblocksTheme, 'dark');
    page.change({ theme: { newValue: 'light' } }, 'sync');
    assert.equal(page.dataset.coblocksTheme, 'dark');
});

test('initial preference loading preserves fields not included in an early change', () => {
    const page = setup();
    page.change({ theme: { newValue: 'dark' } });
    page.initial({ theme: 'light', editorFollowsTheme: true });
    assert.equal(page.dataset.coblocksTheme, 'dark');
});
