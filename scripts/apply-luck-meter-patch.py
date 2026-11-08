# One-shot patcher: refined luck meter (segmented, thematic, accessible).
import io

def patch(path, edits):
    s = io.open(path, encoding='utf-8', newline='').read()
    applied = 0
    for name, (old, new) in edits:
        if new in s:
            continue
        assert old in s, path + ' anchor missing: ' + name
        assert s.count(old) == 1, path + ' anchor not unique: ' + name
        s = s.replace(old, new)
        applied += 1
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print(path, 'applied:', applied)

LUCK_DOM = """        const tubeLuck = document.createElement('div');
        tubeLuck.className = 'director_fate_tube_luck_row';
        tubeLuck.id = 'director_fate_tube_luck';
        const tubeLuckLabel = document.createElement('span');
        tubeLuckLabel.className = 'director_fate_tube_luck_label';
        tubeLuckLabel.textContent = '运';
        const tubeLuckMeter = document.createElement('div');
        tubeLuckMeter.className = 'director_fate_tube_luck_meter';
        tubeLuckMeter.id = 'director_fate_tube_luck_meter';
        tubeLuckMeter.setAttribute('role', 'meter');
        tubeLuckMeter.setAttribute('aria-label', '运势');
        tubeLuckMeter.setAttribute('aria-valuemin', '0');
        tubeLuckMeter.setAttribute('aria-valuemax', '10');
        const tubeLuckFill = document.createElement('div');
        tubeLuckFill.className = 'director_fate_tube_luck_fill';
        const tubeLuckNotches = document.createElement('div');
        tubeLuckNotches.className = 'director_fate_tube_luck_notches';
        tubeLuckMeter.append(tubeLuckFill, tubeLuckNotches);
        const tubeLuckValue = document.createElement('span');
        tubeLuckValue.className = 'director_fate_tube_luck_value';
        tubeLuckValue.id = 'director_fate_tube_luck_value';
        const tubeLuckNow = document.createElement('span');
        tubeLuckNow.id = 'director_fate_tube_luck_now';
        const tubeLuckMax = document.createElement('span');
        tubeLuckMax.className = 'director_fate_tube_luck_max';
        tubeLuckMax.textContent = '/10';
        tubeLuckValue.append(tubeLuckNow, tubeLuckMax);
        tubeLuck.append(tubeLuckLabel, tubeLuckMeter, tubeLuckValue);"""

SYNC_LUCK = """        const luckMeter = panel.querySelector('#director_fate_tube_luck_meter');
        if (luckMeter) {
            luckMeter.setAttribute('aria-valuenow', String(tube.luck));
            luckMeter.setAttribute('aria-valuetext', `${tube.luck} / 10`);
            luckMeter.classList.toggle('is_full', tube.luck >= 10);
            luckMeter.querySelector('.director_fate_tube_luck_fill').style.width = `${tube.luck * 10}%`;
        }
        const luckNow = panel.querySelector('#director_fate_tube_luck_now');
        if (luckNow) luckNow.textContent = String(tube.luck);
"""

patch('public/scripts/extensions/director/fate-ui.js', [
    ('luck-dom', (
        """        const tubeLuck = document.createElement('p');
        tubeLuck.id = 'director_fate_tube_luck';""",
        LUCK_DOM,
    )),
    ('luck-sync', (
        """        panel.querySelector('#director_fate_tube_luck').textContent =
            `运气 ${'●'.repeat(tube.luck)}${'○'.repeat(Math.max(0, 10 - tube.luck))}`;""",
        SYNC_LUCK,
    )),
])

patch('public/scripts/extensions/director/style.css', [
    ('luck-meter-styles', (
        "#director_fate_panel #director_fate_tube_luck { margin: 0; letter-spacing: 2px; }",
        """#director_fate_panel #director_fate_tube_luck { margin: 0; }
.director_fate_tube_luck_row { display: flex; align-items: center; gap: 10px; }
.director_fate_tube_luck_label { flex: none; font-size: 15px; }
.director_fate_tube_luck_meter {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 12px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--SmartThemeBorderColor) 40%, transparent);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28);
    overflow: hidden;
}
.director_fate_tube_luck_fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: 0%;
    border-radius: 999px;
    background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.22), transparent 46%),
        linear-gradient(90deg,
            color-mix(in srgb, #e6b566 55%, var(--SmartThemeQuoteColor)),
            color-mix(in srgb, #e6b566 28%, var(--SmartThemeQuoteColor)));
    transition: width 300ms ease;
}
.director_fate_tube_luck_meter.is_full .director_fate_tube_luck_fill {
    box-shadow: 0 0 9px color-mix(in srgb, #e6b566 45%, transparent);
}
.director_fate_tube_luck_notches {
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(90deg,
        transparent 0,
        transparent calc(10% - 1px),
        var(--SmartThemeBorderColor) calc(10% - 1px),
        var(--SmartThemeBorderColor) 10%);
    pointer-events: none;
}
.director_fate_tube_luck_value { flex: none; font-variant-numeric: tabular-nums; }
.director_fate_tube_luck_max { color: var(--SmartThemeBodyColor); opacity: 0.6; }
body.reduced-motion .director_fate_tube_luck_fill,
.director_fate_nomotion .director_fate_tube_luck_fill { transition: none; }""",
    )),
])

patch('tests/director-fate-ui.test.mjs', [
    ('luck-assertions', (
        "    assert.equal(fixture.query('#director_fate_tube_luck').textContent, '运气 ●●●●●●○○○○');",
        """    const meter = fixture.query('#director_fate_tube_luck_meter');
    assert.equal(meter.getAttribute('role'), 'meter');
    assert.equal(meter.getAttribute('aria-valuenow'), '6');
    assert.equal(meter.getAttribute('aria-valuetext'), '6 / 10');
    assert.equal(meter.style.width, undefined);
    assert.equal(meter.querySelector('.director_fate_tube_luck_fill').style.width, '60%');
    assert.equal(fixture.query('#director_fate_tube_luck_value').textContent, '6/10');""",
    )),
    ('luck-zero-state', (
        "    assert.equal(shake.getAttribute('title'), '运不足——先让故事走一步');",
        """    assert.equal(shake.getAttribute('title'), '运不足——先让故事走一步');
    assert.equal(fixture.query('#director_fate_tube_luck_meter').getAttribute('aria-valuenow'), '0');
    assert.equal(fixture.query('#director_fate_tube_luck_meter .director_fate_tube_luck_fill').style.width, '0%');""",
    )),
])
