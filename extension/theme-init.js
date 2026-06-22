chrome.storage.sync.get('theme').then(r => {
  if (r.theme && r.theme !== 'system') document.documentElement.dataset.theme = r.theme;
});
