// node test/browser.test.mjs  — drives the real page against the Worker under Node.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const out = process.env.SHOTS || '/tmp';
const { server, fakes } = await startServer({ port: 8787 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });

await page.goto('http://localhost:8787/');
await page.waitForSelector('#registerPanel', { state: 'visible' });
await page.screenshot({ path: `${out}/1-register.png` });

// Register
await page.click('#registerBtn');
assert.match(await page.textContent('#loginError'), /name and choose your machine/);
await page.fill('#regName', 'Anna');
await page.selectOption('#regMachine', 'Linux (AppImage)');
await page.fill('#regOS', 'Ubuntu 24.04');
await page.fill('#regNetwork', 'seed: alpha1-test\nDNA: uhC0k...');
await page.click('#registerBtn');
await page.waitForSelector('#app', { state: 'visible' });
assert.match(await page.textContent('#headerTitle'), /v0\.6\.0-alpha\.1/);
assert.equal(await page.locator('.step-card').count(), 50);

// Pass a step
await page.click('#step-1_2 [data-result="Pass"]');
await page.waitForTimeout(150);

// Fail 13.2: report opens with the step's own text
await page.fill('#notes-13_2', 'The Approve button did nothing');
await page.click('#step-13_2 [data-result="Fail"]');
await page.waitForSelector('#reportModal.show');
assert.equal(await page.inputValue('#fHappened'), 'The Approve button did nothing');
assert.equal(await page.inputValue('#fNetwork'), 'seed: alpha1-test\nDNA: uhC0k...');

// Missing screen is refused inline (no browser alert)
await page.click('#submitBtn');
assert.match(await page.textContent('#reportError'), /screen you were on/);

// Screenshot: use a real PNG, with a fake EXIF-bearing name doesn't matter, re-encoded as JPEG
await page.screenshot({ path: `${out}/sample.png` });
await page.fill('#fScreen', 'Admin Dashboard, Pending Users');
await page.setInputFiles('#fShots', `${out}/sample.png`);
await page.waitForSelector('.shot-thumb .shot-state:has-text("Ready")');
await page.screenshot({ path: `${out}/2-report.png` });
await page.click('#submitBtn');
await page.waitForSelector('#reportDone.show');
assert.match(await page.textContent('#reportDone'), /Posted/);

const d = fakes.discussions[0];
assert.match(d.title, /^\[v0\.6\.0-alpha\.1\] 13\.2 · /);
assert.ok(/!\[Screenshot 1\]\(https:\/\/raw\.githubusercontent\.com\/.+\/step-13\.2-\d+\.jpg\)/.test(d.body), 'screenshot uploaded as JPEG and embedded');
const shotPath = [...fakes.files.keys()].find((k) => k.includes('/screenshots/'));
const jpg = Buffer.from(fakes.files.get(shotPath).content, 'base64');
assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8);
assert.ok(!jpg.includes(Buffer.from('Exif')), 'no EXIF block');

await page.click('#cancelBtn');
assert.ok(await page.isVisible('#link-13_2.show'));

// Ad hoc report from the bug button
await page.click('#fabBug');
await page.fill('#fSummary', 'Links field keeps a deleted website');
await page.fill('#fScreen', 'Create a request');
await page.fill('#fHappened', 'Deleted link came back after Save');
await page.click('#submitBtn');
await page.waitForSelector('#reportDone.show');
await page.click('#cancelBtn');
assert.equal(fakes.discussions.length, 2);

// Reload: same person comes straight back to their results
await page.reload();
await page.waitForSelector('#app', { state: 'visible' });
assert.ok(await page.locator('#step-13_2 .active-fail').count() === 1);
assert.ok(await page.locator('#step-1_2 .active-pass').count() === 1);
assert.ok(await page.isVisible('#link-13_2.show'));
assert.equal(await page.inputValue('#notes-13_2'), 'The Approve button did nothing');
await page.screenshot({ path: `${out}/3-app.png` });

// Phone width: no sideways scrolling
await page.setViewportSize({ width: 375, height: 800 });
await page.click('#step-14_1 [data-result="Partial"]');
await page.waitForSelector('#reportModal.show');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
await page.screenshot({ path: `${out}/4-phone.png`, fullPage: false });
assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);

assert.deepEqual(errors, []);
console.log('browser flow: all checks passed');
console.log('requests to GitHub:', fakes.log.length, '| files:', fakes.files.size, '| discussions:', fakes.discussions.length);
await browser.close();
server.close();
