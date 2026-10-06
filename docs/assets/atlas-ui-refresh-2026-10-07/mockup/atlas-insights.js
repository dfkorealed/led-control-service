export function estimateEnergy(rows) {
  if (rows.some(row => row.hours == null || row.brightness == null || row.watt == null)) return null;
  return rows.reduce((sum, row) => sum + row.watt * row.brightness / 100 * row.hours / 1000, 0);
}
export function chartSegments(values) {
  const segments = []; let current = [];
  values.forEach((y, x) => { if (y == null) { if (current.length) segments.push(current); current = []; } else current.push({ x, y }); });
  if (current.length) segments.push(current);
  return segments;
}
export function validateReport({ start, end, scope }) {
  if (!start || !end || !scope) return '기간과 대상 범위를 선택해 주세요.';
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || start > end) return '종료일은 시작일 이후여야 합니다.';
  return '';
}
export function validateUser({ name, email }) {
  if (!name?.trim()) return '이름을 입력해 주세요.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return '올바른 이메일을 입력해 주세요.';
  return '';
}
const periods = {
  today: { label: '오늘', range: '2026.10.06 00:00–현재', comparison: '전일 동일 시간 대비', energy: 128.4, cost: 19260, savings: 34.2, points: [3, 3, 2, 2, 4, 9, 16, 19, null, 15, 12, 9], labels: ['00시', '04시', '08시', '12시', '16시', '20시'], axis: '시간당 추정 전력량 · kWh' },
  month: { label: '이번 달', range: '2026.10.01–10.06', comparison: '전월 1–6일 대비', energy: 762.8, cost: 114420, savings: 31.8, points: [15, 13, 18, 16, null, 14, 17, 13, 14, 11, 15, 12], labels: ['1일', '2일', '3일', '4일', '5일', '6일'], axis: '일별 추정 전력량 · kWh ×10' },
  year: { label: '올해', range: '2026.01.01–10.06', comparison: '전년 동일 기간 대비', energy: 38420, cost: 5763000, savings: 28.6, points: [18, 19, 16, 14, 14, null, 12, 13, 11, 10, 9, 8], labels: ['1월', '3월', '5월', '7월', '9월', '10월'], axis: '월별 추정 전력량 · MWh' },
};
export const periodDataset = period => periods[period] || periods.today;

export function reportMatches(report, filters) {
  const [start, abbreviatedEnd] = report.period.replaceAll('.', '-').split(' – ');
  // Display periods omit the repeated year; comparisons always use complete ISO dates.
  const end = abbreviatedEnd.length === 5 ? start.slice(0, 5) + abbreviatedEnd : abbreviatedEnd;
  return (!filters.query || report.name.includes(filters.query)) && (filters.reportStatus === 'all' || filters.reportStatus === report.status) && (filters.scope === 'all' || report.scope === filters.scope) && end >= filters.reportStart && start <= filters.reportEnd;
}
export function contributionPercentage(values, index) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? values[index] / total * 100 : 0;
}

import { store, esc, icon, badge, button, field, kpi, dataGrid, filterPopover, mapWorkspace, mountMap, openDialog, closeDialog, toast, downloadText } from './atlas-ui.js';

// All data below belongs to this disposable review artifact; no product API is called.
const state = {
  period: 'today', analysisUnit: 'floor', metric: 'energy', rank: 0,
  query: '', reportStatus: 'all', scope: 'all', reportStart: '2026-10-01', reportEnd: '2026-10-06',
  reports: [{ id: 'R-001', name: '10월 주차장 운영 요약', period: '2026.10.01 – 10.06', scope: '전체 층', status: 'completed' }, { id: 'R-002', name: '9월 에너지 분석', period: '2026.09.01 – 09.30', scope: 'B1', status: 'completed' }],
  floors: [{ id: 'B1', name: '지하 1층', area: '2,400' }, { id: '1F', name: '지상 1층', area: '2,100' }],
  siteName: store.site, address: '서울특별시 강남구 테헤란로 152',
  users: [{ id: 1, name: '김지훈', email: 'jh.kim@atlas.example', role: '관리자', status: '활성' }, { id: 2, name: '박서연', email: 'sy.park@atlas.example', role: '조회자', status: '활성' }],
  userSort: 'name', readOnly: false, mfa: false, loginStep: 0, wizard: 0, registration: 0, selectedDevices: ['NODE-028'],
  dirty: false, editorHistory: [], editorFuture: [], mobileSession: true, customers: [{ id: 1, name: '센트럴 파크', email: 'admin@central.example', status: '활성' }],
};
const actionButton = (text, action, options = {}) => button(text, { action: `insights:${action}`, ...options });
const routeButton = (text, route, options = {}) => button(text, { ...options, attrs: `data-insights-route="${route}" ${options.attrs || ''}` });
const input = (name, value = '', type = 'text', attrs = '') => `<input class="input" name="${name}" type="${type}" value="${esc(value)}" ${attrs}>`;
const select = (name, items, value) => `<select class="input" name="${name}" data-insights-select="${name}">${items.map(([id, text]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${text}</option>`).join('')}</select>`;
const head = (eyebrow, title, description, actions = '') => `<div class="page-head"><div>${eyebrow ? `<div class="caption insights-eyebrow">${eyebrow}</div>` : ''}<h1>${title}</h1>${description ? `<p class="muted">${description}</p>` : ''}</div><div class="row">${actions}</div></div>`;
const panel = (title, content, extra = '') => `<section class="panel insights-panel"><div class="row insights-panel-head"><h2 class="section-title">${title}</h2>${extra}</div>${content}</section>`;
const settingTabs = route => `<nav class="tabs insights-settings-tabs" aria-label="설정 메뉴">${[['settings', '설정 홈'], ['site', '현장 관리'], ['users', '사용자'], ['registration', '조명 등록'], ['maps', '도면'], ['security', '보안']].map(([id, label]) => routeButton(label, id, { variant: route === id ? 'primary' : 'ghost' })).join('')}</nav>`;
const settingsHead = (route, title, description, actions = '') => head('', title, description, actions) + (route === 'settings' ? '' : `<div class="insights-settings-back">${routeButton('설정으로 돌아가기', 'settings')}</div>`) + settingTabs(route);
const statisticsTabs = route => `<nav class="tabs insights-statistics-tabs" aria-label="통계 메뉴">${[['overview', '개요'], ['analysis', '사용량 분석'], ['reports', '보고서']].map(([id, label]) => routeButton(label, id, { variant: route === id ? 'primary' : 'ghost', attrs: route === id ? 'aria-current="page"' : '' })).join('')}</nav>`;
const estimationNotice = `<p class="insights-method caption">${icon('info', 16)} 정격전력 × 밝기 × 상태 유지시간으로 계산한 추정값입니다. 계량기 실측이 아니며 수집 공백은 제외합니다. 가상 단가 150원/kWh.</p>`;

function comparisonChart(data) {
  const width = 840, height = 240, left = 44, top = 16, baseline = 204;
  const x = i => left + i * (width - left - 16) / (data.points.length - 1);
  const y = value => baseline - value / 24 * 180;
  const points = segment => segment.map(p => `${x(p.x)},${y(p.y)}`).join(' ');
  const gap = data.points.indexOf(null);
  const benchmark = data.points.map((_, i) => `${x(i)},${y(19 + Math.sin(i / 2) * 2)}`).join(' ');
  return `<div class="insights-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(data.range)} 추정 전력량. 수집 공백 구간의 선은 연결하지 않습니다.">
    ${[0, 6, 12, 18, 24].map(v => `<line x1="${left}" y1="${y(v)}" x2="824" y2="${y(v)}" class="insights-gridline"/><text x="30" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    <polyline points="${benchmark}" class="insights-benchmark"/>
    <rect x="${x(gap) - 16}" y="16" width="32" height="188" class="insights-gap"/><text x="${x(gap)}" y="34" text-anchor="middle">공백</text>
    ${chartSegments(data.points).map(segment => `<polygon points="${x(segment[0].x)},${baseline} ${points(segment)} ${x(segment.at(-1).x)},${baseline}" class="insights-area"/><polyline points="${points(segment)}" class="insights-current"/>`).join('')}
    <polyline points="${x(10)},${y(data.points[10])} ${x(11)},${y(data.points[11])} 824,${y(11)}" class="insights-forecast"/>
    ${data.labels.map((label, i) => `<text x="${left + i * 780 / (data.labels.length - 1)}" y="232" text-anchor="middle">${label}</text>`).join('')}
  </svg></div><div class="row insights-legend"><span><i class="insights-dot"></i>추정 사용량</span><span><i class="insights-dot insights-dot-neutral"></i>24시간 100% 점등 기준</span><span><i class="insights-dot insights-dot-forecast"></i>남은 시간 예상</span><span class="muted">${data.axis}</span></div>`;
}

function renderOverview() {
  const base = periodDataset(state.period), scale = state.scope === 'all' ? 1 : state.scope === 'B1' ? .65 : .35;
  const data = { ...base, energy: Math.round(base.energy * scale * 10) / 10, cost: Math.round(base.cost * scale), points: base.points.map(value => value == null ? null : value * scale) };
  const totalSamples = Math.round(({ today: 2880, month: 17280, year: 864000 }[state.period]) * scale);
  const missingSamples = Math.round(totalSamples * .038), savedEnergy = data.energy / (1 - data.savings / 100) - data.energy;
  const operationalInfo = `<dl class="insights-operating-data"><div><dt>유효 수집 표본</dt><dd>${(totalSamples - missingSamples).toLocaleString()} / ${totalSamples.toLocaleString()}건</dd></div><div><dt>미수집 표본</dt><dd>${missingSamples.toLocaleString()}건 · 공백으로 제외</dd></div><div><dt>최근 수집 시각</dt><dd>2026.10.06 21:30</dd></div><div><dt>최대 절감 기여 층</dt><dd>${state.scope === '1F' ? '1F' : 'B1'} · ${(savedEnergy * (state.scope === 'all' ? .65 : 1)).toFixed(1)} kWh 추정</dd></div></dl><p class="caption insights-operating-note">가상 운영 데이터 · 선택 기간의 수집 품질과 절감 기여 예시입니다. 미수집 상태를 0으로 계산하지 않습니다.</p>`;
  return head('ENERGY INTELLIGENCE', '사용량 개요', '조명 운영의 변화를 숫자와 추세로 확인하세요.', routeButton('보고서 생성', 'reports', { icon: 'download', variant: 'primary' })) +
    `<div class="row insights-period-row"><span class="caption">${data.label} · ${data.range} · ${data.comparison} · ${state.scope === 'all' ? '전체 층' : esc(state.scope)}</span>${filterPopover('조회 조건', field('조회 기간', select('period', [['today', '오늘'], ['month', '이번 달'], ['year', '올해']], state.period)) + field('대상 층', select('scope', [['all', '전체 층'], ...state.floors.map(f => [f.id, f.id])], state.scope)))}</div>
    <div class="kpis insights-kpis">${kpi('추정 전력량', data.energy.toLocaleString(), { unit: 'kWh', trend: '↓ 18.6% · ' + data.comparison, tone: 'success' })}${kpi('예상 전기요금', data.cost.toLocaleString(), { unit: '원', trend: '기준 사용량 대비 비용 추정' })}${kpi('예상 절감률', data.savings, { unit: '%', trend: '24시간 100% 점등 기준 대비', tone: 'success' })}${kpi('수집 완전도', '96.2', { unit: '%', trend: '공백 3.8% · 추정치에서 제외', tone: 'warning' })}</div>
    ${panel('에너지 사용 추세', comparisonChart(data), badge('추정값', 'neutral'))}${estimationNotice}
    <div class="grid-2">${panel('기준 사용량과 비용 비교', `<div class="insights-cost-bar"><div class="row"><span>24시간 100% 점등 기준</span><strong>₩${Math.round(data.cost / (1 - data.savings / 100)).toLocaleString()}</strong></div><div class="insights-bar-track"><span style="width:100%" class="insights-bar-neutral"></span></div><div class="row"><span>현재 운영 · 추정</span><strong>₩${data.cost.toLocaleString()}</strong></div><div class="insights-bar-track"><span style="width:${100 - data.savings}%"></span></div></div>`)}${panel('운영 인사이트', operationalInfo, badge('가상 데이터', 'neutral'))}</div>`;
}

const rankNames = { floor: ['B1 · 지하 1층', '1F · 지상 1층', '1F · 로비', 'B1 · 주차', '외부 · 진입로'], group: ['A구역 · 주차', 'B구역 · 통로', 'C구역 · 진입', 'D구역 · 창고', 'E구역 · 계단'], light: ['L-014 · 통로', 'L-028 · 진입로', 'L-006 · 주차', 'L-019 · 계단', 'L-031 · 로비'] };
function renderAnalysis() {
  const names = rankNames[state.analysisUnit], dateScale = Math.max(1, (Date.parse(state.reportEnd) - Date.parse(state.reportStart)) / 86400000 + 1) / 6;
  const scopeScale = state.scope === 'all' ? 1 : .65;
  const values = [84.2, 61.5, 38.7, 24.3, 16.8].map(v => Math.round(v * dateScale * scopeScale * 10) / 10), idx = state.rank;
  const heat = Array.from({ length: 7 }, (_, row) => `<div class="insights-heat-row"><span>${['월', '화', '수', '목', '금', '토', '일'][row]}</span>${Array.from({ length: 12 }, (_, col) => `<span class="insights-heat-cell ${row === 3 && col === 8 ? 'insights-heat-missing' : ''}" style="--heat-opacity:${0.15 + ((row * 3 + col * 7) % 8) / 10}" title="${row === 3 && col === 8 ? '수집 공백' : col * 2 + '시 · 추정 사용량'}"></span>`).join('')}</div>`).join('');
  return head('ENERGY INTELLIGENCE', '사용량 분석', '대상별 소비 패턴과 사용량 기여도를 살펴보세요.') +
    `<div class="toolbar"><span class="caption">${{ floor: '층별', group: '그룹별', light: '조명별' }[state.analysisUnit]} · ${state.metric === 'energy' ? '추정 전력량' : '예상 비용'} · ${state.reportStart}–${state.reportEnd} · 이전 동일 기간 대비</span>${filterPopover('조회 조건', field('집계 단위', select('analysisUnit', [['floor', '층별'], ['group', '그룹별'], ['light', '조명별']], state.analysisUnit)) + field('지표', select('metric', [['energy', '추정 전력량'], ['cost', '예상 비용']], state.metric)) + field('시작일', input('analysisStart', state.reportStart, 'date')) + field('종료일', input('analysisEnd', state.reportEnd, 'date')) + field('층', select('scope', [['all', '전체 층'], ...state.floors.map(f => [f.id, f.id])], state.scope)))}</div>
    <div class="grid-2">${panel('사용량 순위 · TOP 5', `<div class="insights-ranking">${names.map((name, i) => `<button class="insights-rank ${i === idx ? 'is-selected' : ''}" data-action="insights:rank:${i}"><span class="insights-rank-index">0${i + 1}</span><span class="insights-rank-main"><span>${name}</span><span class="insights-bar-track"><span style="width:${values[i] / values[0] * 100}%"></span></span></span><strong>${state.metric === 'cost' ? '₩' + Math.round(values[i] * 150).toLocaleString() : values[i] + ' kWh'}</strong></button>`).join('')}</div>`)}${panel('선택 대상 상세', `<div class="insights-detail-heading">${badge('선택 대상', 'neutral')}<h2>${names[idx]}</h2></div><div class="kpis insights-detail-kpis">${kpi('추정 사용량', values[idx], { unit: 'kWh' })}${kpi('예상 비용', Math.round(values[idx] * 150).toLocaleString(), { unit: '원' })}</div><dl class="insights-dl"><div><dt>전체 사용량 기여도</dt><dd>${contributionPercentage(values, idx).toFixed(1)}%</dd></div><div><dt>이전 동일 기간 대비</dt><dd class="insights-positive">↓ ${(12.8 + idx * 2.1).toFixed(1)}%</dd></div><div><dt>기록 완전도</dt><dd>96.2% · 공백 제외</dd></div></dl>`)}</div>
    ${panel('요일 · 시간 사용 패턴', `<div class="insights-heatmap"><div class="insights-heat-labels"><span></span>${Array.from({ length: 12 }, (_, i) => `<span>${i * 2}시</span>`).join('')}</div>${heat}</div><div class="row insights-legend"><span>적음</span><i class="insights-heat-cell" style="--heat-opacity:.2"></i><i class="insights-heat-cell" style="--heat-opacity:.5"></i><i class="insights-heat-cell" style="--heat-opacity:.9"></i><span>많음</span><i class="insights-heat-cell insights-heat-missing"></i><span>수집 공백</span></div>`)}${estimationNotice}`;
}

function renderReports() {
  const rows = state.reports.filter(r => reportMatches(r, state)).map(r => ({ name: `<strong>${esc(r.name)}</strong><div class="caption">${r.id} · 가상 데이터</div>`, period: r.period, scope: r.scope, format: 'PDF', status: badge(r.status === 'completed' ? '완료' : '생성 대기', r.status === 'completed' ? 'success' : 'warning'), actions: r.status === 'completed' ? actionButton('PDF 미리보기', `preview:${r.id}`, { icon: 'file' }) + actionButton('다시 생성', `regenerate:${r.id}`, { variant: 'ghost' }) : actionButton('데모 완료', `complete:${r.id}`) }));
  return head('ENERGY INTELLIGENCE', '보고서', '선택한 기간의 운영 결과를 보고서로 정리하세요.', actionButton('보고서 생성', 'report-create', { icon: 'plus', variant: 'primary' })) + `<div class="toolbar"><label class="insights-search">${icon('search', 18)}<input class="input" data-insights-input="query" placeholder="보고서 검색" value="${esc(state.query)}"></label>${filterPopover('조회 조건', field('상태', select('reportStatus', [['all', '모든 상태'], ['completed', '완료'], ['queued', '생성 대기']], state.reportStatus)) + field('시작일', input('reportStart', state.reportStart, 'date')) + field('종료일', input('reportEnd', state.reportEnd, 'date')) + field('범위', select('scope', [['all', '전체 층'], ...state.floors.map(f => [f.id, f.id])], state.scope)))}${actionButton('별도 CSV 내보내기', 'csv', { icon: 'download' })}</div>${dataGrid({ id: 'insights-reports', columns: [{ key: 'name', label: '보고서' }, { key: 'period', label: '집계 기간' }, { key: 'scope', label: '대상' }, { key: 'format', label: '형식' }, { key: 'status', label: '상태' }, { key: 'actions', label: '작업' }], rows })}<p class="caption insights-method">PDF 미리보기는 디자인 확인용 샘플입니다. 서버 생성과 실제 PDF 다운로드는 연결되지 않았습니다. CSV는 별도의 가상 원본 데이터입니다.</p>`;
}

const settingsCards = [
  ['site', 'building', '현장 관리', () => `${state.floors.length}개 층`],
  ['users', 'users', '사용자 관리', () => `${state.users.length}명`],
  ['registration', 'lightbulb', '조명 등록', () => state.registration === 2 ? '등록 완료' : '등록 대기'],
  ['maps', 'map', '도면 관리', () => `도면 ${state.floors.length}개`],
  ['security', 'shield', '계정 및 보안', () => state.mfa ? 'MFA 활성' : 'MFA 꺼짐'],
];
function renderSettings() {
  return settingsHead('settings', '설정', '') + `<div class="insights-settings-cards">${settingsCards.map(([route, glyph, title, meta]) => `<button class="card insights-setting-card" data-insights-route="${route}"><span class="insights-setting-icon">${icon(glyph, 24)}</span><span><strong>${title}</strong><span class="caption">${esc(meta())}</span></span></button>`).join('')}</div>`;
}
function renderSite() {
  return settingsHead('site', '현장 관리', '현장 기본 정보와 층 구성을 관리하세요.', actionButton('현장 정보 수정', 'site-edit', { variant: 'primary', icon: 'edit' })) + `<div class="grid-2">${panel('현장 기본 정보', `<dl class="insights-dl"><div><dt>현장 이름</dt><dd>${esc(state.siteName)}</dd></div><div><dt>주소</dt><dd>${esc(state.address)}</dd></div><div><dt>운영 시간</dt><dd>매일 · 24시간</dd></div><div><dt>게이트웨이</dt><dd>GW-01 ${badge('가상 연결', 'success')}</dd></div></dl>`)}${panel('현장 구성', `<div class="kpis">${kpi('관리 층', state.floors.length, { unit: '개' })}${kpi('등록 조명', store.lights.length, { unit: '개' })}</div><p class="muted">공간 구조에 맞게 층과 도면을 추가하고 조명을 배치하세요.</p>`)}</div>${panel('층 목록', dataGrid({ columns: [{ key: 'name', label: '층 이름' }, { key: 'area', label: '면적' }, { key: 'actions', label: '작업' }], rows: state.floors.map(f => ({ name: `${esc(f.id)} · ${esc(f.name)}`, area: `${esc(f.area)} m²`, actions: actionButton('수정', `floor-edit:${f.id}`, { variant: 'ghost' }) + actionButton('삭제', `floor-delete:${f.id}`, { variant: 'ghost' }) })) }), actionButton('층 추가', 'floor-add', { icon: 'plus' }))}`;
}
function renderUsers() {
  const rows = [...state.users].sort((a, b) => a[state.userSort].localeCompare(b[state.userSort])).map(u => ({ name: `<strong>${esc(u.name)}</strong>`, email: esc(u.email), role: badge(u.role, 'neutral'), status: badge(u.status, 'success'), actions: actionButton('수정', `user-edit:${u.id}`, { disabled: state.readOnly, variant: 'ghost' }) + actionButton('삭제', `user-delete:${u.id}`, { disabled: state.readOnly, variant: 'ghost' }) }));
  return settingsHead('users', '사용자 관리', '관리자는 설정을 변경하고 조회자는 현황만 확인합니다.', actionButton('사용자 추가', 'user-add', { icon: 'plus', variant: 'primary', disabled: state.readOnly })) + `<div class="toolbar">${actionButton(state.readOnly ? '조회자 화면 · 관리자 전환' : '관리자 화면 · 조회자 전환', 'readonly', { icon: 'shield' })}${select('userSort', [['name', '이름순'], ['email', '이메일순'], ['role', '역할순']], state.userSort)}<span class="caption">권한은 목업 화면에서만 적용됩니다.</span></div>${dataGrid({ columns: [{ key: 'name', label: '이름' }, { key: 'email', label: '이메일' }, { key: 'role', label: '역할' }, { key: 'status', label: '상태' }, { key: 'actions', label: '작업' }], rows })}`;
}

function steps(labels, current) { return `<ol class="insights-steps">${labels.map((label, i) => `<li class="${i === current ? 'is-active' : i < current ? 'is-done' : ''}"><span>${i < current ? '✓' : i + 1}</span>${label}</li>`).join('')}</ol>`; }
function renderRegistration() {
  const stages = ['게이트웨이', '조명 검색', '등록 완료'];
  let content;
  if (state.registration === 0) content = `<div class="insights-gateway">${icon('wifi', 38)}<h2>게이트웨이를 연결하세요</h2><p class="muted">등록 코드 DEMO-ATLAS를 사용해 가상 게이트웨이 연결 흐름을 확인합니다.</p>${field('게이트웨이 등록 코드', input('claim', 'DEMO-ATLAS'))}${actionButton('가상 게이트웨이 연결', 'claim', { variant: 'primary' })}</div>`;
  else if (state.registration === 1) content = `<div class="row"><h2 class="section-title">검색된 조명 · 3개</h2>${actionButton('다시 검색', 'scan', { icon: 'refresh' })}</div><p class="muted">신호 강도와 기기 이름을 확인한 뒤 등록할 조명을 선택하세요.</p><div class="insights-device-list">${['NODE-028', 'NODE-029', 'NODE-030'].map((id, i) => `<label class="insights-device"><input type="checkbox" data-insights-device="${id}" ${state.selectedDevices.includes(id) ? 'checked' : ''}>${icon('lightbulb', 22)}<span><strong>${id}</strong><span class="caption">정격 40W · 신호 ${-48 - i * 8} dBm · 가상 기기</span></span>${badge('미등록', 'neutral')}</label>`).join('')}</div>${field('등록할 층', select('registrationFloor', state.floors.map(f => [f.id, f.id]), store.floor))}${actionButton(`${state.selectedDevices.length}개 조명 등록`, 'register', { variant: 'primary' })}`;
  else content = `<div class="insights-gateway">${icon('check', 40)}<h2>가상 조명 등록 완료</h2><p class="muted">${state.selectedDevices.length}개의 조명이 데모 목록에 추가되었습니다. 도면에 배치해 보세요.</p>${routeButton('도면에서 배치', 'editor', { variant: 'primary' })}${actionButton('추가 조명 검색', 'registration-reset')}</div>`;
  return settingsHead('registration', '조명 등록', '게이트웨이를 연결하고 새로운 조명을 등록하세요.') + steps(stages, state.registration) + panel('신규 조명 등록', content) + `<p class="caption insights-method">가상 검색·등록 흐름입니다. 인증서 발급, BLE 검색, 실제 장비 프로비저닝은 수행하지 않습니다.</p>`;
}
function renderMaps() {
  return settingsHead('maps', '도면 관리', '각 층의 공간 구조와 조명 위치를 관리하세요.', routeButton('도면 편집', 'editor', { icon: 'edit', variant: 'primary' })) + `<div class="grid-2">${state.floors.map((f, i) => `<section class="panel insights-map-card"><div class="insights-map-preview"><div class="insights-mini-room"></div><div class="insights-mini-room"></div>${Array.from({ length: 18 }, (_, n) => `<i style="left:${12 + n % 6 * 14}%;top:${20 + Math.floor(n / 6) * 25}%"></i>`).join('')}</div><div class="row"><div><h2>${esc(f.id)} · ${esc(f.name)}</h2><p class="caption">버전 ${i ? 'v2' : 'v3'} · 2026.10.06 저장</p></div>${badge('사용 중', 'success')}</div><div class="row">${routeButton('편집', 'editor', { variant: 'primary', attrs: `data-insights-floor="${esc(f.id)}"` })}${actionButton('버전 이력', `versions:${f.id}`, { icon: 'history' })}</div></section>`).join('')}</div>`;
}
function renderSecurity() {
  const sessions = `<div class="row"><div><strong>이 브라우저 · 디자인 검토</strong><p class="caption">서울 · 현재 세션 · 가상 기록</p></div>${badge('현재', 'success')}</div><hr class="insights-rule"><div class="row"><div><strong>모바일 · 예시 세션</strong><p class="caption">${state.mobileSession ? '2026.10.06 09:12 · 가상 기록' : '가상 세션 종료됨'}</p></div>${state.mobileSession ? actionButton('세션 종료', 'session-revoke') : badge('종료', 'neutral')}</div>`;
  return settingsHead('security', '계정 및 보안', '계정 보호와 접속 환경을 관리하세요.') + `<div class="grid-2">${panel('비밀번호', `<p class="muted">새 비밀번호 입력과 검증 흐름을 확인하세요. 실제 비밀번호는 변경되지 않습니다.</p>${actionButton('비밀번호 변경', 'password', { icon: 'key' })}`)}${panel('2단계 인증', `<div class="row"><div><h3>인증 코드로 계정 보호</h3><p class="muted">현재 ${state.mfa ? '데모 활성화' : '비활성'}</p></div>${badge(state.mfa ? '활성' : '꺼짐', state.mfa ? 'success' : 'neutral')}</div>${actionButton(state.mfa ? 'MFA 데모 해제' : 'MFA 데모 설정', 'mfa', { variant: 'primary' })}`)}</div>${panel('접속 세션', sessions)}${panel('로그아웃', `<div class="row"><p class="muted">목업의 로그인 화면으로 이동합니다.</p>${actionButton('로그아웃', 'logout', { icon: 'logout' })}`)}`;
}

function renderEditor() {
  return head('FLOOR PLAN EDITOR', `${esc(store.floor)} 도면 편집`, '조명을 선택하고 위치를 조정하세요. 변경 내용은 이 목업에서만 유지됩니다.', actionButton('도면으로 돌아가기', 'editor-leave') + actionButton('저장', 'editor-save', { icon: 'save', variant: 'primary' })) + `<div class="toolbar">${[['select', '선택'], ['move', '이동'], ['area', '영역']].map(([id, name]) => actionButton(name, `tool:${id}`, { variant: store.tool === id ? 'primary' : 'ghost', icon: id === 'move' ? 'move' : 'cursor' })).join('')}${actionButton('실행 취소', 'undo', { disabled: !state.editorHistory.length, icon: 'undo' })}${actionButton('다시 실행', 'redo', { disabled: !state.editorFuture.length, icon: 'redo' })}<label class="btn btn-secondary insights-file-label">${icon('upload', 18)} CAD 파일 선택<input type="file" accept=".dwg,.dxf" data-insights-cad hidden></label>${badge(state.dirty ? '저장 전 변경 있음' : '저장됨', state.dirty ? 'warning' : 'success')}</div><div class="operation-layout"><section class="panel">${mapWorkspace({ interactive: true, editable: true })}</section><aside class="panel inspector"><h2 class="section-title">조명 배치</h2><p class="muted">도면에서 조명을 선택하세요. 영역 도구는 예시 선택을 제공합니다.</p><p><strong>${store.selected.length}개 선택됨</strong></p>${actionButton('선택 조명 이동', 'place', { variant: 'primary', disabled: !store.selected.length })}${actionButton('배치 해제', 'unplace', { disabled: !store.selected.length })}<hr class="insights-rule"><h3>미배치 조명</h3>${store.lights.filter(l => l.unplaced).map(l => actionButton(`${l.name} 배치`, `fixture:${l.id}`, { icon: 'plus' })).join('') || '<p class="caption">모든 조명이 배치되어 있습니다.</p>'}<p class="caption">CAD는 파일명만 표시합니다. 업로드와 파일 해석은 하지 않습니다.</p></aside></div>`;
}
function renderLogin() {
  return `<div class="insights-auth"><div class="insights-auth-story"><div class="insights-auth-brand">ATLAS<span>LIGHTING WORKSPACE</span></div><h1>공간의 빛을,<br>운영의 인사이트로.</h1><p>조명 상태부터 에너지 사용량까지.<br>현장 운영을 하나의 워크스페이스에서.</p><div class="insights-auth-line"></div><span class="caption">클릭형 디자인 목업 · 가상 로그인</span></div><section class="panel insights-auth-form"><span class="insights-eyebrow caption">WELCOME TO ATLAS</span><h2>${state.loginStep ? '2단계 인증' : '워크스페이스 로그인'}</h2><p class="muted">실제 계정 정보를 입력하지 마세요.</p><form data-insights-form="login">${state.loginStep ? field('인증 코드', input('code', '', 'text', 'placeholder="6자리 코드 · 123456" inputmode="numeric" required')) : field('이메일', input('email', '', 'email', 'placeholder="demo@atlas.example" required')) + field('비밀번호', input('password', '', 'password', 'placeholder="가상 비밀번호 · 8자 이상" minlength="8" required'))}<button class="btn btn-primary" type="submit">${state.loginStep ? '인증 확인' : '로그인'}</button></form>${actionButton('데모 계정으로 둘러보기', 'demo-login', { icon: 'arrow-right' })}${routeButton('초기 현장 설정 보기', 'setup', { variant: 'ghost' })}${routeButton('운영자 예시', 'operator', { variant: 'ghost' })}<p class="caption">인증 API와 연결되지 않은 화면 검토용 흐름입니다.</p></section></div>`;
}
function renderSetup() {
  const labels = ['현장 정보', '층 구성', '게이트웨이', '조명 등록'];
  const contents = [field('현장 이름', input('setupSite', state.siteName, 'text', 'required')) + field('주소', input('setupAddress', state.address)), field('첫 번째 층 이름', input('setupFloor', '지하 1층', 'text', 'required')) + '<p class="muted">층은 초기 설정 후에도 추가할 수 있습니다.</p>', field('게이트웨이 등록 코드', input('setupClaim', 'DEMO-ATLAS', 'text', 'required')) + '<p class="muted">예시 코드로 연결 상태를 확인합니다.</p>', '<div class="insights-gateway">' + icon('lightbulb', 40) + '<h3>3개의 가상 조명을 발견했습니다</h3><p class="muted">초기 설정을 완료하면 모니터링 화면에서 조명을 확인할 수 있습니다.</p></div>'];
  return `<div class="insights-setup">${head('GETTING STARTED', '현장 설정을 시작하세요', '처음 한 번의 설정으로 워크스페이스를 준비합니다.')}${steps(labels, state.wizard)}${panel(labels[state.wizard], `<form data-insights-form="setup">${contents[state.wizard]}<div class="row insights-form-actions">${state.wizard ? actionButton('이전', 'setup-back') : routeButton('로그인으로', 'login')}<button class="btn btn-primary" type="submit">${state.wizard === 3 ? '설정 완료 · 모니터링으로' : '다음 단계'}</button></div></form>`)}<p class="caption">설정값과 연결 결과는 가상 데이터입니다. 실제 현장과 장비를 생성하지 않습니다.</p></div>`;
}
function renderOperator() {
  return head('OPERATOR CONSOLE · EXAMPLE', '고객 관리자', '제조사 운영자용 별도 화면 예시입니다.', routeButton('고객 워크스페이스', 'monitoring') + actionButton('고객 관리자 추가', 'customer-add', { variant: 'primary', icon: 'plus' })) + `<div class="kpis">${kpi('등록 현장', state.customers.length, { unit: '개' })}${kpi('관리자 계정', state.customers.length, { unit: '명' })}${kpi('계정 상태', '정상', { tone: 'success' })}</div>${dataGrid({ columns: [{ key: 'name', label: '현장' }, { key: 'email', label: '관리자 이메일' }, { key: 'status', label: '상태' }, { key: 'actions', label: '작업' }], rows: state.customers.map(c => ({ name: esc(c.name), email: esc(c.email), status: badge(c.status, 'success'), actions: actionButton('수정', `customer-edit:${c.id}`) + actionButton('삭제', `customer-delete:${c.id}`, { variant: 'ghost' }) })) })}<p class="caption insights-method">고객 계정 발급이나 초대 메일은 전송하지 않는 별도 UI 예시입니다.</p>`;
}

const pages = { overview: renderOverview, analysis: renderAnalysis, reports: renderReports, settings: renderSettings, site: renderSite, users: renderUsers, registration: renderRegistration, maps: renderMaps, security: renderSecurity, editor: renderEditor, login: renderLogin, setup: renderSetup, operator: renderOperator };
export function renderInsights(route) {
  const content = pages[route]?.() || '';
  return ['overview', 'analysis', 'reports'].includes(route) ? statisticsTabs(route) + content : content;
}

function formError(message, dialog) {
  const target = dialog?.querySelector('[data-insights-error]');
  if (target) target.textContent = message;
  else toast(message, 'warning');
}
const errorSlot = '<p class="insights-error" role="alert" data-insights-error></p>';
function editDialog(title, content, save, submitLabel = '저장') {
  openDialog({ title, content: content + errorSlot, submitLabel, onSubmit: (data, dialog) => { const error = save(Object.fromEntries(data.entries())); if (error) return formError(error, dialog); closeDialog(); toast('가상 데이터에 반영했습니다.'); } });
}
function confirmDialog(title, text, onConfirm) {
  openDialog({ title, content: `<p>${text}</p><p class="caption">이 목업의 가상 데이터만 변경합니다.</p>`, submitLabel: '확인', onSubmit: () => { onConfirm(); closeDialog(); } });
}
function snapshotEditor() { state.editorHistory.push(JSON.stringify(store.lights)); state.editorFuture = []; state.dirty = true; }
function reportDialog(ctx) {
  editDialog('보고서 생성', field('보고서 이름', input('name', '10월 운영 보고서', 'text', 'required')) + field('시작일', input('start', state.reportStart, 'date', 'required')) + field('종료일', input('end', state.reportEnd, 'date', 'required')) + field('대상 범위', select('scope', [['all', '전체 층'], ...state.floors.map(f => [f.id, f.id])], state.scope)) + '<p class="caption">PDF 형식 · 완료 후 디자인 샘플 미리보기 제공</p>', data => {
    const error = validateReport(data); if (error) return error;
    if (!data.name.trim()) return '보고서 이름을 입력해 주세요.';
    state.reports.unshift({ id: `R-${Date.now()}`, name: data.name.trim(), period: `${data.start} – ${data.end}`, scope: data.scope === 'all' ? '전체 층' : data.scope, status: 'queued' }); ctx.render(); return '';
  }, '생성 요청');
}
function userDialog(id, ctx, customer = false) {
  const list = customer ? state.customers : state.users, current = list.find(u => String(u.id) === id) || { name: '', email: '', role: '조회자' };
  editDialog(customer ? '고객 관리자 정보' : id ? '사용자 수정' : '사용자 추가', field(customer ? '현장 이름' : '이름', input('name', current.name, 'text', 'required')) + field('이메일', input('email', current.email, 'email', 'required')) + (customer ? '' : field('역할', select('role', [['조회자', '조회자'], ['관리자', '관리자']], current.role))), data => {
    if (!customer && state.readOnly) return '조회자에게는 수정 권한이 없습니다.';
    const error = validateUser(data); if (error) return error;
    if (list.some(u => u.email === data.email && u !== current)) return '이미 등록된 이메일입니다.';
    if (id) Object.assign(current, data); else list.push({ id: Date.now(), ...data, status: '활성' }); ctx.render(); return '';
  });
}

export function bindInsights(root, ctx) {
  root.addEventListener('click', event => {
    const route = event.target.closest('[data-insights-route]');
    if (route) { if (route.dataset.insightsFloor) { store.floor = route.dataset.insightsFloor; store.selected = []; } if (state.dirty && root.querySelector('[data-insights-cad]')) confirmDialog('편집을 나갈까요?', '저장 전 변경 내용이 있습니다.', () => { state.dirty = false; ctx.navigate(route.dataset.insightsRoute); }); else ctx.navigate(route.dataset.insightsRoute); return; }
    const control = event.target.closest('[data-action^="insights:"]'); if (!control || control.disabled) return;
    const [action, arg] = control.dataset.action.slice(9).split(':');
    switch (action) {
      case 'period': state.period = arg; ctx.render(); break;
      case 'unit': state.analysisUnit = arg; state.rank = 0; ctx.render(); break;
      case 'rank': state.rank = Number(arg); ctx.render(); break;
      case 'report-create': reportDialog(ctx); break;
      case 'complete': state.reports.find(r => r.id === arg).status = 'completed'; toast('데모 보고서 생성이 완료되었습니다.'); ctx.render(); break;
      case 'regenerate': state.reports.find(r => r.id === arg).status = 'queued'; ctx.render(); toast('가상 생성 대기 상태로 변경했습니다.'); break;
      case 'preview': { const report = state.reports.find(r => r.id === arg); openDialog({ title: 'PDF 보고서 · 디자인 샘플', content: `<div class="insights-report-preview"><span class="caption">ATLAS / SAMPLE ONLY</span><h2>${esc(report.name)}</h2><p>${esc(report.period)} · ${esc(report.scope)}</p><hr class="insights-rule"><h3>가상 운영 요약</h3><div class="kpis">${kpi('추정 전력량', '762.8', { unit: 'kWh' })}${kpi('예상 절감률', '31.8', { unit: '%' })}</div><p class="muted">정격전력과 상태 기반 추정 · 수집 공백 제외. 실제 PDF 파일이 아닌 미리보기 샘플입니다.</p></div>`, submitLabel: '확인', onSubmit: closeDialog }); break; }
      case 'csv': downloadText('ATLAS-가상데이터.csv', '\uFEFF구분,추정전력량(kWh),예상비용(원),비고\nB1,84.2,12630,가상 데이터·공백 제외\nB2,61.5,9225,가상 데이터·공백 제외\n', 'text/csv;charset=utf-8'); toast('가상 원본 CSV를 내보냈습니다.'); break;
      case 'theme': store.theme = store.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = store.theme; ctx.render(); break;
      case 'site-edit': editDialog('현장 정보 수정', field('현장 이름', input('name', state.siteName, 'text', 'required')) + field('주소', input('address', state.address)), data => { if (!data.name.trim()) return '현장 이름을 입력해 주세요.'; state.siteName = data.name; store.site = data.name; state.address = data.address; ctx.render(); return ''; }); break;
      case 'floor-add': case 'floor-edit': { const current = state.floors.find(f => f.id === arg) || { id: '', name: '', area: '' }; editDialog(action === 'floor-add' ? '층 추가' : '층 수정', field('층 코드', input('id', current.id, 'text', 'placeholder="B3" required')) + field('층 이름', input('name', current.name, 'text', 'required')) + field('면적 (m²)', input('area', current.area.replaceAll(',', ''), 'number', 'min="1" required')), data => { if (!data.id.trim() || !data.name.trim() || Number(data.area) <= 0) return '층 코드, 이름과 양수 면적을 입력해 주세요.'; if (state.floors.some(f => f.id === data.id && f !== current)) return '이미 존재하는 층 코드입니다.'; if (arg) Object.assign(current, data); else state.floors.push(data); ctx.render(); return ''; }); break; }
      case 'floor-delete': confirmDialog('층을 삭제할까요?', `${esc(arg)}의 가상 층 정보를 삭제합니다.`, () => { state.floors = state.floors.filter(f => f.id !== arg); ctx.render(); toast('가상 층을 삭제했습니다.'); }); break;
      case 'readonly': state.readOnly = !state.readOnly; ctx.render(); break;
      case 'user-add': userDialog(null, ctx); break;
      case 'user-edit': userDialog(arg, ctx); break;
      case 'user-delete': if (state.readOnly) break; confirmDialog('사용자를 삭제할까요?', '선택한 사용자가 목록에서 제거됩니다.', () => { state.users = state.users.filter(u => String(u.id) !== arg); ctx.render(); toast('가상 사용자를 삭제했습니다.'); }); break;
      case 'claim': { const value = root.querySelector('[name="claim"]').value.trim(); if (value !== 'DEMO-ATLAS') return toast('데모 코드 DEMO-ATLAS를 입력해 주세요.', 'warning'); state.registration = 1; ctx.render(); toast('가상 게이트웨이를 연결했습니다.'); break; }
      case 'scan': toast('가상 조명 3개를 다시 검색했습니다.'); break;
      case 'register': if (!state.selectedDevices.length) return toast('등록할 조명을 선택해 주세요.', 'warning'); state.selectedDevices.forEach((id, i) => { if (!store.lights.some(l => l.id === id)) store.lights.push({ id, name: id, floor: store.floor, status: 'normal', brightness: 70, watt: 40, group: '미배치', x: 200 + i * 100, y: 300, lastSeen: '방금 · 가상', unplaced: true }); }); state.registration = 2; ctx.render(); break;
      case 'registration-reset': state.registration = 1; ctx.render(); break;
      case 'versions': openDialog({ title: `${arg} 도면 버전 이력`, content: '<div class="insights-version"><strong>v3 · 현재 버전</strong><p class="caption">2026.10.06 11:20 · 김지훈 · 조명 2개 위치 수정</p></div><div class="insights-version"><strong>v2 · 이전 버전</strong><p class="caption">2026.10.02 09:40 · 김지훈 · 통로 추가</p></div><p class="muted">버전 이력은 디자인 검토용 예시입니다.</p>', submitLabel: '예시 버전 복원', onSubmit: () => { closeDialog(); toast('가상 이전 버전을 복원했습니다.'); } }); break;
      case 'password': editDialog('비밀번호 변경 · 데모', '<p class="caption">실제 비밀번호를 입력하지 마세요.</p>' + field('가상 현재 비밀번호', input('current', '', 'password', 'required minlength="8"')) + field('가상 새 비밀번호', input('next', '', 'password', 'required minlength="8"')) + field('새 비밀번호 확인', input('confirm', '', 'password', 'required minlength="8"')), data => data.next.length < 8 ? '8자 이상 입력해 주세요.' : data.next !== data.confirm ? '비밀번호 확인이 일치하지 않습니다.' : ''); break;
      case 'mfa': if (state.mfa) confirmDialog('MFA 데모를 해제할까요?', '가상 2단계 인증 표시를 해제합니다.', () => { state.mfa = false; ctx.render(); }); else editDialog('2단계 인증 설정 · 데모', '<p class="muted">데모 인증 코드 <strong>123456</strong>을 입력하세요.</p>' + field('인증 코드', input('code', '', 'text', 'required inputmode="numeric"')), data => { if (data.code !== '123456') return '데모 코드 123456을 입력해 주세요.'; state.mfa = true; ctx.render(); return ''; }, '활성화'); break;
      case 'session-revoke': confirmDialog('예시 세션을 종료할까요?', '모바일 가상 세션 종료 흐름을 확인합니다.', () => { state.mobileSession = false; ctx.render(); toast('가상 모바일 세션이 종료되었습니다.'); }); break;
      case 'logout': confirmDialog('로그아웃할까요?', '가상 로그인 화면으로 이동합니다.', () => { state.loginStep = 0; ctx.navigate('login'); }); break;
      case 'editor-save': state.dirty = false; ctx.render(); toast('도면 변경을 목업에 저장했습니다.'); break;
      case 'editor-leave': if (state.dirty) confirmDialog('편집을 나갈까요?', '저장 전 변경 내용이 있습니다.', () => { state.dirty = false; ctx.navigate('maps'); }); else ctx.navigate('maps'); break;
      case 'tool': store.tool = arg; if (arg === 'area') store.selected = store.lights.filter(l => l.floor === store.floor).slice(0, 4).map(l => l.id); ctx.render(); break;
      case 'place': case 'unplace': snapshotEditor(); store.lights.filter(l => store.selected.includes(l.id)).forEach(l => { l.unplaced = action === 'unplace'; if (action === 'place') { l.x = Math.min(945, l.x + 35); l.y = Math.min(565, l.y + 25); } }); ctx.render(); break;
      case 'fixture': snapshotEditor(); { const fixture = store.lights.find(l => l.id === arg); fixture.unplaced = false; fixture.x = 450; fixture.y = 420; store.selected = [arg]; } ctx.render(); break;
      case 'undo': if (state.editorHistory.length) { state.editorFuture.push(JSON.stringify(store.lights)); store.lights = JSON.parse(state.editorHistory.pop()); state.dirty = true; ctx.render(); } break;
      case 'redo': if (state.editorFuture.length) { state.editorHistory.push(JSON.stringify(store.lights)); store.lights = JSON.parse(state.editorFuture.pop()); state.dirty = true; ctx.render(); } break;
      case 'demo-login': state.loginStep = 0; ctx.navigate('monitoring'); toast('데모 워크스페이스에 입장했습니다.'); break;
      case 'setup-back': state.wizard = Math.max(0, state.wizard - 1); ctx.render(); break;
      case 'customer-add': userDialog(null, ctx, true); break;
      case 'customer-edit': userDialog(arg, ctx, true); break;
      case 'customer-delete': confirmDialog('고객 관리자를 삭제할까요?', '가상 고객 관리자 레코드를 삭제합니다.', () => { state.customers = state.customers.filter(c => String(c.id) !== arg); ctx.render(); toast('가상 고객 관리자를 삭제했습니다.'); }); break;
    }
  });
  root.addEventListener('change', event => {
    const target = event.target;
    if (['reportStart', 'reportEnd', 'analysisStart', 'analysisEnd'].includes(target.name)) {
      const key = target.name.replace('analysis', 'report');
      const next = { start: key === 'reportStart' ? target.value : state.reportStart, end: key === 'reportEnd' ? target.value : state.reportEnd, scope: state.scope };
      const error = validateReport(next); if (error) { target.value = state[key]; return toast(error, 'warning'); }
      state[key] = target.value; ctx.render();
    }
    if (target.dataset.insightsSelect) { const name = target.dataset.insightsSelect; if (name === 'registrationFloor') store.floor = target.value; else if (name in state) state[name] = target.value; ctx.render(); }
    if (target.dataset.insightsDevice) { state.selectedDevices = target.checked ? [...new Set([...state.selectedDevices, target.dataset.insightsDevice])] : state.selectedDevices.filter(id => id !== target.dataset.insightsDevice); ctx.render(); }
    if (target.matches('[data-insights-cad]')) toast(target.files[0] ? `${target.files[0].name} · 파일명 미리보기만 제공합니다.` : '파일 선택을 취소했습니다.', 'neutral');
  });
  root.addEventListener('input', event => {
    if (!event.target.dataset.insightsInput) return; state[event.target.dataset.insightsInput] = event.target.value;
    // Preserve typing focus across this plain HTML prototype's full-page render.
    const caret = event.target.selectionStart; ctx.render(); const replacement = document.querySelector('[data-insights-input]'); replacement?.focus(); replacement?.setSelectionRange(caret, caret);
  });
  root.addEventListener('submit', event => {
    const form = event.target.closest('[data-insights-form]'); if (!form) return; event.preventDefault(); const data = Object.fromEntries(new FormData(form).entries());
    if (form.dataset.insightsForm === 'login') { if (state.loginStep) { if (data.code !== '123456') return toast('데모 코드 123456을 입력해 주세요.', 'warning'); state.loginStep = 0; ctx.navigate('monitoring'); } else { if (!data.email || data.password.length < 8) return toast('이메일과 8자 이상 가상 비밀번호를 입력해 주세요.', 'warning'); state.loginStep = 1; ctx.render(); } }
    if (form.dataset.insightsForm === 'setup') { if (state.wizard === 0) { if (!data.setupSite.trim()) return toast('현장 이름을 입력해 주세요.', 'warning'); state.siteName = data.setupSite; } if (state.wizard === 2 && data.setupClaim !== 'DEMO-ATLAS') return toast('데모 코드 DEMO-ATLAS를 사용해 주세요.', 'warning'); if (state.wizard === 3) { state.wizard = 0; ctx.navigate('monitoring'); toast('가상 현장 초기 설정을 완료했습니다.'); } else { state.wizard++; ctx.render(); } }
  });
  if (root.querySelector('[data-insights-cad]')) {
    const before = JSON.stringify(store.lights);
    mountMap(root, { editable: true, onSelectionChange: () => { if (JSON.stringify(store.lights) !== before) { state.editorHistory.push(before); state.editorFuture = []; state.dirty = true; } ctx.render(); } });
  }
}
