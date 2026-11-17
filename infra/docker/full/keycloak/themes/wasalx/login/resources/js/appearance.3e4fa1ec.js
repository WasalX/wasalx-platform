(() => {
  const root = document.documentElement;
  const platform = location.pathname.includes('/realms/wasalx-platform/');
  const key = platform ? 'wasalx-platform-auth-theme' : 'wasalx.auth.theme';
  const media = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(key)
      ?? localStorage.getItem(platform ? 'wasalx-platform-theme' : 'wasalx.theme');
    if (['system', 'light', 'dark'].includes(saved)) preference = saved;
  } catch { /* Storage may be unavailable in a private browser. */ }

  function apply() {
    root.dataset.appearance = preference;
    root.classList.toggle('pf-v5-theme-dark', preference === 'dark' || (preference === 'system' && media.matches));
  }
  apply();
  media.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    const language = document.getElementById('login-select-toggle');
    if (language) language.title = language.getAttribute('aria-label');
    const title = document.getElementById('kc-page-title');
    if (title?.textContent?.includes('WasalX')) {
      const [before, after] = title.textContent.split('WasalX', 2);
      const brand = document.createElement('bdi');
      brand.className = 'wasalx-wordmark';
      const accent = document.createElement('span');
      accent.className = 'wasalx-brand-accent';
      accent.textContent = 'X';
      brand.append('Wasal', accent);
      title.replaceChildren(before, brand, after);
    }
    const select = document.getElementById('wasalx-auth-theme');
    if (!select) return;
    select.value = preference;
    language?.closest('.pf-v5-c-login__main-header-utilities')?.after(select.closest('label'));
    select.closest('label').hidden = false;
    select.addEventListener('change', () => {
      if (!['system', 'light', 'dark'].includes(select.value)) return;
      preference = select.value;
      apply();
      try { localStorage.setItem(key, preference); } catch { /* The choice still works for this page. */ }
    });

    const menus = [];
    document.querySelectorAll('#login-select-toggle, #wasalx-auth-theme').forEach(control => {
      const isLanguage = control === language;
      const menu = document.createElement('details');
      menu.className = 'wasalx-preference';
      menu.id = `${control.id}-menu`;
      const toggle = document.createElement('summary');
      toggle.setAttribute('aria-label', control.title);
      toggle.title = control.title;
      const icon = isLanguage ? null : control.previousElementSibling;
      if (icon) toggle.append(icon.cloneNode(true));
      const panel = document.createElement('div');
      panel.className = 'wasalx-preference-panel';
      const heading = document.createElement('p');
      heading.textContent = control.title;
      panel.append(heading);
      const choices = Array.from(control.options, option => {
        const button = document.createElement('button');
        button.type = 'button';
        const code = isLanguage ? new URL(option.value, location.href).searchParams.get('kc_locale') : null;
        if (icon) {
          const choiceIcon = icon.cloneNode(true);
          choiceIcon.dataset.choice = option.value;
          button.append(choiceIcon);
        }
        const label = document.createElement('span');
        label.textContent = isLanguage ? (code === 'ar' ? 'العربية' : 'English') : option.textContent;
        if (code) label.lang = code;
        button.append(label);
        button.addEventListener('click', () => {
          menu.open = false;
          toggle.focus();
          control.value = option.value;
          update();
          control.dispatchEvent(new Event('change', { bubbles: true }));
        });
        panel.append(button);
        return { button, option, code };
      });
      function update() {
        choices.forEach(({ button, option, code }) => {
          const selected = option.value === control.value;
          button.setAttribute('aria-pressed', String(selected));
          if (isLanguage && selected) toggle.textContent = code === 'ar' ? 'Ar' : 'En';
        });
      }
      update();
      menu.append(toggle, panel);
      const original = isLanguage ? control.parentElement : control.closest('label');
      if (isLanguage) original.after(menu);
      else {
        menu.classList.add('wasalx-auth-appearance');
        original.after(menu);
      }
      original.hidden = true;
      menu.addEventListener('toggle', () => {
        if (menu.open) menus.forEach(other => { if (other !== menu) other.open = false; });
      });
      menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { menu.open = false; toggle.focus(); }
      });
      menus.push(menu);
    });
    document.addEventListener('click', event => {
      menus.forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
    });
    document.addEventListener('focusin', event => {
      menus.forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
    });
  });
})();
