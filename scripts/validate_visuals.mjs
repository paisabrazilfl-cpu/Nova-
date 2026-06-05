import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:4173';
const pages = [
  '/',
  '/confidential-case-review/',
  '/survivor-resources/',
  '/rideshare-sexual-abuse/',
  '/rideshare-sexual-assault/',
  '/legal-options-after-rideshare-assault/',
  '/mass-tort-information/',
  '/faq/',
  '/contact/',
  '/privacy-policy/',
  '/disclaimer/',
];
const viewports = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '430x932', width: 430, height: 932 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '820x1180', width: 820, height: 1180 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const screenshotViewports = new Set(['390x844', '820x1180', '1366x768']);
const outDir = '/mnt/user-data/outputs/visual-validation';
fs.mkdirSync(outDir, { recursive: true });

function slugify(route) {
  if (route === '/') return 'home';
  return route.replace(/^\//, '').replace(/\/$/, '').replace(/[^a-z0-9-]+/gi, '-');
}

const browser = await chromium.launch({ headless: true });
const report = {
  base,
  pagesChecked: [],
  screenshots: [],
  issues: [],
  networkFailures: [],
  consoleErrors: [],
  summary: {
    totalPages: pages.length,
    totalViewportChecks: pages.length * viewports.length,
    brokenImages: 0,
    pagesWithHorizontalScroll: 0,
    missingAltCount: 0,
    zeroDimensionImages: 0,
  },
};

for (const vp of viewports) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  const networkFailures = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('requestfailed', req => {
    networkFailures.push({ url: req.url(), error: req.failure()?.errorText || 'failed' });
  });

  for (const route of pages) {
    const name = slugify(route);
    const url = new URL(route, base).toString();
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 300));
      window.scrollTo(0, 0);
    });

    const audit = await page.evaluate(() => {
      const images = [...document.images].map(img => {
        const rect = img.getBoundingClientRect();
        const alt = img.getAttribute('alt');
        const style = window.getComputedStyle(img);
        return {
          src: img.currentSrc || img.src,
          alt,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          width: rect.width,
          height: rect.height,
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          overflowsX: rect.right > window.innerWidth + 1 || rect.left < -1,
        };
      });
      const bgNodes = [...document.querySelectorAll('*')]
        .filter(el => {
          const bg = window.getComputedStyle(el).backgroundImage;
          return bg && bg !== 'none';
        })
        .slice(0, 30)
        .map(el => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            className: el.className,
            width: rect.width,
            height: rect.height,
            visible: rect.width > 0 && rect.height > 0,
          };
        });
      const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      const clientWidth = document.documentElement.clientWidth;
      const hero = document.querySelector('.hero-card');
      const heroRect = hero ? hero.getBoundingClientRect() : null;
      return {
        title: document.title,
        imageCount: images.length,
        images,
        bgCount: bgNodes.length,
        bgNodes,
        horizontalScroll: scrollWidth > clientWidth + 1,
        scrollWidth,
        clientWidth,
        hero: heroRect ? { width: heroRect.width, height: heroRect.height } : null,
      };
    });

    const entry = {
      route,
      viewport: vp.name,
      status: response?.status() || 0,
      title: audit.title,
      imageCount: audit.imageCount,
      backgroundSections: audit.bgCount,
      horizontalScroll: audit.horizontalScroll,
      missingAlt: audit.images.filter(i => i.alt === null || i.alt === undefined).length,
      zeroDimensionImages: audit.images.filter(i => i.naturalWidth <= 0 || i.naturalHeight <= 0 || i.width <= 0 || i.height <= 0).length,
      overflowingImages: audit.images.filter(i => i.overflowsX).length,
      hero: audit.hero,
      consoleErrors: [...consoleErrors],
      networkFailures: [...networkFailures],
    };
    report.pagesChecked.push(entry);

    report.summary.missingAltCount += entry.missingAlt;
    report.summary.zeroDimensionImages += entry.zeroDimensionImages;
    if (entry.horizontalScroll) report.summary.pagesWithHorizontalScroll += 1;
    if (entry.zeroDimensionImages > 0) report.summary.brokenImages += entry.zeroDimensionImages;
    if (entry.consoleErrors.length) report.consoleErrors.push({ route, viewport: vp.name, errors: [...entry.consoleErrors] });
    if (entry.networkFailures.length) report.networkFailures.push({ route, viewport: vp.name, errors: [...entry.networkFailures] });

    if (entry.status >= 400 || entry.horizontalScroll || entry.zeroDimensionImages > 0 || entry.overflowingImages > 0 || entry.missingAlt > 0) {
      report.issues.push(entry);
    }

    if (screenshotViewports.has(vp.name)) {
      const shot = path.join(outDir, `${name}-${vp.name}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      report.screenshots.push({ route, viewport: vp.name, path: shot });
    }

    consoleErrors.length = 0;
    networkFailures.length = 0;
  }

  await context.close();
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

const lines = [];
lines.push('# Visual validation report');
lines.push('');
lines.push(`Base URL: ${base}`);
lines.push('');
lines.push('## Pages checked');
for (const route of pages) lines.push(`- ${route}`);
lines.push('');
lines.push('## Viewports checked');
for (const vp of viewports) lines.push(`- ${vp.name}`);
lines.push('');
lines.push('## Summary');
lines.push(`- Total page checks: ${report.summary.totalViewportChecks}`);
lines.push(`- Broken images: ${report.summary.brokenImages}`);
lines.push(`- Missing alt count: ${report.summary.missingAltCount}`);
lines.push(`- Horizontal scroll incidents: ${report.summary.pagesWithHorizontalScroll}`);
lines.push(`- Console error groups: ${report.consoleErrors.length}`);
lines.push(`- Network failure groups: ${report.networkFailures.length}`);
lines.push('');
lines.push('## Representative screenshots');
for (const shot of report.screenshots.slice(0, 33)) lines.push(`- ${shot.route} @ ${shot.viewport}: ${shot.path}`);
lines.push('');
lines.push('## Issues');
if (!report.issues.length) {
  lines.push('- No blocking issues detected in automated Playwright validation.');
} else {
  for (const issue of report.issues) {
    lines.push(`- ${issue.route} @ ${issue.viewport}: status ${issue.status}, horizontalScroll=${issue.horizontalScroll}, missingAlt=${issue.missingAlt}, zeroDimensionImages=${issue.zeroDimensionImages}, overflowingImages=${issue.overflowingImages}`);
  }
}
fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'));
console.log(`Wrote ${path.join(outDir, 'report.json')}`);
console.log(`Wrote ${path.join(outDir, 'report.md')}`);
await browser.close();
