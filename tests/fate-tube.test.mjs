import assert from 'node:assert/strict';
import test from 'node:test';
import {
    TUBE_LUCK_MAX, TUBE_MESSAGE_WINDOW, TUBE_OUTPUT_TOKENS, TUBE_POOL_SIZE, TUBE_REJECTED_LIMIT,
    TUBE_REVEAL_COUNT, TUBE_SCHEMA, TUBE_STICK_MAX_CODEPOINTS,
    adoptTubeStick, collectRejectedTexts, createTubeState, excerptMessage, parseTubeResponse,
    readTube, rejectTubeStick, shakeTube, tubeRequestPrompt,
} from '../public/scripts/extensions/director/fate-tube.js';

const stick = (index, fields = {}) => ({ id: `s${index}`, category: 'echo', rarity: 'common', text: `走向 ${index}`, ...fields });
const pool = (count = TUBE_POOL_SIZE) => Array.from({ length: count }, (_item, index) => stick(index));
// Response sticks carry exactly category/rarity/text; the host assigns ids after parsing.
const rawStick = index => ({ category: 'echo', rarity: 'common', text: `走向 ${index}` });
const rawPool = (count = TUBE_POOL_SIZE) => Array.from({ length: count }, (_item, index) => rawStick(index));

test('fresh tube starts full, unshaken and unspent; junk resets to it', () => {
    assert.deepEqual(createTubeState(), { version: 1, luck: TUBE_LUCK_MAX, pool: [], seenIds: [], adoptedId: null });
    for (const junk of [undefined, null, 'x', 7, [], {}, { version: 2 }, { version: 1, pool: 'x' }, { version: 1, pool: [], extra: 1 }]) {
        assert.deepEqual(readTube(junk), createTubeState(), JSON.stringify(junk));
    }
});

test('readTube drops invalid sticks, dedupes ids and filters seen ids; valid data round-trips', () => {
    const source = {
        version: 1, luck: 3,
        pool: [
            stick(0), stick(1, { rarity: 'rare' }),
            stick(2, { category: 'invented' }), stick(3, { rarity: 'legendary+' }),
            stick(4, { text: 'x'.repeat(TUBE_STICK_MAX_CODEPOINTS + 1) }), stick(5, { text: '有控制符\u0007' }),
            stick(6, { id: '' }), stick(7, { id: 'x'.repeat(65) }), 'not-a-stick',
            stick(0, { text: '重复 id 丢弃' }),
        ],
        seenIds: ['s0', 's1', 'ghost', 's0', 4],
        adoptedId: 's1',
    };
    const tube = readTube(source);
    assert.equal(tube.pool.length, 2);
    assert.deepEqual(tube.pool.map(item => item.id), ['s0', 's1']);
    assert.deepEqual(tube.seenIds, ['s0', 's1']);
    assert.equal(tube.adoptedId, 's1');
    assert.equal(tube.luck, 3);
    assert.deepEqual(readTube(tube), tube);
});

test('readTube keeps the rejected flag, clamps bad luck and drops unseen adoptions', () => {
    const tube = readTube({ version: 1, luck: 99, pool: [stick(0, { rejected: true }), stick(1)], seenIds: ['s0', 's1'], adoptedId: 's1' });
    assert.equal(tube.luck, TUBE_LUCK_MAX);
    assert.equal(tube.pool[0].rejected, true);
    assert.equal(tube.adoptedId, 's1');
    assert.equal(readTube({ version: 1, pool: [stick(0)], seenIds: [], adoptedId: 's0' }).adoptedId, null, 'adoption requires a seen stick');
    assert.equal(readTube({ version: 1, pool: [stick(0)], seenIds: [], adoptedId: 'ghost' }).adoptedId, null);
});

test('parseTubeResponse accepts exact JSON or one complete fence and rejects everything else', () => {
    const raw = JSON.stringify({ sticks: rawPool() });
    assert.equal(parseTubeResponse(raw).length, TUBE_POOL_SIZE);
    assert.equal(parseTubeResponse('```json\n' + raw + '\n```').length, TUBE_POOL_SIZE);
    assert.equal(parseTubeResponse(`  \n${raw}\n `).length, TUBE_POOL_SIZE);
    const protoStick = '{"category":"echo","rarity":"common","text":"x","__proto__":{}}';
    const nearMisses = [
        '```json\n' + raw, raw + ' trailing', '```jsson\n' + raw + '\n```', 'not json',
        JSON.stringify([]), JSON.stringify({ sticks: rawPool(TUBE_POOL_SIZE - 1) }), JSON.stringify({ sticks: rawPool(TUBE_POOL_SIZE + 1) }),
        JSON.stringify({ sticks: rawPool(), extra: 1 }), JSON.stringify({ other: [] }),
        JSON.stringify({ sticks: rawPool().map((item, index) => index === 3 ? { ...item, category: 'invented' } : item) }),
        JSON.stringify({ sticks: rawPool().map((item, index) => index === 3 ? { ...item, rarity: 'epic' } : item) }),
        JSON.stringify({ sticks: rawPool().map((item, index) => index === 3 ? { ...item, text: '长'.repeat(TUBE_STICK_MAX_CODEPOINTS + 1) } : item) }),
        JSON.stringify({ sticks: rawPool().map((item, index) => index === 3 ? { ...item, text: '' } : item) }),
        JSON.stringify({ sticks: rawPool().map((item, index) => index === 3 ? { ...item, text: `${item.text}\u0007` } : item) }),
        JSON.stringify({ sticks: rawPool().map((item, index) => index === 3 ? { ...item, extra: 1 } : item) }),
        JSON.stringify({ sticks: rawPool().map((item, index) => index === 3 ? { category: item.category, rarity: item.rarity } : item) }),
        `{"sticks":[${rawPool().map((item, index) => index === 3 ? protoStick : JSON.stringify(item)).join(',')}]}`,
        JSON.stringify({ sticks: [...rawPool(TUBE_POOL_SIZE - 1).map(item => item.text), rawPool()[0].text].map(text => ({ category: 'echo', rarity: 'common', text })) }),
        JSON.stringify({ sticks: rawPool().map((item, index) => index === 3 ? { ...item, id: 'model-owned' } : item) }),
    ];
    for (const candidate of nearMisses) assert.throws(() => parseTubeResponse(candidate), TypeError, candidate);
    const duplicate = rawPool().map((item, index) => index === 5 ? { ...item, text: rawPool()[0].text } : item);
    assert.throws(() => parseTubeResponse(JSON.stringify({ sticks: duplicate })), TypeError);
});

test('shake reveals up to three unseen sticks, spends one luck and never goes below zero', () => {
    let roll = 0;
    const random = () => (roll = (roll + 1) % 5) / 5;
    let tube = { ...createTubeState({ luck: 2 }), pool: pool() };
    const first = shakeTube(tube, random);
    assert.equal(first.revealed.length, TUBE_REVEAL_COUNT);
    assert.equal(first.tube.luck, 1);
    assert.deepEqual(first.tube.seenIds, first.revealed.map(item => item.id));
    const second = shakeTube(first.tube, random);
    assert.equal(second.tube.luck, 0);
    assert.equal(second.tube.seenIds.length, 6);
    assert.equal(shakeTube(second.tube, random), null, 'spent luck refuses to shake');
    const short = shakeTube({ ...createTubeState({ luck: 5 }), pool: pool(2) }, random);
    assert.equal(short.revealed.length, 2, 'a near-empty tube reveals its remainder');
    assert.equal(short.tube.luck, 4);
    assert.equal(shakeTube({ ...createTubeState(), pool: [] }, random), null);
});

test('adopt and reject require seen open sticks and one adoption per tube', () => {
    let tube = { ...createTubeState(), pool: pool(4), seenIds: ['s0', 's1'] };
    assert.equal(adoptTubeStick(tube, 's2'), null, 'unseen sticks cannot be adopted');
    tube = adoptTubeStick(tube, 's0');
    assert.equal(tube.adoptedId, 's0');
    assert.equal(adoptTubeStick(tube, 's1'), null, 'one adoption closes the tube');
    assert.equal(rejectTubeStick(tube, 's1'), null, 'a closed tube rejects nothing new');
    let open = { ...createTubeState(), pool: pool(4), seenIds: ['s0', 's1'] };
    assert.equal(rejectTubeStick(open, 's2'), null, 'unseen sticks cannot be rejected');
    open = rejectTubeStick(open, 's0');
    assert.equal(open.pool[0].rejected, true);
    assert.equal(rejectTubeStick(open, 's0'), null, 'already rejected stays put');
    assert.equal(adoptTubeStick(open, 's0'), null, 'rejected sticks cannot be adopted');
    assert.equal(adoptTubeStick(open, 's1').adoptedId, 's1');
});

test('rejected texts list explicit rejections first, then shaken-past sticks, capped and deduped', () => {
    const tube = {
        version: 1, luck: 5,
        pool: [stick(0, { text: '显式拒签', rejected: true }), stick(1, { text: '摇过没要' }), stick(2, { text: '没摇出来' }), stick(3, { text: '显式拒签', rejected: true })],
        seenIds: ['s0', 's1', 's3'], adoptedId: null,
    };
    assert.deepEqual(collectRejectedTexts(tube), ['显式拒签', '摇过没要']);
    const adopted = { ...tube, adoptedId: 's1' };
    assert.deepEqual(collectRejectedTexts(adopted), ['显式拒签'], 'the adopted stick is not a rejection');
    const flood = {
        version: 1, luck: 5,
        pool: Array.from({ length: 20 }, (_item, index) => stick(index, { text: `拒绝 ${index}`, rejected: true })),
        seenIds: Array.from({ length: 20 }, (_item, index) => `s${index}`), adoptedId: null,
    };
    assert.equal(collectRejectedTexts(flood).length, TUBE_REJECTED_LIMIT);
    assert.deepEqual(collectRejectedTexts(flood)[0], '拒绝 0', 'FIFO keeps the oldest rejections');
});

test('the request prompt carries diversity axes, negative list, schema and boundaries', () => {
    const prompt = tubeRequestPrompt({ messages: [{ name: '甲', text: '剧情' }], rejected: ['雨夜困在地下通道'] });
    assert.match(prompt, /12 支/);
    assert.match(prompt, /彼此不同/);
    assert.match(prompt, /外部事件/);
    assert.ok(prompt.includes(JSON.stringify(['雨夜困在地下通道'])));
    assert.ok(prompt.includes(JSON.stringify(TUBE_SCHEMA.value)));
    assert.match(prompt, /60 个 Unicode 码点/);
    assert.match(prompt, /不据此推动恋爱、亲密或服从/);
    assert.ok(prompt.includes(JSON.stringify([{ name: '甲', text: '剧情' }])));
});

test('the message window and excerpts bound the request input', () => {
    assert.equal(excerptMessage('短文本'), '短文本');
    const long = '甲'.repeat(500);
    const trimmed = excerptMessage(long, 400);
    assert.ok(trimmed.length < 500);
    assert.ok(trimmed.includes('\n[…]\n'));
    assert.ok(excerptMessage('🧭'.repeat(300), 100).isWellFormed());
    assert.equal(TUBE_MESSAGE_WINDOW, 8);
    assert.equal(TUBE_OUTPUT_TOKENS, 768);
});

test('the schema pins exactly twelve sticks with the deck categories and rarities', () => {
    const sticks = TUBE_SCHEMA.value.properties.sticks;
    assert.equal(sticks.minItems, TUBE_POOL_SIZE);
    assert.equal(sticks.maxItems, TUBE_POOL_SIZE);
    assert.equal(sticks.items.properties.category.enum.length, 12);
    assert.deepEqual(sticks.items.properties.rarity.enum, ['common', 'rare', 'legendary']);
    assert.equal(sticks.items.properties.text.maxLength, TUBE_STICK_MAX_CODEPOINTS);
    assert.equal(sticks.items.additionalProperties, false);
});
