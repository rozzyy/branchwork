import { t } from "../i18n/t";

export function TitleBar() {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="traffic-space" data-tauri-drag-region />
      <span className="app-name" data-tauri-drag-region>{t("app.name")}</span>
      <button className="search" onClick={() => window.dispatchEvent(new CustomEvent("bw:palette"))}>
        <span aria-hidden>⌕</span>
        <span className="search-label">{t("search.placeholder")}</span>
        <kbd className="kbd">⌘K</kbd>
      </button>
      <div className="title-right" data-tauri-drag-region />
    </header>
  );
}
