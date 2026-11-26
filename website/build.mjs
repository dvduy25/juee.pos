import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const integrated = process.argv.includes('--integrated');
const output = new URL(integrated ? '../frontend/public/juee-site/' : './dist/', import.meta.url);
const app = integrated ? '' : new URL(process.env.APP_ORIGIN || 'http://localhost:3000');
if (app && (!['http:', 'https:'].includes(app.protocol) || app.username || app.password || app.pathname !== '/' || app.search || app.hash)) {
  throw new Error('APP_ORIGIN phải là địa chỉ gốc của web app, ví dụ https://app.example.com');
}

const socials = [
  { label: 'Facebook', icon: 'facebook', value: process.env.CONTACT_FACEBOOK_URL },
  { label: 'Instagram', icon: 'instagram', value: process.env.CONTACT_INSTAGRAM_URL },
];
const socialLinks = socials.filter(({ value }) => value?.trim()).map(({ label, icon, value }) => {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (url?.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`Link ${label} phải là một URL HTTPS hợp lệ.`);
  }
  const href = url.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<a href="${href}"><span data-icon="${icon}" aria-hidden="true"></span><strong>${label}</strong></a>`;
}).join('\n          ');

const template = await readFile(new URL('./src/index.html', import.meta.url), 'utf8');
const copy = JSON.parse(await readFile(new URL('./src/english.json', import.meta.url), 'utf8'));
const models = JSON.parse(await readFile(new URL('./src/models.json', import.meta.url), 'utf8'));

function english(text) {
  return Object.hasOwn(copy, text) ? copy[text] : text;
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

const englishPage = template
  .replace(/>([^<]+)</g, (_, text) => '>' + text.replace(/^(\s*)(.*?)(\s*)$/s,
    (match, before, copy, after) => english(copy) === copy ? match : before + escapeHtml(english(copy)) + after) + '<')
  .replace(/\b(aria-label|alt|title|content|data-retry)="([^"]*)"/g,
    (match, attribute, text) => english(text) === text ? match : `${attribute}="${escapeHtml(english(text))}"`);

await mkdir(new URL('en/', output), { recursive: true });
await cp(new URL('./src/assets/', import.meta.url), new URL('assets/', output), { recursive: true });

for (const language of ['vi', 'en']) {
  const isEnglish = language === 'en';
  const home = integrated ? '/' : isEnglish ? '../' : './';
  const englishHome = integrated ? '/en' : isEnglish ? './' : './en/';
  const languageSwitch = isEnglish
    ? `<a class="site-language" href="${home}?lang=vi" lang="vi" aria-label="Chuyển sang Tiếng Việt">VI</a>`
    : `<a class="site-language" href="${englishHome}" lang="en" aria-label="Switch to English">EN</a>`;
  const assetRoot = integrated ? '/juee-site/assets' : isEnglish ? '../assets' : './assets';

  let page = (isEnglish ? englishPage : template)
    .replaceAll('__JUEE_ASSETS__', assetRoot).replaceAll('__JUEE_APP__', app ? app.origin : '')
    .replaceAll('__JUEE_LANG__', language).replaceAll('__JUEE_EN_HOME__', englishHome)
    .replaceAll('__JUEE_HOME__', home)
    .replace('__JUEE_LANGUAGE_SWITCH__', () => languageSwitch)
    .replace('__JUEE_SOCIAL_LINKS__', () => socialLinks);
  if (app) {
    page = page.replaceAll(/href="(https?:\/\/[^"]+)"/g, (match, href) => {
      const url = new URL(href.replaceAll('&amp;', '&'));
      if (url.origin !== app.origin) return match;
      url.searchParams.set('lang', language);
      return `href="${escapeHtml(url.href)}"`;
    });
  }

  const localizedModels = JSON.stringify(models, (_, value) => isEnglish && typeof value === 'string' ? english(value) : value);
  await writeFile(new URL(isEnglish ? 'en/index.html' : 'index.html', output), page);
  await writeFile(new URL(`assets/models.${language}.js`, output), `export default ${localizedModels};\n`);
}

console.log(integrated ? 'Đã tạo trang chủ giới thiệu cho web app.' : `Website sẵn sàng trong website/dist. Web app: ${app.origin}`);
