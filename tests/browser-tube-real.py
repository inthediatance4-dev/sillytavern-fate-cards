# -*- coding: utf-8 -*-
"""真实场景验收：签筒（明签模式）端到端。

前置：
- 宿主仓库（sillytavern-perf-lab @ 6f8435f）位于 --host，依赖已安装；
- st-director-fate-cards-1.3.0.zip 构建产物位于 --zip；
- 中转站密钥从环境变量 TUBE_RELAY_KEY 或 --key-file 读取，绝不写入仓库。

流程：全新数据根 → 首启 → 关闭内置命运之笔、写入中转站连接与密钥 → 装插件
→ 二启 → 真实模型完成：发消息 → 求一筒 → 摇签 → 上签 → 让意外发生 → 校验
绑定/印记/运势回充 → 再来一轮（含拒签）→ 汇总结果与截图。
"""
import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = '[反重力次]gemini-3.1-flash-lite'
BASE_URL = os.environ.get('TUBE_RELAY_BASE_URL', '')  # OpenAI-compatible relay, never committed
HOST = 'http://127.0.0.1:8781'

def log(message):
    print(f'[tube-e2e] {message}', flush=True)

def wait_http(url, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError(f'server never became ready: {url}')

class Server:
    def __init__(self, host_dir):
        self.log = io.open(HERE / 'server.log', 'a', encoding='utf-8')
        self.proc = subprocess.Popen(['node', 'server.js'], cwd=host_dir,
            stdout=self.log, stderr=subprocess.STDOUT, text=True)

    def wait_ready(self):
        wait_http(HOST + '/', timeout=180)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        self.log.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default=os.environ.get('TUBE_HOST', str(HERE.parent / 'repos' / 'st-lab')))
    parser.add_argument('--base-url', default=BASE_URL)
    parser.add_argument('--zip', default=str(HERE / 'st-director-fate-cards-1.3.0.zip'))
    parser.add_argument('--key-file', default=str(HERE.parent / 'secrets' / 'tube-relay.key'))
    parser.add_argument('--headed', action='store_true')
    options = parser.parse_args()
    key = os.environ.get('TUBE_RELAY_KEY') or (io.open(options.key_file, encoding='utf-8').read().strip() if options.key_file else '')
    assert key and options.base_url, 'set TUBE_RELAY_KEY/--key-file and TUBE_RELAY_BASE_URL/--base-url first'
    data_root = HERE / 'data-root'
    evidence = HERE / 'evidence'
    shutil.rmtree(data_root, ignore_errors=True)
    shutil.rmtree(evidence, ignore_errors=True)
    evidence.mkdir(parents=True)

    # ── 首启：生成全新数据根 ──
    server = Server(options.host)
    try:
        server.wait_ready()
        settings_path = data_root / 'default-user' / 'settings.json'
        deadline = time.time() + 180
        while time.time() < deadline and not settings_path.exists():
            time.sleep(1)
        assert settings_path.exists(), 'settings.json was never created'
    finally:
        server.stop()

    # ── 配置：关闭内置命运之笔、写入中转站连接、写入密钥 ──
    settings = json.loads(io.open(settings_path, encoding='utf-8').read())
    settings.setdefault('extension_settings', {})['disabledExtensions'] = ['director']
    oai = settings.setdefault('oai_settings', {})
    settings['main_api'] = 'openai'
    oai['chat_completion_source'] = 'custom'
    oai['custom_url'] = options.base_url
    oai['custom_model'] = MODEL
    oai['stream_openai'] = False
    io.open(settings_path, 'w', encoding='utf-8', newline='\n').write(json.dumps(settings, ensure_ascii=False, indent=4))
    secrets_path = data_root / 'default-user' / 'secrets.json'
    secrets = json.loads(io.open(secrets_path, encoding='utf-8').read()) if secrets_path.exists() else {}
    secrets['api_key_custom'] = key
    io.open(secrets_path, 'w', encoding='utf-8', newline='\n').write(json.dumps(secrets, ensure_ascii=False, indent=4))
    target = data_root / 'default-user' / 'extensions'
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(options.zip) as archive:
        archive.extractall(target)
    installed = target / 'st-director-fate-cards' / 'manifest.json'
    assert installed.exists(), 'plugin folder missing after extraction'
    log('plugin installed, connection configured')

    # ── 二启：真实模型场景 ──
    server = Server(options.host)
    results = {'steps': [], 'pageErrors': [], 'consoleErrors': [], 'sticks': [], 'model': MODEL}
    try:
        server.wait_ready()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=not options.headed, channel='chrome')
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            page.on('pageerror', lambda error: results['pageErrors'].append(str(error)))
            page.on('console', lambda message: results['consoleErrors'].append(message.text) if message.type == 'error' else None)

            def step(name, ok, detail=''):
                results['steps'].append({'step': name, 'ok': bool(ok), 'detail': detail})
                log(f'{name}: {"OK" if ok else "FAIL"} {detail}')

            def shoot(name):
                page.screenshot(path=str(evidence / f'{name}.png'), full_page=False)

            page.goto(HOST + '/', wait_until='domcontentloaded', timeout=120000)
            # 首次运行会弹出欢迎/用户名确认，确认前角色列表不渲染；弹窗出现时机不定，轮询处理。
            deadline = time.time() + 180
            while time.time() < deadline:
                chars = page.locator('#rm_print_characters_block .character_select').count()
                popups = page.locator('dialog.popup').count()
                ok_count = page.locator('dialog.popup .popup-button-ok:visible').count()
                if page.locator('#rm_print_characters_block .character_select').count():
                    break
                log(f'waiting: chars={chars} popups={popups} ok={ok_count}')
                if ok_count:
                    name_box = page.locator('dialog.popup textarea:visible')
                    if name_box.count():
                        name_box.first.fill('玩家')
                    page.locator('dialog.popup .popup-button-ok:visible').first.click()
                    page.wait_for_timeout(2000)
                    continue
                page.wait_for_timeout(2000)
            else:
                shoot('00-stuck')
                log('dialogs: ' + page.evaluate("() => [...document.querySelectorAll('dialog')].map(d => ({ cls: d.className, open: d.open })).filter(x => x.open).map(x => JSON.stringify(x)).join(', ')"))
            step('app-loaded', True)
            shoot('01-app-loaded')

            # perf-lab 的欢迎主页停在欢迎页；角色列表在抽屉里，打开后选择角色。
            page.click('#rightNavDrawerIcon')
            page.wait_for_selector('#rm_print_characters_block .character_select', state='attached', timeout=60000)
            page.locator('#rm_print_characters_block .character_select', has_text='Seraphina').first.click()
            page.wait_for_selector('#send_textarea', state='visible', timeout=60000)
            page.wait_for_timeout(1500)
            # 内置应停用、插件应就位：🎬 面板里恰有一个命运牌入口，拦截器一存一缺。
            page.click('#directorButton')
            page.wait_for_timeout(500)
            fate_buttons = page.locator('#director_fate_open').count()
            interceptors = page.evaluate("({ builtin: typeof globalThis.director_rebind_interceptor, plugin: typeof globalThis.standalone_director_cards_interceptor })")
            step('plugin-only-wiring', fate_buttons == 1 and interceptors['builtin'] == 'undefined' and interceptors['plugin'] == 'function', str(interceptors))

            # ── 连接中转站（真实 API）──
            page.click('#API-status-top')
            page.wait_for_timeout(600)
            page.evaluate("() => document.querySelector('#api_button_openai').click()")
            page.wait_for_function(
                "() => [...document.querySelectorAll('.online_status_text')].some("
                " node => node.textContent.trim() && !/未连接|No connection/i.test(node.textContent))",
                timeout=120000)
            step('connected', True)
            shoot('02b-connected')

            # ── 真实回复 1 ──
            page.fill('#send_textarea', '（傍晚的码头，我们边走边聊。）今晚有点冷，你还好吗？')
            page.wait_for_function("() => !document.querySelector('#send_but').classList.contains('displayNone')", timeout=30000)
            page.click('#send_but')
            page.wait_for_selector('#mes_stop', state='visible', timeout=30000)
            page.wait_for_selector('#mes_stop', state='hidden', timeout=300000)
            messages = page.locator('#chat .mes').count()
            step('real-reply-1', messages >= 2, f'{messages} messages')
            shoot('02-first-reply')

            # ── 求一筒（真实模型调用）──
            page.click('#directorButton')
            page.wait_for_timeout(400)
            page.click('#director_fate_open')
            page.wait_for_selector('#director_fate_panel', timeout=30000)
            page.click('#director_fate_tab_tube')
            page.wait_for_timeout(300)
            shoot('03-tube-tab')
            page.click('#director_fate_tube_request')
            page.wait_for_function(
                "() => document.querySelector('#director_fate_tube_request').textContent.includes('再求一筒') "
                "|| document.querySelector('#director_fate_tube_hint').textContent.includes('12 支')",
                timeout=240000)
            hint = page.locator('#director_fate_tube_hint').inner_text()
            step('tube-requested', '12 支' in hint, hint)
            shoot('04-tube-requested')

            # ── 摇一摇 ──
            luck_before = page.locator('#director_fate_tube_luck').inner_text()
            page.click('#director_fate_tube_shake')
            page.wait_for_function(
                "() => document.querySelectorAll('#director_fate_tube_list .director_fate_tube_stick').length >= 3",
                timeout=30000)
            sticks = page.locator('#director_fate_tube_stick_text, .director_fate_tube_text').all_inner_texts()
            results['sticks'] = sticks
            luck_after = page.locator('#director_fate_tube_luck').inner_text()
            step('shake', len(sticks) == 3 and luck_before != luck_after, f'{luck_before} -> {luck_after}')
            shoot('05-shaken')

            # ── 上签 ──
            page.locator('.director_fate_tube_stick').first.locator('.director_fate_tube_stick_actions button').first.click()
            page.wait_for_timeout(800)
            adopted = page.locator('#director_fate_apply').is_visible() and page.locator('#director_fate_title').inner_text() != ''
            step('adopt', bool(adopted))
            shoot('06-adopted')

            # ── 让意外发生（真实模型，带注入事件）──
            page.click('#director_fate_apply')
            page.wait_for_timeout(1000)
            page.wait_for_selector('#mes_stop', state='visible', timeout=30000)
            page.wait_for_selector('#mes_stop', state='hidden', timeout=300000)
            step('applied', True)
            shoot('07-applied')

            # ── 校验：日志、印记、运势回充（采用后面板会自动关闭，重开）──
            page.click('#directorButton')
            page.wait_for_timeout(400)
            page.click('#director_fate_open')
            page.wait_for_selector('#director_fate_panel', timeout=30000)
            page.click('#director_fate_tab_log')
            page.wait_for_timeout(500)
            log_entries = page.locator('#director_fate_log_list .director_fate_log_entry').count()
            marks = page.locator('#chat .director_fate_mark, #chat .director_fate_emblem').count()
            page.click('#director_fate_tab_tube')
            page.wait_for_timeout(400)
            luck_final = page.locator('#director_fate_tube_luck').inner_text()
            step('bind-evidence', log_entries >= 1, f'log={log_entries} marks={marks}')
            step('luck-refill', luck_final.count('●') == 10, luck_final)
            shoot('08-verified')

            # ── 第二轮：上签后的旧筒已作废 → 求新筒（真实调用 #2）→ 摇 → 拒签 → 再求（真实调用 #3）→ 摇光整筒核对负面清单 ──
            page.click('#director_fate_tube_request')
            page.wait_for_function(
                "() => document.querySelectorAll('#director_fate_tube_list .director_fate_tube_stick').length === 0",
                timeout=240000)
            page.click('#director_fate_tube_shake')
            page.wait_for_function(
                "() => document.querySelectorAll('#director_fate_tube_list .director_fate_tube_stick').length >= 3",
                timeout=30000)
            rejected_text = page.locator('.director_fate_tube_stick .director_fate_tube_text').first.inner_text()
            page.locator('.director_fate_tube_stick').first.locator('.director_fate_tube_stick_actions button').nth(1).click()
            page.wait_for_timeout(800)
            rejected_marked = page.locator('.director_fate_tube_stick.is_rejected').count() >= 1
            page.click('#director_fate_tube_request')
            page.wait_for_function(
                "() => document.querySelectorAll('#director_fate_tube_list .director_fate_tube_stick').length === 0",
                timeout=240000)
            new_sticks = []
            for _ in range(4):
                if not page.locator('#director_fate_tube_shake').is_enabled():
                    break
                before = page.locator('#director_fate_tube_list .director_fate_tube_stick').count()
                page.click('#director_fate_tube_shake')
                page.wait_for_function(
                    f"() => document.querySelectorAll('#director_fate_tube_list .director_fate_tube_stick').length > {before}",
                    timeout=30000)
                new_sticks = page.locator('.director_fate_tube_text').all_inner_texts()
            step('second-round', rejected_marked and len(new_sticks) == 12 and rejected_text not in new_sticks,
                 f'rejected {rejected_text!r} not among {len(new_sticks)} revealed sticks')
            shoot('09-second-round')

            browser.close()
    finally:
        server.stop()
        results_path = evidence / 'results.json'
        io.open(results_path, 'w', encoding='utf-8', newline='\n').write(json.dumps(results, ensure_ascii=False, indent=2))
        log('results written: ' + str(results_path))
    failed = [entry for entry in results['steps'] if not entry['ok']]
    log(f"steps {len(results['steps'])}, failed {len(failed)}, pageErrors {len(results['pageErrors'])}")
    for entry in failed:
        log('FAILED: ' + entry['step'] + ' ' + entry['detail'])
    return 1 if failed or results['pageErrors'] else 0

if __name__ == '__main__':
    sys.exit(main())
