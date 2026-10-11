import { useEffect, useRef, useState, type MouseEvent } from "react";

export function useSiteConsultation(title: string) {
  const [isOpen, setIsOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const headerContact = useRef<HTMLButtonElement>(null);
  useEffect(() => { document.title = title; }, [title]);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 24);
    window.addEventListener("scroll", update, { passive: true });
    update();
    return () => window.removeEventListener("scroll", update);
  }, []);
  useEffect(() => {
    // Retained contact bookmarks reopen the entry's consultation without a plan.
    const handleHash = () => {
      if (window.location.hash !== "#contact") return;
      setOpener(headerContact.current); setSelectedPlan(null); setIsOpen(true);
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    };
    handleHash(); window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);
  useEffect(() => {
    // SPA targets mount after the browser's initial fragment scroll.
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id || id === "contact") return;
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
    return () => window.cancelAnimationFrame(frame);
  }, []);
  function open(event: MouseEvent<HTMLButtonElement>, plan: string | null = null) {
    setOpener(event.currentTarget); setSelectedPlan(plan); setIsOpen(true);
  }
  return { isOpen, opener, selectedPlan, scrolled, headerContact, open, close: () => setIsOpen(false) };
}
