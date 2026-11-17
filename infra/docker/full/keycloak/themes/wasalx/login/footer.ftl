<#-- Native keycloak.v2 footer extension; forms, MFA and recovery remain inherited. -->
<#macro content>
  <div class="wasalx-auth-footer">
    <a href="${properties.wasalxHomeUrl}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18"/></svg>${msg("wasalxBackHome")}</a>
    <label class="wasalx-auth-appearance" title="${msg('wasalxAppearance')}" hidden>
      <span class="wasalx-visually-hidden">${msg("wasalxAppearance")}</span>
      <svg class="wasalx-appearance-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <g data-theme-icon="appearance"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/></g>
        <g data-theme-icon="system"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4m-4 0h8"/></g>
        <g data-theme-icon="light"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></g>
        <g data-theme-icon="dark"><path d="M20.5 13.3A8.7 8.7 0 0 1 10.7 3.5 8.7 8.7 0 1 0 20.5 13.3Z"/></g>
      </svg>
      <select id="wasalx-auth-theme" title="${msg('wasalxAppearance')}">
        <option value="system">${msg("wasalxSystem")}</option>
        <option value="light">${msg("wasalxLight")}</option>
        <option value="dark">${msg("wasalxDark")}</option>
      </select>
    </label>
  </div>
</#macro>
