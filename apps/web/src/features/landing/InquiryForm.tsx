import { useRef, useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { ApiError, classifyApiFailure } from "../../api/client";
import { submitLandingInquiry, type LandingInquiryInput } from "../../api/landing-inquiries";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { FeedbackState } from "../../components/ui/FeedbackState";
import { HoneypotField } from "../../components/ui/HoneypotField";
import { Checkbox } from "../../components/ui/fields/Checkbox";
import { SelectBox } from "../../components/ui/fields/SelectBox";
import { TextArea, TextField } from "../../components/ui/fields/TextField";

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

function validate(fields: Fields): FieldErrors {
  const errors: FieldErrors = {};
  if (!fields.companyName.trim()) errors.companyName = "회사명을 입력해 주세요.";
  else if (fields.companyName.trim().length > 120) errors.companyName = "회사명은 120자 이하로 입력해 주세요.";
  if (!fields.contactName.trim()) errors.contactName = "담당자 이름을 입력해 주세요.";
  else if (fields.contactName.trim().length > 80) errors.contactName = "담당자 이름은 80자 이하로 입력해 주세요.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim()) || fields.email.trim().length > 254) errors.email = "올바른 이메일 주소를 입력해 주세요.";
  if (fields.phone.trim().length > 30) errors.phone = "전화번호는 30자 이하로 입력해 주세요.";
  if (!fields.message.trim()) errors.message = "문의 내용을 입력해 주세요.";
  else if (fields.message.trim().length > 2000) errors.message = "문의 내용은 2,000자 이하로 입력해 주세요.";
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

export function InquiryForm() {
  const [fields, setFields] = useState<Fields>(initialFields);
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

  function update<K extends keyof Fields>(name: K, value: Fields[K]) {
    setFields((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
    setOutcome({ kind: "idle" });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const nextErrors = validate(fields);
    setErrors(nextErrors);
    const firstError = (Object.keys(nextErrors) as FieldName[])[0];
    if (firstError) {
      ({ companyName: companyRef, contactName: contactRef, email: emailRef, phone: phoneRef, message: messageRef, consent: consentRef })[firstError].current?.focus();
      return;
    }
    if (fields.website) return;
    const payload = {
      companyName: fields.companyName.trim(), contactName: fields.contactName.trim(), email: fields.email.trim(),
      phone: fields.phone.trim(), audience: fields.audience, message: fields.message.trim(),
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

  return <Card className="p-5 text-content-primary compact:p-7">
    <form noValidate onSubmit={handleSubmit} className="grid gap-5">
      <p className="text-body font-bold">상담 내용을 남겨주세요</p>
      <div className="grid gap-4 tablet:grid-cols-2">
        <TextField ref={companyRef} label="회사명" value={fields.companyName} onChange={(value) => update("companyName", value)} isRequired isInvalid={!!errors.companyName} errorMessage={errors.companyName} isDisabled={pending} />
        <TextField ref={contactRef} label="담당자 이름" value={fields.contactName} onChange={(value) => update("contactName", value)} isRequired isInvalid={!!errors.contactName} errorMessage={errors.contactName} isDisabled={pending} />
        <TextField ref={emailRef} label="회신 이메일" type="email" value={fields.email} onChange={(value) => update("email", value)} isRequired isInvalid={!!errors.email} errorMessage={errors.email} isDisabled={pending} />
        <TextField ref={phoneRef} label="전화번호" type="tel" value={fields.phone} onChange={(value) => update("phone", value)} isInvalid={!!errors.phone} errorMessage={errors.phone} isDisabled={pending} />
      </div>
      <SelectBox label="고객 유형" items={audienceItems} selectedKey={fields.audience} onSelectionChange={(value) => update("audience", value)} isDisabled={pending} />
      <TextArea ref={messageRef} label="문의 내용" rows={5} value={fields.message} onChange={(value) => update("message", value)} isRequired isInvalid={!!errors.message} errorMessage={errors.message} isDisabled={pending} />
      <HoneypotField value={fields.website} onChange={(value) => update("website", value)} />
      <div className="rounded-control bg-brand-paper p-4 text-body-sm text-content-primary">
        <p className="font-bold">개인정보 수집·이용 안내</p>
        <p className="mt-2">상담 접수와 회신을 위해 회사명, 담당자 이름, 회신 이메일, 문의 내용을 수집합니다. 전화번호와 고객 유형은 선택 항목입니다. 문의 내용은 접수 후 90일간 보관합니다. 메일 사본은 NAVER WORKS의 보유 정책을 따릅니다. 동의를 거부할 수 있으나 온라인 문의 접수가 제한됩니다.</p>
      </div>
      <Checkbox ref={consentRef} label="개인정보 수집·이용에 동의합니다" isSelected={fields.consent} onChange={(value) => update("consent", value)} isRequired isInvalid={!!errors.consent} errorMessage={errors.consent} isDisabled={pending} />
      {outcome.kind === "error" && <FeedbackState tone="danger" icon={AlertCircle} title={outcome.title} description={outcome.description} action={outcome.mailFallback ? <a className="text-action-primary underline underline-offset-4" href="mailto:kymkjh2002@dfkorealed.com">이메일로 직접 문의하기</a> : undefined} />}
      {outcome.kind === "success" && <FeedbackState tone="success" icon={CheckCircle2} title="상담 문의가 접수되었습니다." description={`접수번호: ${outcome.reference}`} />}
      <Button type="submit" variant="primary" size="lg" disabled={outcome.kind === "success"} isLoading={pending} loadingLabel="접수 중">상담 문의 보내기</Button>
    </form>
  </Card>;
}
