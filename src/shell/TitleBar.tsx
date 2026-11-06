import { t } from "../i18n/t";
import { useSidebar } from "../state/sidebar";

export function TitleBar() {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="traffic-space" data-tauri-drag-region />
      <button className="icon-btn side-toggle" aria-label={t("sidebar.toggle")} title={t("sidebar.toggle")} onClick={() => useSidebar.getState().toggle()}>◧</button>
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
