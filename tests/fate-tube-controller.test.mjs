import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from '../public/lib/eventemitter.js';
import { createFateController } from '../public/scripts/extensions/director/fate.js';
import { TUBE_EXPAND_OUTPUT_TOKENS, TUBE_EXPAND_SCHEMA, TUBE_OUTPUT_TOKENS, TUBE_POOL_SIZE, TUBE_SCHEMA,
    parseTubeResponse, tubeRequestPrompt } from '../public/scripts/extensions/director/fate-tube.js';
import { createIsolatedGenerator } from '../public/scripts/plugin-runtime/requests.js';

globalThis.localStorage = { getItem: () => null };

const events = Object.fromEntries([
    'CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED',
    'GENERATE_AFTER_DATA', 'GENERATION_COMPLETED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED',
].map(name => [name, name]));

const rawPool = () => JSON.stringify({
    sticks: Array.from({ length: TUBE_POOL_SIZE }, (_item, index) => ({
        category: ['echo', 'encounter', 'turn', 'gift', 'undercurrent', 'tidings'][index % 6],
        rarity: index === 4 ? 'legendary' : index % 3 === 0 ? 'rare' : 'common',
        text: `签文方向 ${index}`,
    })),
});

const freshTube = () => ({ version: 1, luck: 10, pool: [], seenIds: [], adoptedId: null });

function lab({ tube = true, response = rawPool(), autoSettle = true } = {}) {
    const eventSource = new EventEmitter();
    let context;
    let generating = false;
    let serial = 0;
    let saves = 0;
    const quietCalls = [];
    const aborted = [];
    let resolveRequest;
    let rejectRequest;
    const metadata = { director: { fate: { version: 1, held: null, bound: null, offer: null, pity: 0, recent: [], log: [], rerolls: 1, tube: freshTube() } } };
    context = {
        eventSource, eventTypes: events, chatId: 'chat-one', chatMetadata: metadata,
        groupId: null, characterId: 0,
        chat: [
            { is_user: true, name: 'User', mes: '开头一句。' },
            { is_user: false, name: 'Bot', mes: '角色的最近回复。', extra: {} },
            { is_user: false, name: 'Narrator', is_system: true, mes: '系统行不进签筒。', extra: { type: 'narrator' } },
        ],
        extensionPrompts: {},
        generateQuietPrompt: async options => {
            quietCalls.push(options);
            if (options.signal) options.signal.addEventListener('abort', () => aborted.push(String(options.signal.reason ?? 'aborted')));
            await new Promise((resolve, reject) => {
                resolveRequest = resolve;
                rejectRequest = reject;
                if (autoSettle) queueMicrotask(() => resolve(typeof response === 'function' ? response() : response));
            });
            return typeof response === 'function' ? response() : response;
        },
        saveMetadata: async () => { saves++; return true; },
        saveMetadataDebounced: () => { saves++; },
    };
    let generator = async () => {};
    let changes = 0;
    let enabled = tube;
    const controller = createFateController(() => context, {
        isGenerating: () => generating, uuid: () => `host-${++serial}`, random: () => 0,
        save: async (_current, shouldSave) => shouldSave ? shouldSave() : true,
        tubeEnabled: () => enabled,
        generate: async current => generator(current),
        onChange: () => { changes++; },
    });
    const emit = (name, ...args) => eventSource.emit(events[name], ...args);
    return {
        controller, metadata, quietCalls, aborted, emit,
        get context() { return context; }, get saves() { return saves; }, get changes() { return changes; },
        setGenerating(value) { generating = value; },
        setTubeEnabled(value) { enabled = value; },
        switchChat() { context = { ...context, chatId: 'chat-two', chatMetadata: { director: {} } }; },
        settleRequest() { resolveRequest(); },
        failRequest(reason = new Error('provider down')) { rejectRequest(reason); },
        setGenerator(value) { generator = value; },
        async runGeneration(type = 'normal') {
            await emit('GENERATION_STARTED', type, {}, false);
            const requestChat = context.chat.map(message => ({ ...message }));
            controller.prepare(type, requestChat);
            const token = requestChat.find(message => message.extra?.directorFatePrompt)?.mes;
            const data = { prompt: token ?? 'ordinary', input: token ?? 'ordinary' };
            await emit('GENERATE_AFTER_DATA', data, false);
            context.chat.push({ is_user: false, name: 'Bot', mes: '一条被签文引导的回复。', extra: {} });
            await emit('MESSAGE_RECEIVED', context.chat.length - 1);
            await emit('GENERATION_ENDED');
            await emit('GENERATION_COMPLETED', { data, type, chatId: context.chatId, chatMetadata: context.chatMetadata });
            return { data, token };
        },
        get tubeState() { return metadata.director.fate.tube; },
    };
}

test('requestTube sends one isolated bounded call with recent story and negative list, then stores twelve sticks', async () => {
    const fixture = lab();
    fixture.metadata.director.fate.tube = {
        version: 1, luck: 4,
        pool: [{ id: 'old', category: 'echo', rarity: 'common', text: '雨夜困在地下通道', rejected: true }],
        seenIds: ['old'], adoptedId: null,
    };
    const pending = fixture.controller.requestTube();
    assert.equal(fixture.quietCalls.length, 1);
    const options = fixture.quietCalls[0];
    assert.equal(options.isolated, true);
    assert.equal(options.maxOutputTokens, TUBE_OUTPUT_TOKENS);
    assert.deepEqual(options.jsonSchema, TUBE_SCHEMA);
    assert.ok(options.signal instanceof AbortSignal);
    const prompt = options.quietPrompt;
    assert.ok(prompt.includes(JSON.stringify(['雨夜困在地下通道'])), 'the negative list rides along');
    assert.ok(prompt.startsWith(tubeRequestPrompt({}).slice(0, 30)), 'the standard instruction opens the prompt');
    assert.ok(prompt.includes(JSON.stringify([
        { name: 'User', text: '开头一句。' },
        { name: 'Bot', text: '角色的最近回复。' },
    ])), 'recent user and character lines are provided, system rows are not');
    await pending;
    const tube = fixture.tubeState;
    assert.equal(tube.pool.length, TUBE_POOL_SIZE);
    assert.ok(tube.pool.every(stick => /^host-\d+$/.test(stick.id)), 'the host owns stick ids');
    assert.deepEqual(tube.seenIds, []);
    assert.equal(tube.adoptedId, null);
    assert.equal(tube.luck, 4, 'a new tube keeps the luck meter');
    assert.equal(parseTubeResponse(rawPool()).length, TUBE_POOL_SIZE);
});

test('an invalid or failed response keeps the old pool, and failures clear the busy state', async () => {
    for (const broken of ['not json', JSON.stringify({ sticks: [] })]) {
        const fixture = lab({ response: broken });
        fixture.metadata.director.fate.tube = { version: 1, luck: 2, pool: [{ id: 'keep', category: 'echo', rarity: 'common', text: '旧签' }], seenIds: [], adoptedId: null };
        const error = await fixture.controller.requestTube().catch(error => error);
        assert.match(String(error?.message ?? error), /求签失败/);
        assert.equal(fixture.tubeState.pool[0].text, '旧签');
        assert.equal(fixture.controller.view().tube.busy, false);
    }
    const fixture = lab({ autoSettle: false });
    const pending = fixture.controller.requestTube().catch(error => error);
    await assert.rejects(fixture.controller.requestTube(), /正在生成/, 'a second tube request cannot start while one is in flight');
    fixture.failRequest();
    const error = await pending;
    assert.match(String(error?.message ?? error), /求签失败/);
    assert.equal(fixture.controller.view().tube.busy, false);
});

test('a chat switch or a main generation start aborts the in-flight tube request', async () => {
    const switched = lab();
    const pendingSwitch = switched.controller.requestTube();
    switched.switchChat();
    await switched.emit('CHAT_CHANGED');
    assert.equal(await pendingSwitch, false, 'the stale request resolves without writing');
    assert.equal(switched.tubeState.pool.length, 0, 'the switch leaves no new pool behind');
    assert.ok(switched.aborted.length >= 1, 'the signal was aborted');
    assert.equal(switched.controller.view().tube.busy, false);

    const stopped = lab();
    const pendingStop = stopped.controller.requestTube();
    stopped.setGenerating(true);
    await stopped.emit('GENERATION_STARTED', 'normal', {}, false);
    assert.equal(await pendingStop, false, 'the aborted request resolves without writing');
    assert.equal(stopped.tubeState.pool.length, 0);
    assert.ok(stopped.aborted.length >= 1);
    assert.equal(stopped.controller.view().tube.busy, false);
});

test('shaking reveals three local sticks per luck and the view gates the buttons', async () => {
    const fixture = lab();
    await fixture.controller.requestTube();
    let view = fixture.controller.view().tube;
    assert.equal(view.canShake, true);
    assert.equal(view.canRequest, true);
    assert.equal(view.unseen, TUBE_POOL_SIZE);
    const revealed = await fixture.controller.shake();
    assert.equal(revealed.length, 3);
    assert.equal(fixture.tubeState.luck, 9);
    view = fixture.controller.view().tube;
    assert.equal(view.unseen, 9);
    assert.equal(view.seen.length, 3);
    assert.ok(view.seen.every(stick => typeof stick.text === 'string' && stick.text.startsWith('签文方向')));
    assert.deepEqual(view.seen.map(stick => stick.adopted), [false, false, false]);
    while (await fixture.controller.shake());
    assert.equal(fixture.tubeState.luck, 6, 'twelve sticks take exactly four shakes');
    assert.equal(fixture.controller.view().tube.canShake, false, 'the tube is exhausted');
    assert.equal(await fixture.controller.shake(), null);
    const spent = lab();
    spent.metadata.director.fate.tube.luck = 0;
    assert.equal(await spent.controller.shake(), null, 'zero luck refuses even a full tube');
});

test('adopting a seen stick turns it into the held fate card and closes the tube', async () => {
    const fixture = lab();
    await fixture.controller.requestTube();
    await fixture.controller.shake();
    const [first] = fixture.controller.view().tube.seen;
    const card = await fixture.controller.adoptStick(first.id);
    assert.equal(card.event, first.text);
    assert.equal(card.rarity, first.rarity);
    assert.equal(card.strength, 'medium');
    assert.ok(card.title.length > 0, 'the title comes from the stick category');
    assert.equal(fixture.tubeState.adoptedId, first.id);
    assert.equal(fixture.controller.view().tube.closed, true);
    await assert.rejects(fixture.controller.adoptStick(fixture.controller.view().tube.seen[1].id), /不能采用/, 'one adoption closes the tube');
    assert.equal(await fixture.controller.shake(), null, 'a closed tube refuses further shakes');
    assert.equal(fixture.controller.view().held.id, card.id, 'the stick rides the normal held flow');
});

test('the adopted stick binds through the normal apply chain and carries on swipe', async () => {
    const fixture = lab();
    await fixture.controller.requestTube();
    await fixture.controller.shake();
    const [first] = fixture.controller.view().tube.seen;
    const card = await fixture.controller.adoptStick(first.id);
    let token;
    fixture.setGenerator(async () => { token = (await fixture.runGeneration('normal')).token; });
    assert.equal(await fixture.controller.apply(), true, 'the stick rides the normal apply chain');
    assert.ok(token.includes(card.event), 'the injected frame carries the stick sentence');
    assert.equal(fixture.metadata.director.fate.bound.event, card.event, 'the bind path treats the stick like any card');
    assert.equal(fixture.controller.view().reveal.event, card.event);
    // A swipe on the same message replays the same stick sentence.
    fixture.setGenerating(true);
    const swipeChat = fixture.context.chat.map(message => ({ ...message }));
    assert.equal(fixture.controller.prepare('swipe', swipeChat), true);
    assert.ok(swipeChat.find(message => message.extra?.directorFatePrompt).mes.includes(card.event));
});

test('effective replies refill luck; regenerates, continues and other chats do not', async () => {
    const fixture = lab();
    fixture.tubeState.luck = 5;
    const complete = type => fixture.emit('GENERATION_COMPLETED', { data: {}, type, chatId: fixture.context.chatId, chatMetadata: fixture.context.chatMetadata });
    await complete('normal');
    assert.equal(fixture.tubeState.luck, 6);
    await complete('swipe');
    assert.equal(fixture.tubeState.luck, 7);
    await complete('continue');
    await complete('regenerate');
    await complete('quiet');
    await complete('impersonate');
    assert.equal(fixture.tubeState.luck, 7, 'only new replies count');
    await fixture.emit('GENERATION_COMPLETED', { data: {}, type: 'normal', chatId: 'another-chat', chatMetadata: fixture.context.chatMetadata });
    assert.equal(fixture.tubeState.luck, 7, 'another chat completion does not refill this chat');
    fixture.tubeState.luck = 10;
    await complete('normal');
    assert.equal(fixture.tubeState.luck, 10, 'luck caps at ten');
    assert.ok(fixture.saves > 0, 'accrual persists through the debounced saver');
});

test('a marked chapter resets the luck meter, and the toggle disables everything', async () => {
    const fixture = lab();
    fixture.tubeState.luck = 2;
    fixture.controller.onChapterMarked();
    assert.equal(fixture.tubeState.luck, 10);
    const disabled = lab({ tube: false });
    await assert.rejects(disabled.controller.shake(), /签筒未启用/);
    await assert.rejects(disabled.controller.requestTube(), /签筒未启用/);
    await assert.rejects(disabled.controller.adoptStick('whatever'), /签筒未启用/);
    await assert.rejects(disabled.controller.rejectStick('whatever'), /签筒未启用/);
    assert.equal(disabled.controller.view().tube, null, 'the view hides the tube entirely');
    disabled.metadata.director.fate.tube.luck = 3;
    disabled.controller.onChapterMarked();
    assert.equal(disabled.tubeState.luck, 3, 'a disabled tube earns nothing');
    await disabled.emit('GENERATION_COMPLETED', { data: {}, type: 'normal', chatId: disabled.context.chatId, chatMetadata: disabled.context.chatMetadata });
    assert.equal(disabled.tubeState.luck, 3);
});

test('rejected sticks ride the next request and the held card blocks adoption', async () => {
    const fixture = lab();
    await fixture.controller.requestTube();
    await fixture.controller.shake();
    const seen = fixture.controller.view().tube.seen;
    assert.equal(await fixture.controller.rejectStick(seen[0].id), true);
    assert.equal(fixture.tubeState.pool.find(stick => stick.id === seen[0].id).rejected, true);
    await fixture.controller.requestTube();
    assert.ok(fixture.quietCalls.at(-1).quietPrompt.includes(seen[0].text), 'the explicit rejection rides along');
    assert.equal(fixture.tubeState.pool.some(stick => stick.id === seen[0].id), false, 'the new tube replaced the old pool');
    // A held card blocks adoption until it is applied or discarded.
    fixture.metadata.director.fate.held = { id: 'held-1', title: '意外的回声', strength: 'medium', event: '旧牌', category: 'echo', rarity: 'common' };
    await fixture.controller.shake();
    const [stick] = fixture.controller.view().tube.seen;
    await assert.rejects(fixture.controller.adoptStick(stick.id), /先采用或弃掉手中的牌/);
});

test('aborting an in-flight tube request notifies UI, generation gates shaking, and disabling mid-flight skips commit', async () => {
    for (const event of ['GENERATION_STARTED', 'GENERATION_STOPPED']) {
        const fixture = lab({ autoSettle: false });
        const pending = fixture.controller.requestTube();
        assert.equal(fixture.controller.view().tube.busy, true);
        const before = fixture.changes;
        if (event === 'GENERATION_STARTED') await fixture.emit('GENERATION_STARTED', 'normal', {}, false);
        else await fixture.emit('GENERATION_STOPPED');
        assert.ok(fixture.changes > before, `${event} notifies listeners so UI clears busy state`);
        assert.equal(fixture.controller.view().tube.busy, false);
        fixture.failRequest(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        assert.equal(await pending, false);
    }

    const gated = lab();
    await gated.controller.requestTube();
    assert.equal(gated.controller.view().tube.canShake, true);
    gated.setGenerating(true);
    assert.equal(gated.controller.view().tube.canShake, false, 'shaking is disabled while main generation is active');
    gated.setGenerating(false);

    const toggled = lab({ autoSettle: false });
    const pending = toggled.controller.requestTube();
    toggled.setTubeEnabled(false);
    toggled.settleRequest();
    assert.equal(await pending, false, 'disabling the tube mid-flight drops the response');
    assert.equal(toggled.tubeState.pool.length, 0);

    // onChapterMarked is a safe no-op when no chat metadata is open.
    const empty = lab();
    empty.context.chatMetadata = null;
    assert.doesNotThrow(() => empty.controller.onChapterMarked());
});

test('expandStick sends one isolated bounded request, seals the expanded event, closes the tube, and rides apply + swipe', async () => {
    const expandedEvent = '码头雾气骤起，渡船汽笛在浓雾深处突兀响了一声，随后岸边路灯接连熄灭，只余下铁链撞击石阶的回响。';
    let mode = 'pool';
    const fixture = lab({
        response: () => mode === 'pool' ? rawPool() : JSON.stringify({ event: expandedEvent }),
    });
    await fixture.controller.requestTube();
    await fixture.controller.shake();
    mode = 'expand';
    const [first] = fixture.controller.view().tube.seen;
    const card = await fixture.controller.expandStick(first.id, 'strong');

    assert.equal(fixture.quietCalls.length, 2);
    const options = fixture.quietCalls[1];
    assert.equal(options.isolated, true);
    assert.equal(options.maxOutputTokens, TUBE_EXPAND_OUTPUT_TOKENS);
    assert.deepEqual(options.jsonSchema, TUBE_EXPAND_SCHEMA);
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(options.quietPrompt.includes(JSON.stringify(first.text)), 'the chosen stick seed rides in the prompt');
    assert.ok(options.quietPrompt.includes('a major, consequential upheaval'), 'selected strength rides in the prompt');
    assert.ok(options.quietPrompt.includes('开头一句。'), 'recent chat context rides in the prompt');
    assert.equal(options.quietPrompt.includes('系统行不进签筒'), false, 'system rows stay excluded');

    assert.equal(card.event, expandedEvent);
    assert.equal(card.strength, 'strong');
    assert.equal(card.category, first.category);
    assert.equal(card.rarity, first.rarity);
    assert.equal(fixture.tubeState.adoptedId, first.id);
    assert.equal(fixture.controller.view().tube.closed, true);
    assert.equal('expandingId' in fixture.controller.view().tube, false, 'idle tube view keeps its exact shape');
    assert.equal(JSON.stringify(fixture.controller.view()).includes(expandedEvent), false, 'expanded event stays sealed in held card');

    let token;
    fixture.setGenerator(async () => { token = (await fixture.runGeneration('normal')).token; });
    assert.equal(await fixture.controller.apply(), true);
    assert.ok(token.includes(expandedEvent), 'injected frame carries the expanded event');
    assert.equal(fixture.metadata.director.fate.bound.event, expandedEvent);
    assert.equal(fixture.controller.view().reveal.event, expandedEvent);

    fixture.setGenerating(true);
    const swipeChat = fixture.context.chat.map(message => ({ ...message }));
    assert.equal(fixture.controller.prepare('swipe', swipeChat), true);
    assert.ok(swipeChat.find(message => message.extra?.directorFatePrompt).mes.includes(expandedEvent));
});

test('expandStick validates pre-flight without model calls, keeps tube intact on failure, and aborts cleanly', async () => {
    const disabled = lab({ tube: false });
    await assert.rejects(disabled.controller.expandStick('s0'), /签筒未启用/);
    assert.equal(disabled.quietCalls.length, 0);

    let mode = 'pool';
    const fixture = lab({ response: () => mode === 'pool' ? rawPool() : 'not valid json' });
    await fixture.controller.requestTube();
    await fixture.controller.shake();
    const seen = fixture.controller.view().tube.seen;
    const unseen = fixture.tubeState.pool.find(stick => !fixture.tubeState.seenIds.includes(stick.id));
    const beforeCalls = fixture.quietCalls.length;

    await assert.rejects(fixture.controller.expandStick(seen[0].id, 'invalid'), /轻微波澜/);
    await assert.rejects(fixture.controller.expandStick(unseen.id), /不能采用/);
    fixture.metadata.director.fate.held = { id: 'held-1', title: '意外的回声', strength: 'medium', event: '旧牌', category: 'echo', rarity: 'common' };
    await assert.rejects(fixture.controller.expandStick(seen[0].id), /先采用或弃掉手中的牌/);
    assert.equal(fixture.quietCalls.length, beforeCalls, 'pre-flight rejections make zero model requests');

    // Invalid model output leaves the tube open and usable.
    fixture.metadata.director.fate.held = null;
    mode = 'broken';
    await assert.rejects(fixture.controller.expandStick(seen[0].id), /签文展开失败/);
    assert.equal(fixture.tubeState.adoptedId, null);
    assert.equal(fixture.controller.view().tube.closed, false);
    assert.equal(fixture.controller.view().tube.busy, false);

    // In-flight expand exposes expandingId, blocks concurrent requests, and aborts on generation start/chat switch.
    const asyncLab = lab({ autoSettle: false, response: () => JSON.stringify({ event: '扩写成功事件。' }) });
    asyncLab.metadata.director.fate.tube = {
        version: 1, luck: 5,
        pool: [{ id: 's0', category: 'echo', rarity: 'rare', text: '雨夜断电' }],
        seenIds: ['s0'], adoptedId: null,
    };
    const pending = asyncLab.controller.expandStick('s0');
    assert.equal(asyncLab.controller.view().tube.busy, true);
    assert.equal(asyncLab.controller.view().tube.expandingId, 's0');
    assert.equal(asyncLab.controller.view().tube.canRequest, false);
    assert.equal(asyncLab.controller.view().tube.canShake, false);
    await assert.rejects(asyncLab.controller.requestTube(), /正在生成/);
    await assert.rejects(asyncLab.controller.expandStick('s0'), /正在生成/);
    const changesBefore = asyncLab.changes;
    await asyncLab.emit('GENERATION_STARTED', 'normal', {}, false);
    assert.ok(asyncLab.changes > changesBefore, 'aborting expand notifies UI');
    assert.equal(asyncLab.controller.view().tube.busy, false);
    assert.equal('expandingId' in asyncLab.controller.view().tube, false);
    asyncLab.failRequest(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    assert.equal(await pending, false);
    assert.equal(asyncLab.tubeState.adoptedId, null);

    // Luck accrued while expanding is preserved when the expansion commits.
    const luckLab = lab({ autoSettle: false, response: () => JSON.stringify({ event: '保留运势回充的完整事件。' }) });
    luckLab.metadata.director.fate.tube = {
        version: 1, luck: 4,
        pool: [{ id: 's0', category: 'echo', rarity: 'common', text: '旧信寄到' }],
        seenIds: ['s0'], adoptedId: null,
    };
    const expanding = luckLab.controller.expandStick('s0');
    await luckLab.emit('GENERATION_COMPLETED', { data: {}, type: 'normal', chatId: luckLab.context.chatId, chatMetadata: luckLab.context.chatMetadata });
    assert.equal(luckLab.tubeState.luck, 5);
    luckLab.settleRequest();
    const committed = await expanding;
    assert.equal(committed.event, '保留运势回充的完整事件。');
    assert.equal(luckLab.tubeState.luck, 5);
    assert.equal(luckLab.tubeState.adoptedId, 's0');
});

test('cancelTube aborts active requestTube or expandStick, notifies listeners, and returns false when idle', async () => {
    const fixture = lab({ autoSettle: false, response: () => JSON.stringify({ event: '不应落盘。' }) });
    assert.equal(fixture.controller.cancelTube(), false, 'idle cancel is a no-op');

    const req = fixture.controller.requestTube();
    const beforeReq = fixture.changes;
    assert.equal(fixture.controller.cancelTube(), true);
    assert.ok(fixture.changes > beforeReq);
    assert.equal(fixture.controller.view().tube.busy, false);
    assert.equal(fixture.aborted.length, 1);
    fixture.failRequest(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    assert.equal(await req, false);

    fixture.metadata.director.fate.tube = {
        version: 1, luck: 6,
        pool: [{ id: 's0', category: 'secret', rarity: 'legendary', text: '旧怀表里掉出船票' }],
        seenIds: ['s0'], adoptedId: null,
    };
    const exp = fixture.controller.expandStick('s0', 'strong');
    assert.equal(fixture.controller.view().tube.expandingId, 's0');
    const beforeExp = fixture.changes;
    assert.equal(fixture.controller.cancelTube(), true);
    assert.ok(fixture.changes > beforeExp);
    assert.equal(fixture.controller.view().tube.busy, false);
    assert.equal('expandingId' in fixture.controller.view().tube, false);
    fixture.failRequest(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    assert.equal(await exp, false);
    assert.equal(fixture.tubeState.adoptedId, null);
    assert.equal(fixture.controller.cancelTube(), false);
});

test('expandStick integrates with real createIsolatedGenerator custom relay transport, schema, abort and error redaction', async () => {
    const eventSource = new EventEmitter();
    const sent = [];
    let behavior = 'ok';
    let abortableReject;
    const chatCompletionService = {
        sendRequest: async (payload, quiet, signal) => {
            sent.push({ payload, quiet, signal });
            if (behavior === 'hang') {
                return new Promise((_resolve, reject) => {
                    abortableReject = reject;
                    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                });
            }
            if (behavior === 'leak') throw new Error('Relay 500: sensitive-upstream-body');
            if (payload.json_schema?.name === 'fate_tube_sticks') return { content: rawPool() };
            return { content: JSON.stringify({ event: '浓雾之中，渡轮提早拉响了汽笛，岸边栈桥的铁链发出刺耳摩擦声。' }) };
        },
    };
    const metadata = { director: { fate: { version: 1, held: null, bound: null, offer: null, pity: 0, recent: [], log: [], rerolls: 1, tube: freshTube() } } };
    const context = {
        eventSource, eventTypes: events, chatId: 'relay-chat', chatMetadata: metadata,
        groupId: null, characterId: 0,
        mainApi: 'openai',
        chatCompletionSettings: {
            chat_completion_source: 'custom',
            custom_url: 'https://relay.example.invalid/v1',
            custom_model: 'flash-lite-test',
        },
        chat: [
            { is_user: true, name: '玩家', mes: '夜风很冷，码头上没有灯。' },
            { is_user: false, name: '旅伴', mes: '我们得赶在涨潮前上船。', extra: {} },
        ],
        extensionPrompts: {},
        saveMetadata: async () => true,
        saveMetadataDebounced: () => {},
    };
    const isolated = createIsolatedGenerator(() => context, { chatCompletionService });
    context.generateQuietPrompt = options => isolated(options);

    let serial = 0;
    const controller = createFateController(() => context, {
        isGenerating: () => false, uuid: () => `relay-${++serial}`, random: () => 0,
        save: async (_current, shouldSave) => shouldSave ? shouldSave() : true,
    });

    await controller.requestTube();
    await controller.shake();
    const [stick] = controller.view().tube.seen;

    // Provider error stays static and never leaks upstream response details.
    behavior = 'leak';
    await assert.rejects(
        controller.expandStick(stick.id, 'light'),
        error => /签文展开失败/.test(error.message) && !error.message.includes('sensitive-upstream-body'),
    );
    assert.equal(metadata.director.fate.tube.adoptedId, null);

    // User cancel aborts the real AbortSignal passed to ChatCompletionService.sendRequest.
    behavior = 'hang';
    const pending = controller.expandStick(stick.id, 'medium');
    await Promise.resolve();
    assert.equal(controller.cancelTube(), true);
    assert.equal(sent.at(-1).signal.aborted, true);
    assert.equal(await pending, false);
    assert.equal(Boolean(abortableReject), true);

    // Happy path sends the exact isolated OpenAI-compatible relay payload and seals the card.
    behavior = 'ok';
    const card = await controller.expandStick(stick.id, 'strong');
    const req = sent.at(-1);
    assert.equal(req.quiet, true);
    assert.equal(req.payload.type, 'quiet');
    assert.equal(req.payload.chat_completion_source, 'custom');
    assert.equal(req.payload.custom_url, 'https://relay.example.invalid/v1');
    assert.equal(req.payload.model, 'flash-lite-test');
    assert.equal(req.payload.max_tokens, TUBE_EXPAND_OUTPUT_TOKENS);
    assert.equal(req.payload.stream, false);
    assert.equal(req.payload.include_reasoning, false);
    assert.equal(req.payload.enable_web_search, false);
    assert.deepEqual(req.payload.json_schema, TUBE_EXPAND_SCHEMA);
    assert.equal(req.payload.messages.length, 1);
    assert.equal(card.strength, 'strong');
    assert.equal(card.event, '浓雾之中，渡轮提早拉响了汽笛，岸边栈桥的铁链发出刺耳摩擦声。');
    assert.equal(metadata.director.fate.tube.adoptedId, stick.id);
});
