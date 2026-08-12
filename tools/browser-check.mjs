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
 *     node tools/browser-check.mjs dist/aws-ai-native-development-flashcards.html /tmp/out
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
      '    node tools/browser-check.mjs dist/aws-ai-native-development-flashcards.html',
  );
  process.exit(2);
}

/**
 * TWO TARGETS, ONE SUITE.
 *
 * A local path checks the artefact the gate just built. An http(s) URL checks the
 * artefact a LEARNER actually receives, which is a different claim: publish proves
 * byte-identity at the edge, and byte-identity says nothing about whether the page
 * runs. A CSP header, a MIME type, or a CloudFront behaviour can serve exactly the
 * right bytes and still break the app.
 *
 * `new URL(...).href` rather than the raw string, so an origin with no path becomes
 * `https://host/` and `${TARGET}#/card/x` produces the same shape the file form
 * does instead of `https://host#/card/x`.
 */
const arg = process.argv[2] ?? 'dist/aws-ai-native-development-flashcards.html';
const isUrl = /^https?:\/\//i.test(arg);
const TARGET = isUrl ? new URL(arg).href : `file://${resolve(arg)}`;
const out = process.argv[3] ?? '/tmp/flashcards-browser-check';
mkdirSync(out, { recursive: true });
console.log(`browser-check: ${isUrl ? 'LIVE' : 'local'} target — ${TARGET}`);

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
  await page.goto(TARGET, { waitUntil: 'load' });
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
  ok('the hidden face is inert, so its links are not tabbable',
    await page.$eval('#card', (c) => [...c.querySelectorAll('.face')]
      .filter((f) => f.getAttribute('aria-hidden') === 'true').every((f) => f.inert === true)),
    'aria-hidden without inert still leaves the face in the tab order');

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

  console.log('\n[the card that used to be unverifiable]');
  // AC-12's Evaluations region count could not be verified from service-level
  // SSM data. A feature x region docs matrix now settles it, so this card should
  // show a real citation — and the number should be 16, not the stale 9.
  await page.click('.chip:nth-child(1)');
  await page.waitForTimeout(150);
  ok('AC-12 is reachable', await goTo(page, 'AC-12'));
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(650);
  const back12 = await page.$eval('.back', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  const prov12 = await page.$eval('.back .prov', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  ok('the stale region count is gone', Boolean(back12 && !/\b9 regions\b/.test(back12)), back12?.slice(0, 90) ?? 'no back face');
  ok('it shows the corrected count from the docs matrix', Boolean(back12 && /16 regions/.test(back12)), back12?.slice(0, 90) ?? 'no back face');
  ok('it now carries a verification date and source', Boolean(prov12 && /verified/i.test(prov12) && /source/i.test(prov12)), prov12 ?? 'no footer');
  if (prov12) console.log('  AC-12:', prov12);
  await page.screenshot({ path: `${out}/corrected-card.png` });

  console.log('\n[the permanently unsourced card]');
  // QK-02 is a positioning judgement. No document can settle it, so it must never
  // look verified — this is the case AC-12 used to cover.
  ok('QK-02 is reachable', await goTo(page, 'QK-02'));
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(650);
  const provQk = await page.$eval('.back .prov', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  ok('it is not labelled Verified', Boolean(provQk && !/verified/i.test(provQk)), provQk ?? 'no footer');
  ok('it says it is unsourced and why', Boolean(provQk && /unsourced|unverified/i.test(provQk) && /no deterministic source/i.test(provQk)), provQk ?? 'no footer');
  if (provQk) console.log('  QK-02:', provQk);
  await page.screenshot({ path: `${out}/unsourced-card.png` });

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

  console.log('\n[search]');
  const q = await page.$('#q');
  ok('a search input exists', Boolean(q));
  await page.fill('#q', 'gateway');
  await page.waitForTimeout(300);
  const searchCount = (await page.textContent('#count')).trim();
  const firstHit = (await page.textContent('.front .partno')).trim();
  ok('search narrows the deck', /^1 \/ \d+$/.test(searchCount) && searchCount !== all, searchCount);
  ok('the best match ranks first', firstHit.includes('AC-06'), firstHit);
  ok('the URL carries the query', /q=gateway/.test(page.url()), page.url().split('#')[1] ?? '');

  await page.fill('#q', 'kubernetes helm');
  await page.waitForTimeout(300);
  const emptyText = await page.textContent('.empty').catch(() => '');
  ok('a no-match search shows an empty state, not a broken card', /No cards match/.test(emptyText), emptyText.slice(0, 60));
  ok('the empty state offers a way out', Boolean(await page.$('#resetBtn')));
  await page.click('#resetBtn');
  await page.waitForTimeout(250);
  ok('clearing filters restores the deck', (await page.textContent('#count')).trim() === all);

  await page.fill('#q', 'pricing');
  await page.waitForTimeout(300);
  await page.click('#qClear');
  await page.waitForTimeout(250);
  ok('the clear button resets the search', (await page.textContent('#count')).trim() === all);

  console.log('\n[a renamed card answers to its old name]');
  // AC-14 was retitled "Agent Registry" -> "AWS Agent Registry" from two AWS docs
  // sources. A learner who memorised the old name must still be able to find it,
  // and a link someone shared under the old name must still land.
  await page.fill('#q', 'Agent Registry');
  await page.waitForTimeout(300);
  const renamedHit = (await page.textContent('.front .partno').catch(() => '')).trim();
  ok('searching the OLD name finds the card', renamedHit.includes('AC-14'), renamedHit || 'no card shown');
  const renamedTitle = (await page.textContent('.front h2').catch(() => '')).trim();
  ok('the card shows its NEW name', /AWS Agent Registry/.test(renamedTitle), renamedTitle);
  await page.click('#qClear');
  await page.waitForTimeout(250);

  await page.goto(`${TARGET}#/card/agent-registry`);
  await page.waitForTimeout(400);
  const aliasLanded = (await page.textContent('.front .partno').catch(() => '')).trim();
  ok('a deep link naming the old name still resolves', aliasLanded.includes('AC-14'), aliasLanded || 'no card shown');
  await page.goto(TARGET);
  await page.waitForTimeout(400);

  console.log('\n[keyboard does not fight the search box]');
  await page.click('#q');
  await page.type('#q', 'gate');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  const stillTyping = await page.inputValue('#q');
  ok('ArrowRight inside the input does not navigate the deck', stillTyping === 'gate', `input is "${stillTyping}"`);
  await page.fill('#q', '');
  await page.waitForTimeout(250);
  await page.click('body');
  await page.keyboard.press('/');
  await page.waitForTimeout(150);
  const focused = await page.evaluate(() => document.activeElement?.id);
  ok('"/" focuses the search box', focused === 'q', `focus is on "${focused}"`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  console.log('\n[tag filtering]');
  await page.click('body');
  const tagButtons = await page.$$eval('.tag', (e) => e.map((x) => x.textContent.trim()));
  ok('tags are derived and rendered', tagButtons.length > 0, `${tagButtons.length} tags`);
  ok('tags show a card count', /\d$/.test(tagButtons[0] ?? ''), tagButtons[0] ?? '');

  // The list is folded to the most common tags; expand it so any tag is clickable.
  const more = await page.$('.tagsMore');
  if (more) {
    await more.click();
    await page.waitForTimeout(150);
    const expanded = await page.$$eval('.tag', (e) => e.length);
    ok('the tag list expands', expanded > tagButtons.length, `${tagButtons.length} → ${expanded}`);
  }

  // Pick a tag that actually narrows: its count must be below the deck size.
  const total = Number(all.split('/')[1].trim());
  const narrowing = await page.$$eval('.tag', (els, t) => {
    const hit = els.find((e) => {
      const n = Number(e.querySelector('i')?.textContent ?? '0');
      return n > 0 && n < t;
    });
    return hit ? hit.querySelector('i').previousSibling?.textContent?.trim() ?? hit.textContent.trim() : null;
  }, total);
  ok('at least one tag narrows the deck', Boolean(narrowing), 'every tag covers every card');

  if (narrowing) {
    await page.$$eval('.tag', (els, want) => {
      const hit = els.find((e) => e.textContent.startsWith(want));
      if (hit) hit.click();
    }, narrowing);
    await page.waitForTimeout(250);
    const tagged = (await page.textContent('#count')).trim();
    ok(`tag "${narrowing}" narrows the deck`, /^1 \/ \d+$/.test(tagged) && tagged !== all, tagged);
    ok('the URL carries the tag', page.url().includes(`tag=${encodeURIComponent(narrowing)}`), page.url().split('#')[1] ?? '');
    ok('the active tag is marked pressed for assistive tech',
      (await page.$$eval('.tag[aria-pressed="true"]', (e) => e.length)) === 1);

    // Clicking the same tag again is the documented way to clear it.
    await page.$$eval('.tag', (els, want) => {
      const hit = els.find((e) => e.textContent.startsWith(want));
      if (hit) hit.click();
    }, narrowing);
    await page.waitForTimeout(250);
    ok('clicking an active tag clears it', (await page.textContent('#count')).trim() === all);
  }

  console.log('\n[deep links]');
  const base = page.url().split('#')[0];
  await page.goto(`${base}#/card/ac-19`, { waitUntil: 'load' });
  await page.waitForSelector('#card');
  ok('a slug deep link lands on the named card',
    (await page.textContent('.front .partno')).includes('AC-19'),
    (await page.textContent('.front .partno')).trim());
  await page.goto(`${base}#/card/ac-19?cat=core-services`, { waitUntil: 'load' });
  await page.waitForSelector('#card');
  ok('a link naming a card wins over filters that would hide it',
    (await page.textContent('.front .partno')).includes('AC-19'));
  await page.goto(`${base}#/card/ac-999`, { waitUntil: 'load' });
  await page.waitForSelector('#card');
  ok('an unknown card ref degrades to the deck, not a blank page',
    (await page.textContent('#count')).trim() === all, (await page.textContent('#count')).trim());
  await page.goto(`${base}#/?q=memory&tag=agentcore`, { waitUntil: 'load' });
  await page.waitForSelector('#card');
  ok('a link restores search and tag state', (await page.inputValue('#q')) === 'memory');

  console.log('\n[spaced repetition]');
  await page.goto(TARGET, { waitUntil: 'load' });
  await page.waitForSelector('#card');
  const stats = () => page.$eval('#studyStats', (e) => e.innerText.replace(/\s+/g, ' ').trim());
  // Derived from the header, because the deck grows and these assertions are not
  // about its size.
  const deckSize = Number((await page.$$eval('.meta span', (e) => e.map((x) => x.textContent)))
    .map((s) => /CARDS\s+(\d+)/.exec(s)?.[1]).find(Boolean));
  console.log('  stats:', await stats(), `(deck size ${deckSize})`);
  ok('a fresh learner sees every card as new', new RegExp(`NEW ${deckSize}\\b`).test(await stats()), await stats());

  await page.click('#studyBtn');
  await page.waitForTimeout(300);
  ok('study mode is a pressed toggle', (await page.getAttribute('#studyBtn', 'aria-pressed')) === 'true');
  /* The real invariant is not "grade buttons absent" but "nothing on the hidden
     face is reachable". Focusable content inside aria-hidden is an a11y
     violation, and it would let a keyboard user grade a card unseen. */
  const reachableOnHidden = () => page.$eval('#card', (c) => {
    const hidden = [...c.querySelectorAll('.face')].filter((f) => f.getAttribute('aria-hidden') === 'true');
    const sel = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
    return hidden.flatMap((f) => (f.inert ? [] : [...f.querySelectorAll(sel)])).length;
  });
  ok('nothing on the hidden face is keyboard-reachable', (await reachableOnHidden()) === 0,
    `${await reachableOnHidden()} focusable elements on the hidden face`);

  await page.click('#flipBtn');
  await page.waitForTimeout(650);
  const gradeLabels = await page.$$eval('.grades button', (e) => e.map((x) => x.textContent.replace(/\d$/, '').trim()));
  ok('four grade buttons appear on the back face', gradeLabels.length === 4, gradeLabels.join(','));
  ok('grades are labelled Again/Hard/Good/Easy',
    ['Again', 'Hard', 'Good', 'Easy'].every((l) => gradeLabels.includes(l)), gradeLabels.join(','));
  ok('the grade group is labelled for assistive tech',
    Boolean(await page.$('.grades[role="group"][aria-label]')));
  await page.screenshot({ path: `${out}/study-mode.png` });

  const beforeId = (await page.textContent('.back .partno')).trim();
  await page.click('.grades .g4');
  await page.waitForTimeout(300);
  ok('grading advances past the card', (await page.textContent('.front .partno')).trim() !== beforeId,
    `still on ${beforeId}`);
  ok('the queue count drops after grading', new RegExp(`NEW ${deckSize - 1}\\b`).test(await stats()), await stats());

  const stored = await page.evaluate(() => localStorage.getItem('aws-flashcards.progress.v1'));
  ok('progress is written to localStorage', Boolean(stored && JSON.parse(stored).reviews));
  const rec = JSON.parse(stored).reviews;
  const firstKey = Object.keys(rec)[0];
  ok('the record stores an interval, a due date and a content hash',
    rec[firstKey].interval >= 1 && Boolean(rec[firstKey].due) && Boolean(rec[firstKey].chash),
    JSON.stringify(rec[firstKey]));

  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#card');
  ok('progress survives a reload', new RegExp(`NEW ${deckSize - 1}\\b`).test(await stats()), await stats());

  console.log('\n[a corrected card is resurfaced — the point of the whole exercise]');
  // Study a card, then corrupt its stored hash to simulate a Tier A correction
  // landing after the learner had already learned it.
  await page.evaluate(() => {
    const key = 'aws-flashcards.progress.v1';
    const p = JSON.parse(localStorage.getItem(key));
    const id = Object.keys(p.reviews)[0];
    p.reviews[id].chash = 'stale-hash-0000';
    p.reviews[id].due = '2099-01-01';   // scheduled far away
    p.reviews[id].interval = 3650;
    localStorage.setItem(key, JSON.stringify(p));
    return id;
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#card');
  const s2 = await stats();
  ok('the corrected card is counted as changed', /CHANGED 1/.test(s2), s2);
  await page.click('#studyBtn');
  await page.waitForTimeout(300);
  await page.click('#flipBtn');
  await page.waitForTimeout(650);
  const warn = await page.$eval('.back .changed', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  ok('the changed card is first in the study queue', Boolean(warn), 'no .changed banner on the first queued card');
  ok('the banner explains that what they memorised is out of date',
    Boolean(warn && /out of date/i.test(warn)), warn ?? '');
  if (warn) console.log('  banner:', warn);
  ok('a 10-year interval does not suppress it', /CHANGED 1/.test(await stats()), await stats());
  await page.screenshot({ path: `${out}/changed-card.png` });

  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#card');

  console.log('\n[a card that BUILDS ON a corrected card is resurfaced too (T5.8)]');
  // Study a card that has dependencies, schedule it far out, then move one of the
  // cards it depends on. The card itself is untouched: its own claims still hold,
  // so this must read as context rather than as a correction.
  const dep = await page.evaluate(() => {
    const key = 'aws-flashcards.progress.v1';
    const dependent = DECK.find((c) => (c.deps || []).length > 0);
    const depId = dependent.deps[0];
    const fp = dependent.deps
      .slice()
      .sort()
      .map((id) => id + ':' + ((BY_ID[id] && BY_ID[id].chash) || ''))
      .join(',');
    // A record written as if the learner studied it while the deps were as they
    // are now, then scheduled a decade out.
    const p = {
      v: 1,
      reviews: {
        [dependent.id]: {
          reps: 9, lapses: 0, ease: 2.5, interval: 3650,
          due: '2099-01-01', last: '2026-01-01',
          chash: dependent.chash,
          // ...except one dependency's hash is recorded as something older.
          dhash: fp.replace(depId + ':' + ((BY_ID[depId] && BY_ID[depId].chash) || ''), depId + ':older-hash-000'),
        },
      },
    };
    localStorage.setItem(key, JSON.stringify(p));
    return { dependent: dependent.id, dependency: depId, title: BY_ID[depId] ? BY_ID[depId].t : '' };
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#card');
  const s3 = await stats();
  ok('the dependent is counted as context, not as changed',
    /CONTEXT 1/.test(s3) && !/CHANGED/.test(s3), s3);
  await page.click('#studyBtn');
  await page.waitForTimeout(300);
  await page.click('#flipBtn');
  await page.waitForTimeout(650);
  const ctx = await page.$eval('.back .context', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  ok('the context-stale card is surfaced despite a 10-year interval', Boolean(ctx), 'no .context banner');
  ok('the banner names the dependency that moved',
    Boolean(ctx && ctx.includes(dep.dependency)), ctx ?? '');
  ok('the banner does NOT claim this card is out of date',
    Boolean(ctx && !/out of date/i.test(ctx) && /still check out/i.test(ctx)), ctx ?? '');
  ok('no .changed banner is shown as well', !(await page.$('.back .changed')));
  if (ctx) console.log(`  ${dep.dependent} banner:`, ctx);
  await page.screenshot({ path: `${out}/context-card.png` });

  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#card');

  ok('no console or page errors', errors.length === 0, errors.join(' | '));
  console.log(`\nbrowser-check: ${failures === 0 ? 'PASS' : `FAIL (${failures})`} · screenshots in ${out}`);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
