const companyBase = "https://dfkorealed.com";

const links = [
  { label: "회사 소개", href: `${companyBase}/about` },
  { label: "제품 소개", href: `${companyBase}/products` },
  { label: "인증 현황", href: `${companyBase}/certificates` },
  { label: "회사 소식", href: `${companyBase}/blog` }
] as const;

export function CompanyFooter() {
  return <footer className="footer">
    <div className="container footer-main">
      <div className="footer-company"><strong>(주)디에프코리아</strong><p>조명 제품과 현장 운영을 연결합니다.</p><a href={companyBase}>회사 홈페이지 <span aria-hidden="true">↗</span></a></div>
      <div className="footer-contact"><h2>문의 및 위치</h2><dl>
        <div><dt>전화</dt><dd><a href="tel:0325282953">032-528-2953</a></dd></div>
        <div><dt>팩스</dt><dd>032-551-2954</dd></div>
        <div><dt>이메일</dt><dd><a href="mailto:kjukym@dfkorealed.com">kjukym@dfkorealed.com</a></dd></div>
        <div><dt>주소</dt><dd>인천광역시 부평구 평천로 199번길 53 A동 2층</dd></div>
      </dl></div>
      <nav className="footer-links" aria-label="회사 페이지"><h2>디에프코리아</h2>{links.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}</nav>
    </div>
    <div className="container footer-bottom"><span>© {new Date().getFullYear()} DF KOREA. All rights reserved.</span><span>이 페이지의 조명과 수치는 기능 설명을 위한 예시입니다.</span></div>
  </footer>;
}
