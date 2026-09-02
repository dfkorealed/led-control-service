import { ChevronRight, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import type { AuthUser } from "../../api/auth";
import { settingsSectionsFor } from "../settings/settings-sections";

export interface SettingsNavigationItemProps {
  role: AuthUser["role"];
  search: string;
}

const coarsePointerQuery = "(hover: none), (pointer: coarse)";
const settingsPopupId = "settings-navigation-popup";

function hasCoarsePointer() {
  return window.matchMedia?.(coarsePointerQuery).matches ?? false;
}

export function SettingsNavigationItem({ role, search }: SettingsNavigationItemProps) {
  const location = useLocation();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const firstSectionRef = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  const sections = settingsSectionsFor(role);
  const active = location.pathname.startsWith("/settings");
  const coarsePointer = hasCoarsePointer();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (open && coarsePointer) firstSectionRef.current?.focus();
  }, [coarsePointer, open]);

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  function closeWithFocusRestore() {
    triggerRef.current?.focus();
    setOpen(false);
  }

  const triggerContent = (
    <>
      <Settings size={18} aria-hidden="true" />
      <span>설정</span>
      <ChevronRight className="settings-nav-chevron" size={16} aria-hidden="true" />
    </>
  );

  return (
    <div
      ref={wrapperRef}
      className="settings-nav-disclosure"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") closeWithFocusRestore();
      }}
    >
      {coarsePointer ? (
        <button
          ref={(node) => { triggerRef.current = node; }}
          type="button"
          className={active ? "nav-item active" : "nav-item"}
          aria-expanded={open}
          aria-controls={settingsPopupId}
          onClick={() => setOpen(true)}
        >
          {triggerContent}
        </button>
      ) : (
        <Link
          ref={(node) => { triggerRef.current = node; }}
          to={`/settings${search}`}
          className={active ? "nav-item active" : "nav-item"}
          aria-expanded={open}
          aria-controls={settingsPopupId}
        >
          {triggerContent}
        </Link>
      )}
      {open ? (
        <>
          {coarsePointer ? (
            <button
              type="button"
              className="settings-submenu-scrim"
              aria-label="설정 메뉴 닫기"
              onClick={closeWithFocusRestore}
            />
          ) : null}
          <nav
            id={settingsPopupId}
            className="settings-submenu"
            aria-label="설정 메뉴"
          >
            {coarsePointer ? (
              <div className="settings-submenu-heading">
                <span className="settings-submenu-grabber" data-testid="settings-submenu-grabber" aria-hidden="true" />
                <h2>설정 메뉴</h2>
              </div>
            ) : null}
            <ul className="settings-submenu-list">
              {sections.map((section, index) => (
                <li key={section.path}>
                  <NavLink
                    ref={index === 0 ? firstSectionRef : undefined}
                    to={`${section.path}${search}`}
                    end={section.path === "/settings"}
                    onClick={() => setOpen(false)}
                  >
                    {section.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </>
      ) : null}
    </div>
  );
}
