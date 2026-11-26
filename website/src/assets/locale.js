const page = document.documentElement;
const languageChoice = new URLSearchParams(location.search).get('lang');

try {
  if (page.lang === 'en' || languageChoice === 'vi') {
    localStorage.setItem('juee-language', page.lang);
  } else if (localStorage.getItem('juee-language') === 'en') {
    location.replace(page.dataset.englishHome + location.hash);
  }
} catch { /* The language links also work without browser storage. */ }

if (languageChoice === 'vi') {
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  history.replaceState(null, '', url);
}
