// End-to-end test of the web client against the real server, driven in Chromium by Playwright.
// Playwright is not a project dependency. Install it (or point NODE_PATH at a global install) and run: npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const { chromium } = createRequire(import.meta.url)('playwright');

// A valid 1x1 PNG, used to exercise image upload end to end.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SECRET = 'e2e-secret-e2e-secret-e2e-secret-1234';
const run = Date.now().toString(36).slice(-5);
const names = { alice: `alice_${run}`, bob: `bob_${run}` };

let server, db, browser, base;
const problems = []; // every console error, page error and failed request from any page

before(async () => {
  db = openDb(':memory:');
  const app = createApp({
    db,
    secret: SECRET,
    staticDir: fileURLToPath(new URL('../public/', import.meta.url)),
    limits: { global: 100000, auth: 1000, write: 1000, upload: 1000 },
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});

after(async () => {
  await browser?.close();
  server?.close();
  db?.close();
});

async function newPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(9000);
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${label} console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => problems.push(`${label} requestfailed: ${r.url()} (${r.failure() && r.failure().errorText})`));
  await page.goto(base + '/');
  return page;
}

async function register(page, username, displayName) {
  await page.click('#a-switch');
  await page.fill('#a-user', username);
  await page.fill('#a-name', displayName);
  await page.fill('#a-pass', 'correct horse battery');
  await page.click('#a-submit');
  await page.locator('#composer').waitFor();
}

const nav = (page, key) => page.click(`.nav-btn[data-key="${key}"]`);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
let alice, bob;

test('signing up lands on the home feed, and bad input is explained', async () => {
  alice = await newPage('alice');
  await alice.click('#a-switch');
  await alice.fill('#a-user', 'ab');
  await alice.fill('#a-pass', 'correct horse battery');
  await alice.click('#a-submit');
  assert.match(await alice.locator('#a-err').innerText(), /3 to 20/);
  await alice.fill('#a-user', names.alice);
  await alice.fill('#a-pass', 'short');
  await alice.click('#a-submit');
  assert.match(await alice.locator('#a-err').innerText(), /8 characters/);
  await alice.fill('#a-name', 'Alice Doe');
  await alice.fill('#a-pass', 'correct horse battery');
  await alice.click('#a-submit');
  await alice.locator('#composer').waitFor();
  assert.ok(await noOverflow(alice), 'home has horizontal overflow at 400px');
});

test('text post with a tag, poll with a vote, and a photo post', async () => {
  await alice.fill('#ctext', 'hello plaza #firstpost');
  await alice.click('#cpost');
  await alice.locator('.post:has-text("hello plaza")').waitFor();
  assert.equal(await alice.locator('.post:has-text("hello plaza") .tag').innerText(), '#firstpost');

  await alice.click('#cpoll');
  await alice.fill('#ctext', 'Tabs or spaces?');
  await alice.fill('#po0', 'Tabs');
  await alice.fill('#po1', 'Spaces');
  await alice.click('#cpost');
  await alice.locator('.poll button.opt').first().click();
  await alice.locator('.opt.mine').waitFor();
  assert.equal(await alice.locator('.opt.mine .pc').innerText(), '100%');
  assert.equal(await alice.locator('#cpollbox').isHidden(), true, 'poll form resets after posting');

  await alice.setInputFiles('#cfile', { name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  await alice.locator('#cprev img').waitFor();
  await alice.fill('#ctext', 'a photo post');
  await alice.click('#cpost');
  const img = alice.locator('.post:has-text("a photo post") img.pimg');
  await img.waitFor();
  assert.match(await img.getAttribute('src'), /^\/api\/media\/\d+$/);
  await alice.waitForFunction(() => {
    const el = document.querySelector('.post img.pimg');
    return el && el.complete && el.naturalWidth > 0;
  });
});

test('stories: create, view, and close', async () => {
  await alice.click('[data-a="addstory"]');
  await alice.fill('#stext', 'Coffee first');
  await alice.click('.sw.c1');
  await alice.click('#sc button[type="submit"]');
  const ring = alice.locator('.story[data-a="story"]');
  await ring.waitFor();
  await ring.click();
  await alice.locator('#sv:not([hidden]) .svbody p:has-text("Coffee first")').waitFor();
  await alice.keyboard.press('Escape');
  await alice.locator('#sv[hidden]').waitFor({ state: 'attached' });
  assert.ok(await alice.locator('.ring.seen').count(), 'ring is marked seen after viewing');
});

test('communities: create, post inside, and chat', async () => {
  await nav(alice, 'rooms');
  await alice.click('[data-a="newcomm"]');
  await alice.fill('#cname', `Night Owls ${run}`);
  await alice.fill('#cdesc', 'Late builders');
  await alice.click('form[data-form="newcomm"] button[type="submit"]');
  await alice.locator('.chead h2').waitFor();
  await alice.fill('#ctext', 'first post inside the room');
  await alice.click('#cpost');
  await alice.locator('.post:has-text("first post inside the room")').waitFor();
  await alice.click('[data-a="ctab"][data-id="chat"]');
  await alice.fill('#chatin', 'anyone here?');
  await alice.press('#chatin', 'Enter');
  await alice.locator('.bubble:has-text("anyone here?")').waitFor();
  assert.ok(await noOverflow(alice), 'community has horizontal overflow at 400px');
});

test('a second user interacts: like, repost, save, reply, follow, message', async () => {
  bob = await newPage('bob');
  await register(bob, names.bob, 'Bob Ray');
  const post = bob.locator('.post:has-text("hello plaza")');
  await post.waitFor();
  await post.locator('.act.like').click();
  await bob.locator('.post:has-text("hello plaza") .act.like.on').waitFor();
  await post.locator('.act.rp').click();
  await bob.locator('.post:has-text("hello plaza") .act.rp.on').waitFor();
  await post.locator('.act.bm').click();
  await bob.locator('.post:has-text("hello plaza") .act.bm.on').waitFor();
  await post.locator('.act[data-a="comments"]').click();
  await bob.fill('.cin', 'welcome!');
  await bob.press('.cin', 'Enter');
  await bob.locator('.cmt:has-text("welcome!")').waitFor();

  await post.locator('.name').first().click();
  await bob.locator('.phead').waitFor();
  await bob.click('[data-a="follow"]');
  await bob.locator('[data-a="follow"]:has-text("Following")').waitFor();
  await bob.click('.pact [data-a="path"]');
  await bob.fill('#dmin', 'hi alice, nice post');
  await bob.press('#dmin', 'Enter');
  await bob.locator('.msg.me .bubble:has-text("hi alice")').waitFor();
});

test('the first user sees badges and alerts, and the thread updates live', async () => {
  await alice.reload(); // badges refresh when the app opens and every 20 seconds
  await alice.locator('#nb-alerts:not([hidden])').waitFor();
  await alice.locator('#nb-inbox:not([hidden])').waitFor();
  await nav(alice, 'alerts');
  await alice.locator('.alert.new').first().waitFor();
  const text = await alice.locator('#main').innerText();
  for (const phrase of ['liked your post', 'reposted your post', 'replied to your post', 'followed you']) {
    assert.ok(text.includes(phrase), `alerts should include "${phrase}"`);
  }
  assert.equal(await alice.locator('#nb-alerts').isHidden(), true, 'alerts badge clears on the alerts page');

  await nav(alice, 'inbox');
  await alice.locator('.dm-row:has-text("Bob Ray")').click();
  await alice.locator('.bubble:has-text("hi alice")').waitFor();
  await alice.fill('#dmin', 'thanks bob');
  await alice.press('#dmin', 'Enter');
  // Bob has the thread open and receives the reply through polling (every 3 seconds).
  await bob.locator('.msg:not(.me) .bubble:has-text("thanks bob")').waitFor({ timeout: 10000 });
  assert.ok(await noOverflow(bob));
});

test('chat is members-only and updates live for members', async () => {
  await nav(alice, 'rooms');
  await alice.locator(`.crow2:has-text("Night Owls ${run}")`).locator('.name').click();
  await alice.click('[data-a="ctab"][data-id="chat"]');
  await alice.locator('#chatbox').waitFor();

  await nav(bob, 'rooms');
  await bob.locator(`.crow2:has-text("Night Owls ${run}")`).locator('.name').click();
  await bob.click('[data-a="ctab"][data-id="chat"]');
  await bob.locator('.empty:has-text("Chat is for members")').waitFor();
  await bob.click('.chead [data-a="join"]');
  await bob.locator('#chatin').waitFor();
  await bob.fill('#chatin', 'bob joined');
  await bob.press('#chatin', 'Enter');
  await alice.locator('.msg:not(.me) .bubble:has-text("bob joined")').waitFor({ timeout: 10000 });
});

test('saved posts are listed privately on the profile', async () => {
  await nav(bob, 'me');
  await bob.click('[data-a="ptab"][data-id="saved"]');
  await bob.locator('.post:has-text("hello plaza")').waitFor();
  await nav(alice, 'me');
  await alice.click('[data-a="ptab"][data-id="saved"]');
  await alice.locator('.empty:has-text("Nothing saved yet")').waitFor();
});

test('explore finds people, communities, posts and tags', async () => {
  await nav(alice, 'explore');
  // Scoped to #main: on wide screens the side column lists some of the same people.
  await alice.fill('#q', 'bob');
  await alice.locator('#main .prow:has-text("Bob Ray")').waitFor();
  await alice.fill('#q', '#firstpost');
  await alice.locator('#main .post:has-text("hello plaza")').waitFor();
  await alice.fill('#q', 'night owls');
  await alice.locator(`#main .crow2:has-text("Night Owls ${run}")`).waitFor();
});

test('post text is shown literally and never runs as markup', async () => {
  await nav(alice, 'home');
  const evil = '<img src=x onerror="window.__xss=1"> <script>window.__xss=1</script> & "quotes"';
  await alice.fill('#ctext', evil.slice(0, 280));
  await alice.click('#cpost');
  await alice.locator('.post:has-text("onerror")').first().waitFor();
  await bob.reload(); // a reload keeps the current route, so go back to the feed explicitly
  await nav(bob, 'home');
  await bob.locator('.post:has-text("onerror")').first().waitFor();
  assert.equal(await bob.locator('.post img[src="x"]').count(), 0);
  assert.equal(await bob.evaluate(() => window.__xss), undefined);
  assert.equal(await alice.evaluate(() => window.__xss), undefined);
});

test('logging out clears the session', async () => {
  await nav(alice, 'me');
  await alice.click('[data-a="logout"]');
  await alice.locator('#auth').waitFor();
  assert.equal(await alice.evaluate(() => localStorage.getItem('plaza.token')), null);
  await alice.reload();
  await alice.locator('#auth').waitFor();
  assert.equal(await alice.locator('#app').isHidden(), true);
  await alice.fill('#a-user', names.alice);
  await alice.fill('#a-pass', 'wrong password here');
  const before = problems.length;
  await alice.click('#a-submit');
  await alice.locator('#a-err:has-text("Wrong username or password")').waitFor();
  // Chrome logs every 401 to the console. This one is the expected result of the wrong password above,
  // so claim exactly that entry and assert it happened. Anything else still fails the final check.
  const expected = problems.findIndex((p, i) => i >= before && /^alice console: Failed to load resource.*401/.test(p));
  assert.notEqual(expected, -1, 'the wrong-password login should have been answered with 401');
  problems.splice(expected, 1);
  assert.equal(await alice.evaluate(() => localStorage.getItem('plaza.token')), null, 'a failed login stores no token');
});

test('desktop layout shows the side columns without overflow', async () => {
  await bob.setViewportSize({ width: 1200, height: 800 });
  await nav(bob, 'home');
  await bob.locator('.rail .nav').waitFor();
  assert.ok(await bob.locator('#aside').isVisible());
  assert.ok(await noOverflow(bob));
});

test('no console errors, page errors, CSP violations or failed requests happened', () => {
  assert.deepEqual(problems, []);
});
