/**
 * Browser check — the gate the unit tests cannot be.
 *
 * The tests in tests/ exercise a state machine extracted out of the DOM, which is
 * fast and deterministic but blind to one whole class of defect: the page and the
 * data disagreeing. That is not hypothetical. This check is what caught
 * content/card-template.html and content/shell.html having drifted apart — the
 * aria-hidden fix and the provenance footer were reaching dist/deck.json while
 * the actual page still rendered the old markup and said "Press to flip".
 *
 * NOT a project dependency (NFR-1: zero dependencies). Playwright is resolved
 * from outside the repo, so this is a dev-time check rather than part of
 * `npm run check`:
 *
 *   PLAYWRIGHT_PATH=~/.kiro/skills/browser-automation/node_modules/playwright \
 *     node tools/browser-check.mjs dist/agentcore-flashcards.html /tmp/out
 *
 * Exits non-zero on any failed assertion.
 */

import { mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Resolve Playwright from outside the repo. A bare specifier works when it is
 * installed somewhere Node can see; a path needs to become a file URL, and a
 * directory needs its entry point appended, because dynamic import does not do
 * package resolution on filesystem paths.
 */
function playwrightSpecifier() {
  const p = process.env.PLAYWRIGHT_PATH;
  if (!p) return 'playwright';
  const expanded = p.startsWith('~') ? join(process.env.HOME ?? '', p.slice(1)) : p;
  const abs = resolve(expanded);
  for (const candidate of [abs, join(abs, 'index.js'), join(abs, 'index.mjs')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return pathToFileURL(candidate).href;
  }
  return pathToFileURL(abs).href;
}

let chromium;
try {
  // Playwright's entry point is CommonJS, so when imported by file URL its named
  // exports arrive under `default` rather than as top-level bindings.
  const mod = await import(playwrightSpecifier());
  chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error('module loaded but exposes no `chromium` export');
} catch (e) {
  console.error(
    `browser-check: could not import Playwright (${(e).message}).\n` +
      'Playwright is deliberately NOT a dependency of this project. Point PLAYWRIGHT_PATH at an\n' +
      'existing install, e.g.:\n' +
      '  PLAYWRIGHT_PATH=~/.kiro/skills/browser-automation/node_modules/playwright \\\n' +
      '    node tools/browser-check.mjs dist/agentcore-flashcards.html',
  );
  process.exit(2);
}

const file = resolve(process.argv[2] ?? 'dist/agentcore-flashcards.html');
const out = process.argv[3] ?? '/tmp/flashcards-browser-check';
mkdirSync(out, { recursive: true });

let failures = 0;
const errors = [];
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
};

/** Walk the deck until the front face shows the wanted card id. */
async function goTo(page, cardId) {
  for (let i = 0; i < 40; i++) {
    const partno = await page.textContent('.front .partno').catch(() => '');
    if (partno.includes(cardId)) return true;
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(40);
  }
  return false;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 460, height: 940 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`file://${file}`, { waitUntil: 'load' });
  await page.waitForSelector('#card');

  console.log('\n[header — derived, never hand-maintained]');
  const meta = await page.$$eval('.meta span', (e) => e.map((x) => x.textContent.trim()));
  const sub = await page.textContent('.sub');
  console.log('  meta:', meta.join(' | '));
  ok('region count comes from the fact store', meta.some((m) => /^REGIONS \d+$/.test(m)), meta.join(','));
  ok('Sydney availability comes from the fact store', meta.some((m) => /^SYD REGION (YES|NO)$/.test(m)));
  ok('a verification date is shown', meta.some((m) => /^VERIFIED /.test(m)));
  ok('no hand-maintained "current to" claim', !/current to/i.test(sub), sub.slice(0, 80));
  ok('no unsourced GA-date badge', !meta.some((m) => /^GA /.test(m)));

  console.log('\n[accessibility — exactly one face exposed at a time]');
  const faceState = () => page.$eval('#card', (c) => ({
    front: c.querySelector('.face.front').getAttribute('aria-hidden'),
    back: c.querySelector('.face.back').getAttribute('aria-hidden'),
    pressed: c.getAttribute('aria-pressed'),
    label: c.getAttribute('aria-label'),
  }));
  let s = await faceState();
  ok('front exposed, back hidden on first paint', s.front === 'false' && s.back === 'true', JSON.stringify(s));
  ok('aria-pressed is false unflipped', s.pressed === 'false');
  ok('label names the visible side', /Showing the question/.test(s.label), s.label);

  await page.click('#flipBtn');
  await page.waitForTimeout(650);
  s = await faceState();
  ok('front hidden, back exposed after flip', s.front === 'true' && s.back === 'false', JSON.stringify(s));
  ok('aria-pressed is true flipped', s.pressed === 'true');
  ok('label updated to the detail side', /Showing detail/.test(s.label), s.label);

  const readable = await page.$eval('#card', (c) =>
    [...c.querySelectorAll('.face')]
      .filter((f) => f.getAttribute('aria-hidden') === 'false')
      .map((f) => f.innerText.replace(/\s+/g, ' ').trim().slice(0, 70)),
  );
  ok('a screen reader sees exactly one face', readable.length === 1, `${readable.length} exposed`);

  console.log('\n[provenance footer — FR-11]');
  ok('AC-19 is reachable', await goTo(page, 'AC-19'));
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(650);
  const prov = await page.$eval('.back .prov', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  ok('a verified card shows its verification date', Boolean(prov && /verified/i.test(prov)), prov ?? 'no footer');
  ok('a verified card names its source', Boolean(prov && /source/i.test(prov)), prov ?? 'no footer');
  if (prov) console.log('  AC-19:', prov);
  // Regression guard for the clipping bug: the footer must be inside the card box.
  const clipped = await page.$eval('#card', (c) => {
    const p = c.querySelector('.back .prov');
    if (!p) return true;
    return p.getBoundingClientRect().bottom > c.getBoundingClientRect().bottom + 1;
  });
  ok('the footer is not clipped by a fixed card height', !clipped);
  await page.screenshot({ path: `${out}/verified-card.png` });

  console.log('\n[the deliberately unverifiable card]');
  await page.click('.chip:nth-child(1)');
  await page.waitForTimeout(150);
  ok('AC-12 is reachable', await goTo(page, 'AC-12'));
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(650);
  const prov12 = await page.$eval('.back .prov', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  ok('it is labelled Unverified rather than looking checked',
    Boolean(prov12 && /unverified/i.test(prov12)), prov12 ?? 'no footer');
  ok('it states WHY it cannot be verified',
    Boolean(prov12 && /no deterministic source/i.test(prov12)), prov12 ?? 'no footer');
  if (prov12) console.log('  AC-12:', prov12);
  await page.screenshot({ path: `${out}/unverified-card.png` });

  console.log('\n[behaviour regression]');
  await page.click('.chip:nth-child(3)');
  await page.waitForTimeout(150);
  const filtered = (await page.textContent('#count')).trim();
  ok('category filter narrows the deck', /^1 \/ \d+$/.test(filtered) && filtered !== '1 / 21', filtered);
  await page.click('.chip:nth-child(1)');
  await page.waitForTimeout(150);
  const all = (await page.textContent('#count')).trim();
  ok('All restores the full deck', /^1 \/ \d+$/.test(all));
  await page.click('#shufBtn');
  await page.waitForTimeout(150);
  ok('shuffle preserves the deck size', (await page.textContent('#count')).trim() === all);

  ok('no console or page errors', errors.length === 0, errors.join(' | '));
  console.log(`\nbrowser-check: ${failures === 0 ? 'PASS' : `FAIL (${failures})`} · screenshots in ${out}`);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
