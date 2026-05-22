import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const GOOGLE_VOICE_URL = 'https://voice.google.com/u/0/calls';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GoogleVoiceController {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.page = null;
  }

  async open() {
    fs.mkdirSync(this.config.profileDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      executablePath: this.config.browserPath || undefined,
      headless: this.config.headless,
      viewport: { width: 1440, height: 1000 },
      permissions: ['microphone'],
      args: [
        '--use-fake-ui-for-media-stream',
        '--disable-features=Translate'
      ]
    });

    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(7000);
    return this.page;
  }

  async close() {
    if (this.context) await this.context.close();
  }

  async gotoVoice() {
    await this.page.goto(GOOGLE_VOICE_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }

  async keepOpenForLogin() {
    await this.gotoVoice();
    console.log('Google Voice is open. Log in manually, grant microphone permission, then press Ctrl+C here when done.');
    await new Promise(() => {});
  }

  async status() {
    await this.gotoVoice();
    const title = await this.page.title().catch(() => '');
    const url = this.page.url();
    const bodyText = await this.page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const onVoiceApp = url.includes('voice.google.com');
    const loggedIn = onVoiceApp && !/sign in|choose an account/i.test(bodyText);
    const hasDialpad = loggedIn && await this.hasAny([
      () => this.page.getByLabel(/make a call|call/i),
      () => this.page.getByRole('button', { name: /call|make a call/i })
    ]);
    const incoming = /incoming call|answer|decline/i.test(bodyText);

    return {
      title,
      url,
      loggedIn,
      hasDialpad,
      incomingCallLikelyVisible: incoming
    };
  }

  async call(number) {
    if (!number) throw new Error('Missing phone number. Pass one as an argument or set GV_DEFAULT_CALL_TO.');
    await this.gotoVoice();

    await this.clickFirst([
      () => this.page.getByLabel(/make a call/i),
      () => this.page.getByRole('button', { name: /make a call|call/i }),
      () => this.page.locator('[aria-label*="Make a call" i]').first()
    ], 'call launcher');

    await this.fillFirst([
      () => this.page.getByLabel(/enter a name or phone number|phone number|to/i),
      () => this.page.locator('input[type="tel"]').first(),
      () => this.page.locator('input').first()
    ], number, 'phone number input');

    await this.page.keyboard.press('Enter').catch(() => {});
    await sleep(500);

    await this.clickFirst([
      () => this.page.getByRole('button', { name: /^call$|call .*|place call/i }),
      () => this.page.getByLabel(/^call$|place call/i),
      () => this.page.locator('[aria-label*="Call" i]').last()
    ], 'place call button');
  }

  async answer() {
    await this.gotoVoice();
    await this.clickFirst([
      () => this.page.getByRole('button', { name: /answer/i }),
      () => this.page.getByLabel(/answer/i),
      () => this.page.locator('[aria-label*="Answer" i]').first()
    ], 'answer button');
  }

  async hangup() {
    await this.clickFirst([
      () => this.page.getByRole('button', { name: /hang up|end call/i }),
      () => this.page.getByLabel(/hang up|end call/i),
      () => this.page.locator('[aria-label*="Hang up" i], [aria-label*="End call" i]').first()
    ], 'hang up button');
  }

  async screenshot() {
    await this.gotoVoice();
    const dir = path.join(this.config.projectRoot, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, 'google-voice-' + stamp + '.png');
    await this.page.screenshot({ path: file, fullPage: true });
    return file;
  }

  async hasAny(locatorFactories) {
    for (const factory of locatorFactories) {
      try {
        if (await factory().count()) return true;
      } catch {}
    }
    return false;
  }

  async clickFirst(locatorFactories, description) {
    let lastError;
    for (const factory of locatorFactories) {
      try {
        const locator = factory().first();
        await locator.waitFor({ state: 'visible', timeout: 2500 });
        await locator.click();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error('Could not find ' + description + '. Google Voice UI may have changed. Last error: ' + (lastError?.message || 'unknown'));
  }

  async fillFirst(locatorFactories, value, description) {
    let lastError;
    for (const factory of locatorFactories) {
      try {
        const locator = factory().first();
        await locator.waitFor({ state: 'visible', timeout: 2500 });
        await locator.fill(value);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error('Could not find ' + description + '. Last error: ' + (lastError?.message || 'unknown'));
  }
}
