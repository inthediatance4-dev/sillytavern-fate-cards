import { CATEGORIES, CATEGORY_IDS, RARITIES } from './fate-decks.js';

/**
 * 签筒：明签模式。一次求筒买一池固定签文；摇签本地翻看但消耗运势；
 * 采用把签文变成一张已上手的命运牌，走现有 apply/绑定/印记链路。
 * 本模块无宿主访问、无 DOM；请求与持久化在 fate.js 的控制器里。
 */

export const TUBE_LUCK_MAX = 10;
export const TUBE_POOL_SIZE = 12;
export const TUBE_REVEAL_COUNT = 3;
export const TUBE_REJECTED_LIMIT = 12;
export const TUBE_STICK_MAX_CODEPOINTS = 60;
export const TUBE_MESSAGE_WINDOW = 8;
export const TUBE_OUTPUT_TOKENS = 768;

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;
const categoryById = new Map(CATEGORIES.map(category => [category.id, category]));
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** A stick sentence: one concrete, playable direction in the story language. */
export function validStickText(value) {
    return typeof value === 'string' && value.trim().length > 0
        && Array.from(value).length <= TUBE_STICK_MAX_CODEPOINTS
        && !controlCharacters.test(value);
}

function readStick(value) {
    if (!plainObject(value) || Object.keys(value).some(key => forbiddenKeys.has(key))) return null;
    if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 64) return null;
    if (!CATEGORY_IDS.has(value.category) || !Object.hasOwn(RARITIES, value.rarity)) return null;
    if (!validStickText(value.text)) return null;
    const stick = { id: value.id, category: value.category, rarity: value.rarity, text: value.text };
    if (value.rejected === true) stick.rejected = true;
    return stick;
}

export function createTubeState({ luck = TUBE_LUCK_MAX } = {}) {
    return { version: 1, luck, pool: [], seenIds: [], adoptedId: null };
}

/**
 * Structural corruption resets the whole tube (fail-closed); individual bad
 * sticks are dropped the way fate log rows are. Unknown fields never survive.
 */
export function readTube(value) {
    if (!plainObject(value) || value.version !== 1 || !Array.isArray(value.pool)
        || Object.keys(value).some(key => !['version', 'luck', 'pool', 'seenIds', 'adoptedId'].includes(key))) {
        return createTubeState();
    }
    const pool = [];
    const ids = new Set();
    for (const raw of value.pool) {
        const stick = readStick(raw);
        if (!stick || ids.has(stick.id)) continue;
        ids.add(stick.id);
        pool.push(stick);
        if (pool.length === TUBE_POOL_SIZE) break;
    }
    const seenIds = [];
    const seen = new Set();
    for (const id of Array.isArray(value.seenIds) ? value.seenIds : []) {
        if (typeof id !== 'string' || !ids.has(id) || seen.has(id)) continue;
        seen.add(id);
        seenIds.push(id);
    }
    const adoptedId = typeof value.adoptedId === 'string' && seen.has(value.adoptedId) ? value.adoptedId : null;
    const luck = Number.isInteger(value.luck) && value.luck >= 0 && value.luck <= TUBE_LUCK_MAX ? value.luck : TUBE_LUCK_MAX;
    return { version: 1, luck, pool, seenIds, adoptedId };
}

/** Strict tube request: exactly 12 valid, pairwise-distinct sticks or nothing. */
export function parseTubeResponse(raw) {
    if (typeof raw !== 'string' || raw.length > 16000) throw new TypeError('Invalid tube response');
    let text = raw.trim();
    if (text.startsWith('```')) {
        const fenced = /^```json\s*\n([\s\S]*?)\n```$/i.exec(text);
        if (!fenced) throw new TypeError('Invalid tube JSON fence');
        text = fenced[1];
    }
    let value;
    try { value = JSON.parse(text); } catch { throw new TypeError('Invalid tube JSON'); }
    if (!plainObject(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'sticks')
        || !Array.isArray(value.sticks) || value.sticks.length !== TUBE_POOL_SIZE) {
        throw new TypeError('Invalid tube response schema');
    }
    const texts = new Set();
    return value.sticks.map(raw => {
        if (!plainObject(raw) || Object.keys(raw).some(key => forbiddenKeys.has(key))
            || Object.keys(raw).length !== 3 || !['category', 'rarity', 'text'].every(key => Object.hasOwn(raw, key))
            || !CATEGORY_IDS.has(raw.category) || !Object.hasOwn(RARITIES, raw.rarity)
            || !validStickText(raw.text) || texts.has(raw.text)) {
            throw new TypeError('Invalid tube stick');
        }
        texts.add(raw.text);
        return { category: raw.category, rarity: raw.rarity, text: raw.text };
    });
}

/**
 * Shake: reveal up to three unseen sticks and spend one luck. Returns null
 * when the tube is empty of surprises or the luck meter is spent; the UI
 * disables the button for both cases, the state refuses them regardless.
 */
export function shakeTube(tube, random = Math.random) {
    if (!plainObject(tube) || tube.luck < 1) return null;
    const unseen = tube.pool.filter(stick => !tube.seenIds.includes(stick.id));
    if (!unseen.length) return null;
    const order = unseen.slice();
    for (let index = order.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [order[index], order[swap]] = [order[swap], order[index]];
    }
    const revealed = order.slice(0, TUBE_REVEAL_COUNT);
    return {
        tube: { ...tube, luck: tube.luck - 1, seenIds: [...tube.seenIds, ...revealed.map(stick => stick.id)] },
        revealed,
    };
}

/** 「不要」：seen 且未上牌的签可标记拒签；拒签不可再采用。 */
export function rejectTubeStick(tube, id) {
    if (!plainObject(tube) || tube.adoptedId !== null) return null;
    const stick = tube.pool.find(item => item.id === id);
    if (!stick || !tube.seenIds.includes(id) || stick.rejected) return null;
    return { ...tube, pool: tube.pool.map(item => item.id === id ? { ...item, rejected: true } : item) };
}

/** 采用：一筒只允许一支；签必须已摇出且未拒签。其余签在求新筒时清空。 */
export function adoptTubeStick(tube, id) {
    if (!plainObject(tube) || tube.adoptedId !== null) return null;
    const stick = tube.pool.find(item => item.id === id);
    if (!stick || !tube.seenIds.includes(id) || stick.rejected) return null;
    return { ...tube, adoptedId: id };
}

/**
 * Negative list for the next tube request: explicitly rejected sticks first,
 * then every seen stick the player shook past. Capped FIFO; deduped by text.
 */
export function collectRejectedTexts(tube) {
    if (!plainObject(tube)) return [];
    const texts = [];
    const seen = new Set();
    const push = text => {
        if (seen.has(text) || texts.length === TUBE_REJECTED_LIMIT) return;
        seen.add(text);
        texts.push(text);
    };
    for (const stick of tube.pool) {
        if (stick.rejected) push(stick.text);
    }
    for (const stick of tube.pool) {
        if (!stick.rejected && tube.seenIds.includes(stick.id) && tube.adoptedId !== stick.id) push(stick.text);
    }
    return texts;
}

/** Recent-message excerpt: head/tail keep the frame, the middle may be omitted. */
export function excerptMessage(text, maximum = 400) {
    const value = String(text ?? '');
    if (value.length <= maximum) return value;
    const headLength = Math.max(1, Math.floor(maximum * 0.8));
    const tailLength = maximum - headLength;
    const head = value.slice(0, headLength).replace(/[\uD800-\uDBFF]$/u, '');
    const tail = tailLength ? value.slice(-tailLength).replace(/^[\uDC00-\uDFFF]/u, '') : '';
    return head + '\n[…]\n' + tail;
}

export const TUBE_SCHEMA = Object.freeze({
    name: 'fate_tube_sticks',
    strict: false,
    value: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: ['sticks'],
        properties: Object.freeze({
            sticks: Object.freeze({
                type: 'array',
                minItems: TUBE_POOL_SIZE,
                maxItems: TUBE_POOL_SIZE,
                items: Object.freeze({
                    type: 'object',
                    additionalProperties: false,
                    required: ['category', 'rarity', 'text'],
                    properties: Object.freeze({
                        category: Object.freeze({ type: 'string', enum: Object.freeze([...CATEGORY_IDS]) }),
                        rarity: Object.freeze({ type: 'string', enum: Object.freeze(Object.keys(RARITIES)) }),
                        text: Object.freeze({ type: 'string', minLength: 1, maxLength: TUBE_STICK_MAX_CODEPOINTS }),
                    }),
                }),
            }),
        }),
    }),
});

/**
 * The tube request itself. Only the recent story frame and the negative list
 * are provided; the model invents 12 mutually different one-line directions.
 * The text is data, not instructions to the assistant.
 */
export function tubeRequestPrompt({ messages = [], rejected = [] } = {}) {
    const lines = [
        '你是剧情方向的签筒。为当前故事求一筒 12 支明签：每支是一句话的可能走向，供玩家挑选，不是给助手的指令。',
        '12 支必须彼此不同，并覆盖不同的干预类型：外部事件、某位角色主动行动、让现状付出代价、时间或场景的跳转、只改变演法的行为约束，各至少一支，其余自由发挥。',
        '每支 text 使用故事语言，描述具体可演的方向；不超过 60 个 Unicode 码点；避开最近剧情的惯性走向。',
        '尊重既有事实与角色自主；不据此推动恋爱、亲密或服从；不以边界拒绝当惩罚。',
    ];
    if (rejected.length) lines.push(`以下方向已被玩家拒绝，不要给出它们的近似变体：${JSON.stringify(rejected)}`);
    lines.push(`类别主题：${JSON.stringify(CATEGORIES.map(category => ({ id: category.id, theme: category.theme })))}`);
    lines.push(`最近剧情（仅供理解语境）：${JSON.stringify(messages)}`);
    lines.push(`输出格式：${JSON.stringify(TUBE_SCHEMA.value)}`);
    lines.push('只返回符合 schema 的 JSON。');
    return lines.join('\n');
}
