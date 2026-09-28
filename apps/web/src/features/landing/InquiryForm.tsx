import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { ApiError, classifyApiFailure } from "../../api/client";
import { submitLandingInquiry, type LandingInquiryInput } from "../../api/landing-inquiries";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { FeedbackState } from "../../components/ui/FeedbackState";
import { HoneypotField } from "../../components/ui/HoneypotField";
import { NativeInquiryCheckbox, NativeInquiryInput, NativeInquirySelect, NativeInquiryTextArea } from "../../components/ui/fields/NativeInquiryField";
import { Checkbox } from "../../components/ui/fields/Checkbox";
import { SelectBox } from "../../components/ui/fields/SelectBox";
import { TextArea, TextField } from "../../components/ui/fields/TextField";
import type { LandingPlan } from "./field-day/PricingSection";

type Fields = {
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  audience: "facility" | "partner" | null;
  message: string;
  consent: boolean;
  website: string;
};
type FieldName = keyof Pick<Fields, "companyName" | "contactName" | "email" | "phone" | "message" | "consent">;
type FieldErrors = Partial<Record<FieldName, string>>;
type Outcome = { kind: "idle" } | { kind: "error"; title: string; description: string; mailFallback?: boolean } | { kind: "success"; reference: string };

const initialFields: Fields = { companyName: "", contactName: "", email: "", phone: "", audience: null, message: "", consent: false, website: "" };
const audienceItems = [
  { id: "facility", label: "시설 운영 담당자" },
  { id: "partner", label: "시공·유통 파트너" }
] as const;

function validate(fields: Fields, submittedMessage: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!fields.companyName.trim()) errors.companyName = "회사명을 입력해 주세요.";
  else if (fields.companyName.trim().length > 120) errors.companyName = "회사명은 120자 이하로 입력해 주세요.";
  if (!fields.contactName.trim()) errors.contactName = "담당자 이름을 입력해 주세요.";
  else if (fields.contactName.trim().length > 80) errors.contactName = "담당자 이름은 80자 이하로 입력해 주세요.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim()) || fields.email.trim().length > 254) errors.email = "올바른 이메일 주소를 입력해 주세요.";
  if (fields.phone.trim().length > 30) errors.phone = "전화번호는 30자 이하로 입력해 주세요.";
  if (!fields.message.trim()) errors.message = "문의 내용을 입력해 주세요.";
  else if (submittedMessage.length > 2000) errors.message = "문의 내용은 2,000자 이하로 입력해 주세요.";
  if (!fields.consent) errors.consent = "개인정보 수집·이용에 동의해 주세요.";
  return errors;
}

function errorOutcome(error: unknown): Extract<Outcome, { kind: "error" }> {
  if (error instanceof ApiError && error.status === 503) return {
    kind: "error", title: "현재 온라인 상담을 접수할 수 없습니다.",
    description: "잠시 후 다시 시도하거나 이메일로 직접 문의해 주세요.", mailFallback: true
  };
  if (error instanceof ApiError && error.status === 429) return {
    kind: "error", title: "요청이 많습니다.", description: "잠시 후 다시 시도해 주세요."
  };
  const kind = classifyApiFailure(error);
  if (kind === "timeout" || kind === "transport" || kind === "server") return {
    kind: "error", title: "접수 결과를 확인하지 못했습니다.",
    description: "입력 내용은 남아 있습니다. 다시 시도하면 같은 문의로 확인합니다."
  };
  return { kind: "error", title: "문의 내용을 확인해 주세요.", description: "입력 내용은 남아 있습니다. 확인 후 다시 시도해 주세요." };
}

export function InquiryForm({ onPendingChange, presentation = "card", initialMessage = "", selectedPlan = null, submitButtonRef, onSuccess }: { onPendingChange?: (pending: boolean) => void; onSuccess?: () => void; submitButtonRef?: RefObject<HTMLButtonElement>; presentation?: "card" | "dialog" | "concept"; initialMessage?: string; selectedPlan?: LandingPlan | null } = {}) {
  const [fields, setFields] = useState<Fields>(() => ({ ...initialFields, message: initialMessage }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [pending, setPending] = useState(false);
  const requestIdentity = useRef<{ payload: string; key: string } | null>(null);
  const companyRef = useRef<HTMLInputElement>(null);
  const contactRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const consentRef = useRef<HTMLInputElement>(null);

  useEffect(() => { onPendingChange?.(pending); }, [onPendingChange, pending]);
  useEffect(() => {
    // The original native concept disables its successful submit and moves to
    // the remaining close control; the mounted form survives later reopening.
    if (presentation === "concept" && outcome.kind === "success") onSuccess?.();
  }, [outcome, presentation, onSuccess]);

  function update<K extends keyof Fields>(name: K, value: Fields[K]) {
    setFields((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
    setOutcome({ kind: "idle" });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || outcome.kind === "success") return;
    // Keep the selected plan outside editable copy so rewriting the inquiry cannot remove its context.
    const submittedMessage = `${selectedPlan ? `선택한 요금제: ${selectedPlan}\n` : ""}${fields.message.trim()}`;
    const nextErrors = validate(fields, submittedMessage);
    setErrors(nextErrors);
    const firstError = (Object.keys(nextErrors) as FieldName[])[0];
    if (firstError) {
      ({ companyName: companyRef, contactName: contactRef, email: emailRef, phone: phoneRef, message: messageRef, consent: consentRef })[firstError].current?.focus();
      return;
    }
    if (fields.website) return;
    const payload = {
      companyName: fields.companyName.trim(), contactName: fields.contactName.trim(), email: fields.email.trim(),
      phone: fields.phone.trim(), audience: fields.audience, message: submittedMessage,
      consent: true as const, consentVersion: "landing-2026-09-v1-90d" as const, website: "" as const
    };
    // The public endpoint caps the whole UTF-8 JSON body at 4 KB, including its UUID field.
    const byteLength = new TextEncoder().encode(JSON.stringify({ idempotencyKey: "00000000-0000-4000-8000-000000000000", ...payload })).length;
    if (byteLength > 4096) {
      setErrors({ message: "문의 내용이 너무 깁니다. 내용을 줄여 주세요." });
      messageRef.current?.focus();
      return;
    }
    const fingerprint = JSON.stringify(payload);
    // A lost response may already have created the inquiry; exact retries must carry the same identity.
    if (requestIdentity.current?.payload !== fingerprint) requestIdentity.current = { payload: fingerprint, key: crypto.randomUUID() };
    const input: LandingInquiryInput = { idempotencyKey: requestIdentity.current.key, ...payload };
    setPending(true);
    setOutcome({ kind: "idle" });
    try {
      const result = await submitLandingInquiry(input);
      requestIdentity.current = null;
      setOutcome({ kind: "success", reference: result.reference });
    } catch (error) {
      setOutcome(errorOutcome(error));
    } finally {
      setPending(false);
    }
  }

  if (presentation === "concept") return <form noValidate onSubmit={handleSubmit} className="grid gap-landing-concept-inquiry-form-gap p-landing-concept-inquiry-form-inset landing-stack:p-5">
    <div className="inquiry-fields grid grid-cols-2 gap-landing-concept-inquiry-fields-gap landing-stack:grid-cols-1">
      <NativeInquiryInput ref={companyRef} label="회사명" name="companyName" autoComplete="organization" maxLength={120} required value={fields.companyName} onChange={event => update("companyName", event.target.value)} errorMessage={errors.companyName} disabled={pending} />
      <NativeInquiryInput ref={contactRef} label="담당자 이름" name="contactName" autoComplete="name" maxLength={80} required value={fields.contactName} onChange={event => update("contactName", event.target.value)} errorMessage={errors.contactName} disabled={pending} />
      <NativeInquiryInput ref={emailRef} label="회신 이메일" name="email" type="email" autoComplete="email" maxLength={254} required value={fields.email} onChange={event => update("email", event.target.value)} errorMessage={errors.email} disabled={pending} />
      <NativeInquiryInput ref={phoneRef} label="전화번호" name="phone" type="tel" autoComplete="tel" maxLength={30} optional value={fields.phone} onChange={event => update("phone", event.target.value)} errorMessage={errors.phone} disabled={pending} />
      <NativeInquirySelect label="고객 유형" name="audience" optional className="col-span-full" value={fields.audience ?? ""} onChange={event => update("audience", event.target.value === "facility" || event.target.value === "partner" ? event.target.value : null)} disabled={pending}><option value="">선택해 주세요</option>{audienceItems.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</NativeInquirySelect>
      <NativeInquiryTextArea ref={messageRef} label="문의 내용" name="message" rows={5} maxLength={2000} required className="col-span-full" value={fields.message} onChange={event => update("message", event.target.value)} errorMessage={errors.message} disabled={pending} />
    </div>
    <HoneypotField value={fields.website} onChange={value => update("website", value)} />
    <div className="inquiry-privacy rounded-landing-concept-inquiry-privacy bg-brand-paper p-landing-concept-inquiry-message-inset text-landing-concept-inquiry-privacy"><strong>개인정보 수집·이용 안내</strong><p className="m-landing-concept-inquiry-message-description-space">상담 접수와 회신을 위해 회사명, 담당자 이름, 회신 이메일, 문의 내용을 수집합니다. 전화번호와 고객 유형은 선택 항목입니다. 문의 내용은 접수 후 90일간 보관합니다. 메일 사본은 NAVER WORKS의 보유 정책을 따릅니다. 동의를 거부할 수 있으나 온라인 문의 접수가 제한됩니다.</p></div>
    <NativeInquiryCheckbox ref={consentRef} label="개인정보 수집·이용에 동의합니다" name="consent" checked={fields.consent} onChange={event => update("consent", event.target.checked)} required errorMessage={errors.consent} disabled={pending} />
    {outcome.kind !== "idle" && <div role="alert" className={`inquiry-feedback rounded-control border p-landing-concept-inquiry-message-inset text-landing-concept-inquiry-feedback ${outcome.kind === "error" ? "border-status-inquiry-danger-border bg-status-inquiry-danger-background" : "border-status-success-border bg-status-success-background"}`}><strong>{outcome.kind === "success" ? "상담 문의가 접수되었습니다." : outcome.title}</strong><p className="m-landing-concept-inquiry-message-description-space">{outcome.kind === "success" ? `접수번호: ${outcome.reference}` : outcome.description}</p>{outcome.kind === "error" && outcome.mailFallback && <a href="mailto:kymkjh2002@dfkorealed.com" className="mt-landing-concept-inquiry-feedback-action-top-space inline-block font-extrabold text-action-primary-hover underline underline-offset-3">이메일로 직접 문의하기</a>}</div>}
    <p className="sr-only" role="status" aria-live="polite">{pending ? "상담 문의를 접수하고 있습니다. 잠시만 기다려 주세요." : ""}</p>
    <Button ref={submitButtonRef} type="submit" variant="landingConceptSubmit" aria-disabled={pending} disabled={outcome.kind === "success"}>{pending ? "접수 중" : "상담 문의 보내기"}</Button>
  </form>;

  const form = <form noValidate onSubmit={handleSubmit} className="grid gap-5 text-content-primary">
      {presentation === "card" && <p className="text-body font-bold">상담 내용을 남겨주세요</p>}
      <div className="grid gap-4 tablet:grid-cols-2">
        <TextField ref={companyRef} label="회사명" value={fields.companyName} onChange={(value) => update("companyName", value)} isRequired isInvalid={!!errors.companyName} errorMessage={errors.companyName} isDisabled={pending} />
        <TextField ref={contactRef} label="담당자 이름" value={fields.contactName} onChange={(value) => update("contactName", value)} isRequired isInvalid={!!errors.contactName} errorMessage={errors.contactName} isDisabled={pending} />
        <TextField ref={emailRef} label="회신 이메일" type="email" value={fields.email} onChange={(value) => update("email", value)} isRequired isInvalid={!!errors.email} errorMessage={errors.email} isDisabled={pending} />
        <TextField ref={phoneRef} label="전화번호" type="tel" value={fields.phone} onChange={(value) => update("phone", value)} isInvalid={!!errors.phone} errorMessage={errors.phone} isDisabled={pending} />
      </div>
      <SelectBox label="고객 유형" placeholder="선택해 주세요" items={audienceItems} selectedKey={fields.audience} onSelectionChange={(value) => update("audience", value)} isDisabled={pending} />
      <TextArea ref={messageRef} label="문의 내용" rows={5} value={fields.message} onChange={(value) => update("message", value)} isRequired isInvalid={!!errors.message} errorMessage={errors.message} isDisabled={pending} />
      <HoneypotField value={fields.website} onChange={(value) => update("website", value)} />
      <div className="rounded-control bg-brand-paper p-4 text-body-sm text-content-primary">
        <p className="font-bold">개인정보 수집·이용 안내</p>
        <p className="mt-2">상담 접수와 회신을 위해 회사명, 담당자 이름, 회신 이메일, 문의 내용을 수집합니다. 전화번호와 고객 유형은 선택 항목입니다. 문의 내용은 접수 후 90일간 보관합니다. 메일 사본은 NAVER WORKS의 보유 정책을 따릅니다. 동의를 거부할 수 있으나 온라인 문의 접수가 제한됩니다.</p>
      </div>
      <Checkbox ref={consentRef} label="개인정보 수집·이용에 동의합니다" isSelected={fields.consent} onChange={(value) => update("consent", value)} isRequired isInvalid={!!errors.consent} errorMessage={errors.consent} isDisabled={pending} />
      {outcome.kind === "error" && <FeedbackState tone="danger" icon={AlertCircle} title={outcome.title} description={outcome.description} action={outcome.mailFallback ? <a className="text-action-primary underline underline-offset-4" href="mailto:kymkjh2002@dfkorealed.com">이메일로 직접 문의하기</a> : undefined} />}
      {outcome.kind === "success" && <FeedbackState tone="success" icon={CheckCircle2} title="상담 문의가 접수되었습니다." description={`접수번호: ${outcome.reference}`} />}
      <p className="sr-only" role="status" aria-live="polite">{pending ? "상담 문의를 접수하고 있습니다. 잠시만 기다려 주세요." : ""}</p>
      {/* Keep one tab stop inside the modal while its fields and close control are unavailable. */}
      <Button type="submit" variant="primary" size="lg" aria-busy={pending} aria-disabled={pending || outcome.kind === "success"}>{pending ? "접수 중" : "상담 문의 보내기"}</Button>
    </form>;
  return presentation === "dialog" ? form : <Card className="p-5 text-content-primary compact:p-7">{form}</Card>;
}
