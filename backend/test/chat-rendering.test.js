import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
    children = [];
    style = {};
    append(...children) { this.children.push(...children); }
    set innerHTML(_value) { throw new Error('Chat must not parse message text as HTML'); }
}

const source = readFileSync(new URL('../../extension/scripts/editor.js', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('const chatEmojis ='), source.indexOf('async function addMessage'));
const context = vm.createContext({
    logoUrl: 'moz-extension://test/logo.png',
    document: {
        createElement(tag) { return Object.assign(new Element(), { tag }); },
        createTextNode(text) { return { text }; },
    },
});
vm.runInContext(renderer, context);

function render(text, linkify = false) {
    const element = new Element();
    context.renderChatMessage(element, text, linkify);
    return element.children;
}

test('chat treats HTML and unrecognized emoji codes as literal text', () => {
    const message = '<img src=x onerror=alert(1)> :unknown:';
    assert.equal(render(message).map(node => node.text || '').join(''), message);
});

test('chat creates only HTTP links with safe properties', () => {
    const children = render('See https://example.com/?q="test" javascript:alert(1)', true);
    const links = children.filter(node => node.tag === 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://example.com/?q="test"');
    assert.equal(links[0].textContent, links[0].href);
    assert.equal(links[0].rel, 'noopener noreferrer');
    assert.equal(render('https://example.com', false).some(node => node.tag === 'a'), false);
});

test('chat renders local emoji and custom images without remote code', () => {
    const children = render(':smiley: :coblocks:');
    assert.equal(children.find(node => node.tag === 'span').textContent, '😃');
    const image = children.find(node => node.tag === 'img');
    assert.equal(image.src, 'moz-extension://test/logo.png');
    assert.equal(image.style.height, '30px');
    assert.equal(render('Hello :coblocks:').find(node => node.tag === 'img').style.height, '20px');
});
