import { CheckCircle2, Loader2 } from "lucide-react";
import { Button, NumberField, TextField } from "../../components/ui";

export interface FixtureBatchDefaults {
  namePrefix: string;
  startNumber: number | null;
  digits: string;
  ratedWatt: string;
  size: number | null;
}

interface FixtureBatchFormProps {
  values: FixtureBatchDefaults;
  selectedCount: number;
  disabled: boolean;
  pending: boolean;
  onChange: (values: FixtureBatchDefaults) => void;
  onSubmit: () => void;
}

export function FixtureBatchForm({
  values,
  selectedCount,
  disabled,
  pending,
  onChange,
  onSubmit
}: FixtureBatchFormProps) {
  return (
    <form className="registration-config-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="registration-fields batch-fields">
        <TextField label="이름 접두어" value={values.namePrefix} maxLength={100} onChange={(value) => onChange({ ...values, namePrefix: value })} />
        <NumberField label="시작 번호" value={values.startNumber} minValue={1} step={1} onChange={(value) => onChange({ ...values, startNumber: value })} />
        <TextField label="자릿수" inputMode="numeric" pattern="[1-9]" maxLength={1} value={values.digits} onChange={(value) => onChange({ ...values, digits: value })} />
        <TextField label="정격 전력(W)" inputMode="decimal" value={values.ratedWatt} onChange={(value) => onChange({ ...values, ratedWatt: value })} />
        <NumberField label="조명 크기" value={values.size} minValue={1} maxValue={1000} onChange={(value) => onChange({ ...values, size: value })} />
      </div>
      <RegistrationSubmitButton selectedCount={selectedCount} disabled={disabled} pending={pending} />
    </form>
  );
}

export function RegistrationSubmitButton({
  selectedCount,
  disabled,
  pending
}: {
  selectedCount: number;
  disabled: boolean;
  pending: boolean;
}) {
  return (
    <Button
      className="registration-submit"
      variant="primary"
      type="submit"
      aria-label="선택 조명 등록"
      disabled={disabled}
      isLoading={pending}
      loadingLabel="선택 조명 등록 중"
    >
      <>{pending ? <Loader2 size={16} /> : <CheckCircle2 size={16} />} 선택 조명 등록 <span>{selectedCount}</span></>
    </Button>
  );
}
