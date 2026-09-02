import { ChevronRight, Settings } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { AuthUser } from "../../api/auth";
import { settingsSectionsFor } from "../settings/settings-sections";

export interface SettingsNavigationItemProps {
  role: AuthUser["role"];
  search: string;
}

const coarsePointerQuery = "(hover: none), (pointer: coarse)";

function hasCoarsePointer() {
  return window.matchMedia?.(coarsePointerQuery).matches ?? false;
}

export function SettingsNavigationItem({ role, search }: SettingsNavigationItemProps) {
  const location = useLocation();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  const sections = settingsSectionsFor(role);
  const active = location.pathname.startsWith("/settings");
  const coarsePointer = hasCoarsePointer();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  function handlePrimaryClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!hasCoarsePointer()) return;
    event.preventDefault();
    setOpen(true);
  }

  function closeWithFocusRestore() {
    triggerRef.current?.focus();
    setOpen(false);
  }

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
      <NavLink
        ref={triggerRef}
        to={`/settings${search}`}
        className={active ? "nav-item active" : "nav-item"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={handlePrimaryClick}
      >
        <Settings size={18} aria-hidden="true" />
        <span>설정</span>
        <ChevronRight className="settings-nav-chevron" size={16} aria-hidden="true" />
      </NavLink>
      {open ? (
        <div className="settings-submenu" role={coarsePointer ? "dialog" : undefined} aria-label="설정 메뉴">
          {sections.map((section) => (
            <NavLink key={section.path} to={`${section.path}${search}`} onClick={() => setOpen(false)}>
              {section.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}
