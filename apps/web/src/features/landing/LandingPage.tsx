import { KindaLogo } from "../../components/brand/KindaLogo";

export function LandingPage() {
  return <>
    <header>
      <KindaLogo />
      <a href="/login">로그인</a>
    </header>
    <main>
      <h1>조명 운영을 간단하게.</h1>
      <p>현장 상태 확인부터 조명 제어와 운영 기록 검토까지, 킨다로 한곳에서 살펴보세요.</p>
      <a href="#inquiry">상담 문의</a>
      <section id="inquiry" aria-labelledby="inquiry-heading">
        <h2 id="inquiry-heading">상담 문의</h2>
      </section>
    </main>
  </>;
}
