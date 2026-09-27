(() => {
  const scenes = [...document.querySelectorAll('.scene[data-demo]')];
  const hero = document.querySelector('.hero');
  const header = document.querySelector('.site-header');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const visibleScenes = new Set();
  const running = new Map();
  const mapContent = document.querySelector('.map-content');
  const mapCanvas = document.querySelector('.map-canvas');
  const mapMarker = document.querySelector('.map-light--placed');
  const mapGhost = document.querySelector('.map-drag-ghost');
  const placeButton = document.getElementById('place-light');
  const fixtures = {
    '01': { name: '출입구 조명 01', location: '출입구 구역' },
    '02': { name: '통로 조명 02', location: '중앙 통로' },
    '03': { name: '통로 조명 03', location: '중앙 통로' },
    '04': { name: '주차 구역 조명 04', location: '주차 구역' },
  };

  function getRun(scene) {
    let run = running.get(scene);
    if (!run) {
      run = { timers: [], frame: null, animations: [] };
      running.set(scene, run);
    }
    return run;
  }

  function stopRun(scene) {
    const run = running.get(scene);
    if (run) {
      run.timers.forEach(window.clearTimeout);
      if (run.frame !== null) window.cancelAnimationFrame(run.frame);
      run.animations.forEach((animation) => animation.cancel());
      running.delete(scene);
    }
    if (scene.dataset.demo === 'map') mapGhost.classList.remove('is-visible');
    scene.classList.remove('is-playing');
  }

  function later(scene, callback, delay) {
    getRun(scene).timers.push(window.setTimeout(callback, delay));
  }

  function selectFixture(id, announce = true) {
    const fixture = fixtures[id];
    if (!fixture) return;
    document.querySelectorAll('[data-fixture]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.fixture === id));
    });
    document.getElementById('selected-fixture').textContent = fixture.name;
    document.getElementById('selected-location').textContent = fixture.location;
    document.getElementById('selected-fixture-status').hidden = false;
    document.getElementById('selected-fixture-details').hidden = false;
    if (announce) document.getElementById('monitoring-status').textContent = `${fixture.name}을 선택했습니다.`;
  }

  function setBrightness(value) {
    const normalized = Math.max(0, Math.min(100, Math.round(Number(value))));
    document.getElementById('brightness-range').value = String(normalized);
    document.getElementById('brightness-value').textContent = `${normalized}%`;
    const controlDemo = document.querySelector('.control-demo');
    controlDemo.style.setProperty('--brightness-pct', `${normalized}%`);
    controlDemo.style.setProperty('--glow-opacity', String(normalized / 260));
    controlDemo.style.setProperty('--beam-opacity', String(normalized / 210));
    controlDemo.style.setProperty('--floor-glow', `${normalized}px`);
    return normalized;
  }

  function setPlaced(placed, announce = true) {
    document.querySelector('.map-demo').classList.toggle('has-placed', placed);
    document.getElementById('map-count').textContent = `배치된 조명 ${placed ? 3 : 2}개`;
    if (announce) document.getElementById('map-status').textContent = placed
      ? '도면에 예시 조명 하나를 직접 배치했습니다.'
      : '추가한 예시 조명의 배치를 취소했습니다.';
  }

  function setMapMarkerPosition(x, y) {
    mapMarker.style.setProperty('--placed-x', `${x}%`);
    mapMarker.style.setProperty('--placed-y', `${y}%`);
  }

  function animateMapPlacement(scene) {
    const contentRect = mapContent.getBoundingClientRect();
    const toolRect = placeButton.querySelector('i').getBoundingClientRect();
    const canvasRect = mapCanvas.getBoundingClientRect();
    const sourceX = toolRect.left + toolRect.width / 2 - contentRect.left;
    const sourceY = toolRect.top + toolRect.height / 2 - contentRect.top;
    const dropX = canvasRect.left + canvasRect.width * .65 - contentRect.left;
    const dropY = canvasRect.top + canvasRect.height * .36 - contentRect.top;
    const deltaX = dropX - sourceX;
    const deltaY = dropY - sourceY;

    mapGhost.style.left = `${sourceX - 9}px`;
    mapGhost.style.top = `${sourceY - 9}px`;
    mapGhost.classList.add('is-visible');
    const drag = mapGhost.animate([
      { transform: 'translate(0, 0) scale(.8)', opacity: 0 },
      { transform: `translate(${deltaX * .35}px, ${deltaY * .15}px) scale(1.12)`, opacity: 1, offset: .35 },
      { transform: `translate(${deltaX}px, ${deltaY}px) scale(1)`, opacity: 1 },
    ], { duration: 1150, easing: 'ease-in-out', fill: 'forwards' });
    getRun(scene).animations.push(drag);

    later(scene, () => {
      drag.cancel();
      mapGhost.classList.remove('is-visible');
      setMapMarkerPosition(65, 36);
      setPlaced(true, false);
      document.getElementById('map-status').textContent = '예시 조명을 도면에 놓았습니다. 위치를 조정합니다.';
      const move = mapMarker.animate([
        { left: '65%', top: '36%', transform: 'scale(1)' },
        { left: '72%', top: '53%', transform: 'scale(1.18)', offset: .72 },
        { left: '72%', top: '53%', transform: 'scale(1)' },
      ], { duration: 950, easing: 'ease-in-out', fill: 'forwards' });
      getRun(scene).animations.push(move);
    }, 1150);
    later(scene, () => finishScene(scene), 2350);
  }

  function finishScene(scene) {
    stopRun(scene);
    scene.classList.add('is-complete');
    switch (scene.dataset.demo) {
      case 'monitoring':
        selectFixture('02');
        break;
      case 'control':
        setBrightness(70);
        document.getElementById('control-status').textContent = '예시 밝기 70%를 적용했습니다.';
        break;
      case 'statistics':
        document.getElementById('statistics-status').textContent = '예시 추정 전력 그래프가 표시됐습니다.';
        break;
      case 'report':
        document.getElementById('report-status').textContent = '예시 보고서 미리보기가 준비됐습니다.';
        break;
      case 'map':
        setMapMarkerPosition(72, 53);
        setPlaced(true, false);
        document.getElementById('map-status').textContent = '도면에 예시 조명을 배치한 뒤 위치를 조정했습니다.';
        break;
    }
  }

  function resetScene(scene) {
    stopRun(scene);
    scene.classList.remove('is-complete');
    switch (scene.dataset.demo) {
      case 'monitoring':
        document.querySelectorAll('[data-fixture]').forEach((button) => button.setAttribute('aria-pressed', 'false'));
        document.getElementById('selected-fixture').textContent = '조명을 선택하세요';
        document.getElementById('selected-location').textContent = '—';
        document.getElementById('selected-fixture-status').hidden = true;
        document.getElementById('selected-fixture-details').hidden = true;
        document.getElementById('monitoring-status').textContent = '도면에서 조명을 선택해 보세요.';
        break;
      case 'control':
        setBrightness(15);
        document.getElementById('control-status').textContent = '예시 밝기를 조정하고 있습니다.';
        break;
      case 'statistics':
        document.getElementById('statistics-status').textContent = '설명용 그래프를 그리고 있습니다.';
        break;
      case 'report':
        document.getElementById('report-status').textContent = '예시 보고서 미리보기를 준비합니다.';
        break;
      case 'map':
        setPlaced(false, false);
        setMapMarkerPosition(72, 53);
        document.getElementById('map-status').textContent = '도면에 조명을 배치하고 있습니다.';
        break;
    }
  }

  function animateBrightness(scene) {
    const duration = 1800;
    let start = null;
    const tick = (now) => {
      if (start === null) start = now;
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setBrightness(15 + (70 - 15) * eased);
      if (progress < 1) getRun(scene).frame = window.requestAnimationFrame(tick);
    };
    getRun(scene).frame = window.requestAnimationFrame(tick);
  }

  function playScene(scene) {
    resetScene(scene);
    if (reducedMotion.matches) {
      finishScene(scene);
      return;
    }
    // Replay can happen before the previous CSS animation ends; force a style boundary to restart it.
    void scene.offsetWidth;
    scene.classList.add('is-playing');
    switch (scene.dataset.demo) {
      case 'monitoring':
        later(scene, () => selectFixture('01'), 1100);
        later(scene, () => selectFixture('02'), 2350);
        later(scene, () => finishScene(scene), 3500);
        break;
      case 'control':
        animateBrightness(scene);
        later(scene, () => finishScene(scene), 2100);
        break;
      case 'statistics':
        later(scene, () => finishScene(scene), 2650);
        break;
      case 'report':
        later(scene, () => finishScene(scene), 1950);
        break;
      case 'map':
        animateMapPlacement(scene);
        break;
    }
  }

  document.querySelectorAll('[data-replay]').forEach((button) => {
    button.addEventListener('click', () => playScene(button.closest('.scene')));
  });

  document.querySelectorAll('[data-fixture]').forEach((button) => {
    button.addEventListener('click', () => {
      const scene = button.closest('.scene');
      stopRun(scene);
      scene.classList.add('is-complete');
      selectFixture(button.dataset.fixture);
    });
  });

  document.getElementById('brightness-range').addEventListener('input', (event) => {
    const scene = event.currentTarget.closest('.scene');
    stopRun(scene);
    const value = setBrightness(event.currentTarget.value);
    document.getElementById('control-status').textContent = `예시 밝기를 ${value}%로 조정했습니다. 적용 버튼을 눌러 보세요.`;
  });
  document.getElementById('apply-brightness').addEventListener('click', (event) => {
    const scene = event.currentTarget.closest('.scene');
    stopRun(scene);
    scene.classList.add('is-complete');
    document.getElementById('control-status').textContent = `예시 밝기 ${document.getElementById('brightness-range').value}%를 적용했습니다.`;
  });

  document.querySelectorAll('[data-format]').forEach((button) => {
    button.addEventListener('click', () => {
      const scene = button.closest('.scene');
      finishScene(scene);
      document.querySelectorAll('[data-format]').forEach((option) => {
        const selected = option === button;
        option.classList.toggle('is-selected', selected);
        option.setAttribute('aria-pressed', String(selected));
      });
      document.getElementById('selected-format').textContent = `${button.dataset.format} 형식`;
      document.getElementById('history-format').textContent = button.dataset.format;
      document.getElementById('report-status').textContent = `${button.dataset.format} 형식의 설명용 미리보기입니다.`;
    });
  });

  let pointerDrag = null;
  let suppressPlaceClick = false;
  placeButton.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    pointerDrag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
    placeButton.setPointerCapture(event.pointerId);
  });
  placeButton.addEventListener('pointermove', (event) => {
    if (!pointerDrag || pointerDrag.id !== event.pointerId) return;
    if (!pointerDrag.dragging && Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) > 8) {
      pointerDrag.dragging = true;
      // Keep the current placement until a drop inside the map actually replaces it.
      stopRun(placeButton.closest('.scene'));
      mapGhost.classList.add('is-visible');
    }
    if (pointerDrag.dragging) {
      const rect = mapContent.getBoundingClientRect();
      mapGhost.style.left = `${event.clientX - rect.left - 9}px`;
      mapGhost.style.top = `${event.clientY - rect.top - 9}px`;
    }
  });
  placeButton.addEventListener('pointerup', (event) => {
    if (!pointerDrag || pointerDrag.id !== event.pointerId) return;
    const wasDragging = pointerDrag.dragging;
    pointerDrag = null;
    if (!wasDragging) return;
    suppressPlaceClick = true;
    window.setTimeout(() => { suppressPlaceClick = false; }, 0);
    mapGhost.classList.remove('is-visible');
    const rect = mapCanvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      document.getElementById('map-status').textContent = '도면 안에 조명 도구를 놓아 주세요. 기존 배치는 유지됩니다.';
      return;
    }
    const x = Math.max(5, Math.min(95, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(5, Math.min(95, ((event.clientY - rect.top) / rect.height) * 100));
    const scene = placeButton.closest('.scene');
    scene.classList.add('is-complete');
    setMapMarkerPosition(x, y);
    setPlaced(true, false);
    document.getElementById('map-status').textContent = '도면에 예시 조명을 직접 끌어 놓았습니다.';
  });
  placeButton.addEventListener('pointercancel', () => {
    pointerDrag = null;
    mapGhost.classList.remove('is-visible');
  });
  placeButton.addEventListener('click', (event) => {
    if (suppressPlaceClick) return;
    playScene(event.currentTarget.closest('.scene'));
  });
  document.getElementById('remove-light').addEventListener('click', (event) => {
    const scene = event.currentTarget.closest('.scene');
    stopRun(scene);
    scene.classList.remove('is-complete');
    setMapMarkerPosition(72, 53);
    setPlaced(false);
  });

  const updateHeader = () => header.classList.toggle('is-scrolled', window.scrollY > 24);
  window.addEventListener('scroll', updateHeader, { passive: true });
  updateHeader();

  if (reducedMotion.matches) scenes.forEach(finishScene);
  if (!('IntersectionObserver' in window)) {
    scenes.forEach(finishScene);
    if (!reducedMotion.matches) hero.classList.add('is-animating');
  } else {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const scene = entry.target;
        if (entry.intersectionRatio >= .15 && !visibleScenes.has(scene)) {
          visibleScenes.add(scene);
          playScene(scene);
        } else if (entry.intersectionRatio <= .001 && visibleScenes.has(scene)) {
          visibleScenes.delete(scene);
          if (running.has(scene)) finishScene(scene);
        }
      });
    }, { threshold: [0, .15] });
    scenes.forEach((scene) => observer.observe(scene));

    let heroVisible = false;
    const heroObserver = new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio >= .15 && !heroVisible) {
        heroVisible = true;
        if (!reducedMotion.matches) {
          hero.classList.remove('is-animating');
          void hero.offsetWidth;
          hero.classList.add('is-animating');
        }
      } else if (entry.intersectionRatio <= .001 && heroVisible) {
        heroVisible = false;
        hero.classList.remove('is-animating');
      }
    }, { threshold: [0, .15] });
    heroObserver.observe(hero);
  }
})();

(() => {
  const dialog = document.getElementById('inquiry-dialog');
  const form = document.getElementById('inquiry-form');
  const title = document.getElementById('inquiry-title');
  const submit = form.querySelector('[type="submit"]');
  const close = dialog.querySelector('[data-close-inquiry]');
  const progress = document.getElementById('inquiry-progress');
  const feedback = document.getElementById('inquiry-feedback');
  const fallback = document.getElementById('inquiry-mail-fallback');
  const fields = ['companyName', 'contactName', 'email', 'phone', 'audience', 'message', 'consent', 'website'];
  const input = Object.fromEntries(fields.map((name) => [name, form.elements.namedItem(name)]));
  const errorNodes = {
    companyName: document.getElementById('inquiry-company-error'),
    contactName: document.getElementById('inquiry-contact-error'),
    email: document.getElementById('inquiry-email-error'),
    phone: document.getElementById('inquiry-phone-error'),
    message: document.getElementById('inquiry-message-error'),
    consent: document.getElementById('inquiry-consent-error'),
  };
  let trigger = null;
  let pending = false;
  let requestIdentity = null;

  document.querySelectorAll('[data-open-inquiry]').forEach((button) => button.addEventListener('click', () => {
    trigger = button;
    dialog.showModal();
    document.body.classList.add('has-inquiry-dialog');
    title.focus();
  }));
  close.addEventListener('click', () => { if (!pending) dialog.close(); });
  dialog.addEventListener('click', (event) => { if (!pending && event.target === dialog) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
  dialog.addEventListener('keydown', (event) => {
    if (!pending || event.key !== 'Tab') return;
    // Chromium can move focus to body when all form fields are disabled during a modal request.
    event.preventDefault();
    (document.activeElement === submit ? close : submit).focus();
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('has-inquiry-dialog');
    trigger?.focus();
  });

  function setFieldError(name, message) {
    const node = errorNodes[name];
    if (!node) return;
    node.textContent = message;
    node.hidden = !message;
    if (message) input[name].setAttribute('aria-invalid', 'true');
    else input[name].removeAttribute('aria-invalid');
  }

  function clearFeedback() {
    feedback.hidden = true;
    feedback.removeAttribute('data-kind');
    fallback.hidden = true;
    submit.disabled = false;
  }

  function showFeedback(kind, heading, description, mailFallback = false) {
    feedback.dataset.kind = kind;
    document.getElementById('inquiry-feedback-title').textContent = heading;
    document.getElementById('inquiry-feedback-description').textContent = description;
    fallback.hidden = !mailFallback;
    feedback.hidden = false;
  }

  form.addEventListener('input', (event) => {
    if (event.target.name in errorNodes) setFieldError(event.target.name, '');
    clearFeedback();
  });
  form.addEventListener('change', (event) => {
    if (event.target.name in errorNodes) setFieldError(event.target.name, '');
    clearFeedback();
  });

  function validate() {
    const companyName = input.companyName.value.trim();
    const contactName = input.contactName.value.trim();
    const email = input.email.value.trim();
    const phone = input.phone.value.trim();
    const message = input.message.value.trim();
    const errors = {
      companyName: !companyName ? '회사명을 입력해 주세요.' : companyName.length > 120 ? '회사명은 120자 이하로 입력해 주세요.' : '',
      contactName: !contactName ? '담당자 이름을 입력해 주세요.' : contactName.length > 80 ? '담당자 이름은 80자 이하로 입력해 주세요.' : '',
      email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ? '올바른 이메일 주소를 입력해 주세요.' : '',
      phone: phone.length > 30 ? '전화번호는 30자 이하로 입력해 주세요.' : '',
      message: !message ? '문의 내용을 입력해 주세요.' : message.length > 2000 ? '문의 내용은 2,000자 이하로 입력해 주세요.' : '',
      consent: !input.consent.checked ? '개인정보 수집·이용에 동의해 주세요.' : '',
    };
    Object.entries(errors).forEach(([name, messageText]) => setFieldError(name, messageText));
    const firstError = Object.keys(errors).find((name) => errors[name]);
    if (firstError) input[firstError].focus();
    return !firstError;
  }

  function setPending(value) {
    pending = value;
    fields.forEach((name) => { input[name].disabled = value; });
    // Keep both buttons focusable while blocking actions so a modal never loses its tab stops.
    submit.setAttribute('aria-disabled', String(value));
    close.setAttribute('aria-disabled', String(value));
    progress.textContent = value ? '상담 문의를 접수하고 있습니다. 잠시만 기다려 주세요.' : '';
    submit.textContent = value ? '접수 중' : '상담 문의 보내기';
  }

  function showRequestError(status) {
    if (status === 503) showFeedback('error', '현재 온라인 상담을 접수할 수 없습니다.', '잠시 후 다시 시도하거나 이메일로 직접 문의해 주세요.', true);
    else if (status === 429) showFeedback('error', '요청이 많습니다.', '잠시 후 다시 시도해 주세요.');
    else if (status === null || status >= 500) showFeedback('error', '접수 결과를 확인하지 못했습니다.', '입력 내용은 남아 있습니다. 다시 시도하면 같은 문의로 확인합니다.');
    else showFeedback('error', '문의 내용을 확인해 주세요.', '입력 내용은 남아 있습니다. 확인 후 다시 시도해 주세요.');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || !validate()) return;
    if (input.website.value) return;
    const payload = {
      companyName: input.companyName.value.trim(),
      contactName: input.contactName.value.trim(),
      email: input.email.value.trim(),
      phone: input.phone.value.trim(),
      audience: input.audience.value || null,
      message: input.message.value.trim(),
      consent: true,
      consentVersion: 'landing-2026-09-v1-90d',
      website: '',
    };
    // The API's 4 KB cap includes the UUID and UTF-8 JSON bytes, not only the message field.
    const probe = { idempotencyKey: '00000000-0000-4000-8000-000000000000', ...payload };
    if (new TextEncoder().encode(JSON.stringify(probe)).length > 4096) {
      setFieldError('message', '문의 내용이 너무 깁니다. 내용을 줄여 주세요.');
      input.message.focus();
      return;
    }
    const fingerprint = JSON.stringify(payload);
    // A lost response can mean an inquiry was saved, so exact retries reuse the same UUID.
    if (requestIdentity?.payload !== fingerprint) requestIdentity = { payload: fingerprint, key: crypto.randomUUID() };
    clearFeedback();
    setPending(true);
    const controller = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const response = await fetch('/api/landing/inquiries', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: requestIdentity.key, ...payload }), signal: controller.signal,
      });
      if (!response.ok) {
        showRequestError(response.status);
        return;
      }
      const result = await response.json();
      if (result?.status !== 'received' || typeof result.reference !== 'string' || !result.reference.trim()) {
        showRequestError(null);
        return;
      }
      requestIdentity = null;
      showFeedback('success', '상담 문의가 접수되었습니다.', `접수번호: ${result.reference}`);
    } catch {
      showRequestError(null);
    } finally {
      window.clearTimeout(timer);
      setPending(false);
      if (feedback.dataset.kind === 'success') {
        submit.disabled = true;
        close.focus();
      }
    }
  });
})();
