
document.querySelectorAll('.faq-item').forEach((item) => {
  const btn = item.querySelector('.faq-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    item.toggleAttribute('open');
    btn.setAttribute('aria-expanded', item.hasAttribute('open') ? 'true' : 'false');
  });
});
