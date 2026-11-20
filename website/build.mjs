import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const integrated = process.argv.includes('--integrated');
const output = new URL(integrated ? '../frontend/public/gioi-thieu/' : './dist/', import.meta.url);
const assetRoot = integrated ? '/gioi-thieu/assets' : './assets';
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
const page = template.replaceAll('__JUEE_ASSETS__', assetRoot).replaceAll('__JUEE_APP__', app ? app.origin : '')
  .replace('__JUEE_SOCIAL_LINKS__', () => socialLinks);
await mkdir(output, { recursive: true });
await cp(new URL('./src/assets/', import.meta.url), new URL('assets/', output), { recursive: true });
await writeFile(new URL('index.html', output), page);
console.log(integrated ? 'Đã tạo trang /gioi-thieu cho web app.' : `Website sẵn sàng trong website/dist. Web app: ${app.origin}`);
