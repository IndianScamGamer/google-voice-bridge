import { Builder, By, Key, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

const GOOGLE_VOICE_URL = 'https://voice.google.com/u/0/calls';
const GOOGLE_VOICE_MESSAGES_URL = 'https://voice.google.com/u/0/messages';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FirefoxVoiceController {
  constructor(config) {
    this.config = config;
    this.driver = null;
  }

  async open() {
    if (!this.config.firefoxProfile) {
      throw new Error('No Firefox profile found. Set GV_FIREFOX_PROFILE to your logged-in Firefox profile path.');
    }

    const options = new firefox.Options();
    if (this.config.firefoxBinary) options.setBinary(this.config.firefoxBinary);
    options.addArguments('-profile', this.config.firefoxProfile);
    options.setPreference('media.navigator.permission.disabled', true);
    options.setPreference('permissions.default.microphone', 1);
    options.setPreference('media.getusermedia.aec_enabled', false);
    options.setPreference('media.getusermedia.agc_enabled', false);
    options.setPreference('media.getusermedia.noise_enabled', false);
    options.setPreference('media.getusermedia.hpf_enabled', false);
    if (this.config.headless) options.addArguments('-headless');

    this.driver = await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .build();
  }

  async close() {
    if (this.driver) await this.driver.quit();
  }

  async gotoVoice() {
    await this.driver.get(GOOGLE_VOICE_URL);
    await sleep(2000);
  }

  async gotoMessages(number) {
    const normalized = normalizePhoneNumber(number);
    const url = normalized
      ? GOOGLE_VOICE_MESSAGES_URL + '?itemId=t.%2B' + normalized
      : GOOGLE_VOICE_MESSAGES_URL;
    await this.driver.get(url);
    await sleep(4000);
  }

  async keepOpenForLogin() {
    await this.gotoVoice();
    console.log('Firefox is open. Log in manually, grant microphone permission, then press Ctrl+C here when done.');
    await new Promise(() => {});
  }

  async status() {
    await this.gotoVoice();
    const title = await this.driver.getTitle().catch(() => '');
    const url = await this.driver.getCurrentUrl().catch(() => '');
    const bodyText = await this.getBodyText();
    const loggedIn = url.includes('voice.google.com') && !/sign in|choose an account/i.test(bodyText);
    const hasDialpad = loggedIn && await this.hasAny([
      () => this.findByXPath('//*[@aria-label and contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "make a call")]'),
      () => this.findButtonByText(/make a call|call/i)
    ]);
    const incoming = /incoming call|answer|decline/i.test(bodyText);

    return {
      title,
      url,
      backend: 'firefox',
      profile: this.config.firefoxProfile,
      loggedIn,
      hasDialpad,
      incomingCallLikelyVisible: incoming
    };
  }

  async call(number) {
    if (!number) throw new Error('Missing phone number. Pass one as an argument or set GV_DEFAULT_CALL_TO.');
    await this.gotoVoice();

    const callPanelOpen = await this.hasAny([
      () => this.findByXPath('//*[@aria-label="Call panel"]//input')
    ]);
    if (!callPanelOpen) {
      await this.clickFirst([
        () => this.findByXPath('//*[@aria-label and contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "make a call")]'),
        () => this.findButtonByText(/make a call|call/i)
      ], 'call launcher');
    }

    const input = await this.findFirst([
      () => this.findByXPath('//*[@aria-label="Call panel"]//input'),
      () => this.findByXPath('//input[@type="tel"]'),
      () => this.findByXPath('//input[contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "phone")]'),
      () => this.findByXPath('//*[contains(@class, "call-panel")]//input')
    ], 'phone number input');

    await input.clear().catch(() => {});
    await input.click();
    await input.sendKeys(Key.chord(Key.CONTROL, 'a'), Key.BACK_SPACE);
    await input.sendKeys(number);
    await sleep(800);

    const inputValue = await input.getAttribute('value').catch(() => '');
    const callButton = await this.findFirst([
      () => this.findByXPath('//*[@aria-label="Call panel"]//button[.//*[normalize-space()="call"] or normalize-space()="call"]'),
      () => this.findButtonByText(/^call$|place call|call .*/i)
    ], 'place call button');

    const disabledBeforeClick = await callButton.getAttribute('disabled').catch(() => null);
    await this.driver.executeScript('arguments[0].click()', callButton);
    await sleep(2500);
    const bodyText = await this.getBodyText();
    return {
      inputValue,
      disabledBeforeClick,
      activeCallLikelyVisible: /calling|ringing|hang up|end call|mute|keypad/i.test(bodyText)
    };
  }

  async answer() {
    await this.gotoVoice();
    await this.clickFirst([
      () => this.findButtonByText(/answer/i),
      () => this.findByXPath('//*[@aria-label and contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "answer")]')
    ], 'answer button');
  }

  async hangup() {
    await this.clickFirst([
      () => this.findButtonByText(/hang up|end call/i),
      () => this.findByXPath('//*[@aria-label and (contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "hang up") or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "end call"))]')
    ], 'hang up button');
  }

  async screenshot() {
    await this.gotoVoice();
    const png = await this.driver.takeScreenshot();
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(this.config.projectRoot, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, 'google-voice-firefox-' + stamp + '.png');
    fs.writeFileSync(file, png, 'base64');
    return file;
  }

  async readSmsThread(number) {
    await this.gotoMessages(number);
    const bodyText = await this.getBodyText();
    return {
      to: number,
      url: await this.driver.getCurrentUrl().catch(() => ''),
      messages: parseGoogleVoiceMessages(bodyText),
      bodyText
    };
  }

  async sendSms(number, message) {
    if (!number) throw new Error('Missing phone number. Pass one as an argument or set GV_DEFAULT_SMS_TO.');
    if (!message) throw new Error('Missing message text. Pass --text "...".');

    await this.gotoMessages(number);
    let textarea = await this.findMessageTextarea().catch(() => null);
    if (!textarea) {
      await this.startNewSmsThread(number);
      textarea = await this.findMessageTextarea();
    }

    await this.driver.executeScript('arguments[0].focus(); arguments[0].click();', textarea);
    await textarea.sendKeys(Key.chord(Key.CONTROL, 'a'), Key.BACK_SPACE);
    await this.driver.actions().sendKeys(message).perform();
    await sleep(750);

    const sendButton = await this.findFirst([
      () => this.findByXPath('//button[@aria-label="Send message"]'),
      () => this.findButtonByText(/^send$/i)
    ], 'send message button');
    const disabledBeforeClick = await sendButton.getAttribute('disabled').catch(() => null);
    if (disabledBeforeClick) throw new Error('Send button is disabled after typing message.');

    await this.driver.executeScript('arguments[0].click()', sendButton);
    await sleep(4000);
    const bodyText = await this.getBodyText();
    return {
      to: number,
      message,
      sentTextVisible: bodyText.includes(message),
      messages: parseGoogleVoiceMessages(bodyText)
    };
  }

  async startNewSmsThread(number) {
    const normalized = normalizePhoneNumber(number);
    await this.clickFirst([
      () => this.findByXPath('//*[@aria-label and contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "send new message")]'),
      () => this.findButtonByText(/send new message/i)
    ], 'send new message button').catch(() => {});

    const recipientInput = await this.findFirst([
      () => this.findByXPath('//input[@placeholder="Type a name or phone number"]'),
      () => this.findByXPath('//input[@placeholder="Enter a name or number"]'),
      () => this.findByXPath('//input[contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "name or number")]'),
      () => this.visibleInput()
    ], 'recipient input');

    await this.driver.executeScript('arguments[0].focus(); arguments[0].click();', recipientInput);
    await recipientInput.sendKeys(Key.chord(Key.CONTROL, 'a'), Key.BACK_SPACE);
    await recipientInput.sendKeys(normalized);
    await sleep(1500);

    const suggestion = await this.findSmsRecipientSuggestion(normalized).catch(() => null);
    if (suggestion) {
      await suggestion.click();
    } else {
      await recipientInput.sendKeys(Key.ENTER);
    }
    await sleep(2500);
  }

  async findMessageTextarea() {
    return await this.findFirst([
      () => this.findByXPath('//textarea[@placeholder="Type a message"]'),
      () => this.findByXPath('//textarea[contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "message")]'),
      () => this.visibleTextarea()
    ], 'message textarea');
  }

  async getBodyText() {
    try {
      return await this.driver.findElement(By.css('body')).getText();
    } catch {
      return '';
    }
  }

  async hasAny(factories) {
    for (const factory of factories) {
      try {
        await factory();
        return true;
      } catch {}
    }
    return false;
  }

  async clickFirst(factories, description) {
    const element = await this.findFirst(factories, description);
    await element.click();
  }

  async findFirst(factories, description) {
    let lastError;
    for (const factory of factories) {
      try {
        const element = await factory();
        await this.driver.wait(until.elementIsVisible(element), 3000);
        return element;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error('Could not find ' + description + '. Google Voice UI may have changed. Last error: ' + (lastError?.message || 'unknown'));
  }

  async findByXPath(xpath) {
    return await this.driver.wait(until.elementLocated(By.xpath(xpath)), 3000);
  }

  async findButtonByText(pattern) {
    const buttons = await this.driver.findElements(By.css('button, [role="button"]'));
    for (const button of buttons) {
      const label = ((await button.getAttribute('aria-label').catch(() => '')) + ' ' + (await button.getText().catch(() => ''))).trim();
      if (pattern.test(label)) return button;
    }
    throw new Error('No button matched ' + pattern);
  }

  async visibleTextarea() {
    const textareas = await this.driver.findElements(By.css('textarea'));
    for (const textarea of textareas) {
      if (await textarea.isDisplayed().catch(() => false)) return textarea;
    }
    throw new Error('No visible textarea');
  }

  async visibleInput() {
    const inputs = await this.driver.findElements(By.css('input'));
    for (const input of inputs) {
      if (await input.isDisplayed().catch(() => false)) return input;
    }
    throw new Error('No visible input');
  }

  async findElementByNormalizedDigits(normalizedDigits) {
    const lastTen = String(normalizedDigits || '').slice(-10);
    const element = await this.driver.executeScript(`
      const target = arguments[0];
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const candidates = [
        ...document.querySelectorAll('button[gv-test-id="recipient-picker"], [role="option"], button'),
        ...document.querySelectorAll('[tabindex], div, span')
      ];
      for (const el of candidates) {
        if (!visible(el)) continue;
        const digits = (el.textContent || '').replace(/\\D/g, '');
        if (digits.includes(target)) {
          return el.closest('[role="option"], button, [tabindex]') || el;
        }
      }
      return null;
    `, lastTen);
    if (!element) throw new Error('Could not find SMS recipient suggestion for ' + normalizedDigits);
    return element;
  }

  async findSmsRecipientSuggestion(normalizedDigits) {
    const lastTen = String(normalizedDigits || '').slice(-10);
    const element = await this.driver.executeScript(`
      const target = arguments[0];
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const candidates = [
        ...document.querySelectorAll('.send-to-button, button, [role="button"], [role="option"], [tabindex]')
      ];
      for (const el of candidates) {
        if (!visible(el)) continue;
        const text = el.textContent || '';
        const digits = text.replace(/\\D/g, '');
        if (/send to/i.test(text) && digits.includes(target)) {
          return el.matches('.send-to-button, button, [role="button"], [role="option"]')
            ? el
            : el.querySelector('.send-to-button, button, [role="button"], [role="option"]') || el;
        }
      }
      return null;
    `, lastTen);
    if (!element) throw new Error('Could not find SMS Send to suggestion for ' + normalizedDigits);
    return element;
  }
}

export function normalizePhoneNumber(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits.length === 10 ? '1' + digits : digits;
}

export function parseGoogleVoiceMessages(bodyText) {
  const lines = String(bodyText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const messages = [];
  for (const line of lines) {
    const match = line.match(/^Message from ([^,]+), (.*), ([A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2} \d{4}, .*?)\.$/);
    if (!match) continue;
    const from = match[1] === 'you' ? 'you' : 'them';
    const text = match[2];
    const timestamp = match[3];
    messages.push({
      from,
      text,
      timestamp,
      signature: from + '|' + timestamp + '|' + text
    });
  }
  return messages;
}
